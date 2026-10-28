import assert from "node:assert/strict";

import { chromium } from "playwright";
import { expect } from "playwright/test";
import sharp from "sharp";

export async function checkTlsBrowser({ origin, httpOrigin, credentials, signal, phase, resolverAddress = "127.0.0.1", evidence: browserEvidence = {} }) {
  phase("browser-launch");
  assert.equal(process.platform, "linux", "TLS_BROWSER_REQUIRES_LINUX_FIXTURE");
  signal.throwIfAborted();
  let browser;
  const abort = () => { void browser?.close().catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    browser = await chromium.launch({ headless: true, timeout: 20_000, chromiumSandbox: true, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
      args: ["--disable-dev-shm-usage", "--disable-background-networking", "--disable-component-update", "--disable-domain-reliability", "--no-pings", `--host-resolver-rules=MAP rimo.test ${resolverAddress}, EXCLUDE localhost`, "--no-proxy-server"] });
    signal.throwIfAborted();
  } catch (error) {
    signal.removeEventListener("abort", abort);
    await browser?.close().catch(() => undefined);
    const text = String(error.message);
    browserEvidence.launchFailure = { sandboxDenied: /no usable sandbox|failed to move to new namespace|operation not permitted|sandbox.*failed/i.test(text),
      readOnlyOrPermission: /read.only file system|permission denied/i.test(text), missingExecutable: /executable doesn.t exist/i.test(text),
      missingLibraries: /error while loading shared libraries/i.test(text), resourceFailure: /pthread_create|out of memory|resource temporarily unavailable/i.test(text),
      terminated: /target.*closed|browser.*closed|process.*exited/i.test(text) };
    throw error;
  }
  const evidence = Object.assign(browserEvidence, { contexts: 0, browserPlatform: process.platform, chromiumSandbox: process.platform === "linux", chromiumVersion: browser.version(), selfSignedCertificateException: "ignoreHTTPSErrors in test contexts only", pageErrors: 0, mixedContent: 0, insecureSubrequests: 0, wssFrames: 0, wsErrors: 0 });
  const contexts = [];
  let currentPage;
  const watch = (page) => {
    page.on("pageerror", () => { evidence.pageErrors += 1; });
    page.on("console", (message) => { if (/mixed content/i.test(message.text())) evidence.mixedContent += 1; });
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.protocol === "http:" && !(request.isNavigationRequest() && url.origin === httpOrigin && url.pathname === "/api/health")) evidence.insecureSubrequests += 1;
    });
    page.on("websocket", (socket) => {
      if (new URL(socket.url()).protocol !== "wss:") evidence.insecureSubrequests += 1;
      socket.on("framereceived", () => { if (new URL(socket.url()).protocol === "wss:") evidence.wssFrames += 1; });
      socket.on("socketerror", () => { evidence.wsErrors += 1; });
    });
  };
  const context = async () => {
    const value = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true, locale: "ru-RU", viewport: { width: 1440, height: 1000 } });
    value.setDefaultTimeout(15_000);
    value.on("page", watch);
    contexts.push(value);
    evidence.contexts = contexts.length;
    return value;
  };
  const canvas = (page) => page.locator('svg[aria-label="Холст доски"]');
  const saved = (page) => expect(page.getByText("Сохранено", { exact: true })).toBeVisible({ timeout: 25_000 });
  const cookieFlags = async (value) => {
    const cookies = (await value.cookies(origin)).filter((cookie) => /session_token/.test(cookie.name));
    assert.ok(cookies.length > 0, "SESSION_COOKIE_MISSING");
    assert.ok(cookies.every((cookie) => cookie.secure && cookie.httpOnly && cookie.sameSite === "Lax"), "SESSION_COOKIE_FLAGS");
    return cookies.map(({ name, secure, httpOnly, sameSite }) => ({ name, secure, httpOnly, sameSite }));
  };
  try {
    const ownerContext = await context();
    const owner = await ownerContext.newPage();
    currentPage = owner;
    evidence.viewport = owner.viewportSize();
    const cdp = await ownerContext.newCDPSession(owner);
    await cdp.send("Network.enable");
    cdp.on("Network.responseReceived", ({ response }) => {
      if (response.url === origin + "/") evidence.browserTransport = { status: response.status,
        remoteLoopback: ["127.0.0.1", "::1"].includes(response.remoteIPAddress),
        remotePortMatches: response.remotePort === Number(new URL(origin).port), protocol: response.protocol,
        serverIsCaddy: /caddy/i.test(String(response.headers.server ?? response.headers.Server)) };
    });
    phase("owner-login");
    const landing = await owner.goto(origin, { waitUntil: "networkidle", timeout: 30_000 });
    evidence.landingStatus = landing.status();
    evidence.landingHeaderNames = Object.keys(await landing.allHeaders()).filter((name) => !/cookie|authorization/i.test(name)).sort();
    if (landing.status() !== 200) {
      const text = (await owner.locator("body").innerText()).toLowerCase();
      evidence.landingErrorCategory = /permission|policy|denied|blocked|guard|sandbox/.test(text) ? "permission-policy"
        : /upstream|gateway|proxy/.test(text) ? "upstream-proxy" : /cancel|abort/.test(text) ? "cancelled" : "unclassified";
      throw new Error("LANDING_NOT_OK");
    }
    phase("owner-login-dialog");
    await owner.getByRole("button", { name: "Войти", exact: true }).first().click();
    phase("owner-login-fields");
    await owner.getByLabel("Почта", { exact: true }).fill(credentials.email);
    await owner.getByLabel("Пароль", { exact: true }).fill(credentials.password);
    const signedIn = owner.waitForResponse((response) => new URL(response.url()).pathname === "/api/auth/sign-in/email");
    phase("owner-login-submit");
    await owner.getByRole("dialog").getByRole("button", { name: "Войти", exact: true }).click();
    evidence.ownerLoginStatus = (await signedIn).status();
    assert.equal(evidence.ownerLoginStatus, 200, "OWNER_LOGIN_STATUS");
    phase("owner-login-dashboard");
    await expect(owner.getByRole("button", { name: "Создать доску", exact: true }).first()).toBeVisible();
    evidence.ownerCookieFlags = await cookieFlags(ownerContext);
    evidence.ownerSecureContext = await owner.evaluate(() => isSecureContext);
    assert.equal(evidence.ownerSecureContext, true, "OWNER_SECURE_CONTEXT");
    const sessionName = evidence.ownerCookieFlags[0].name;
    evidence.httpOnlyHiddenFromDocument = await owner.evaluate((name) => !document.cookie.includes(name + "="), sessionName);
    assert.equal(evidence.httpOnlyHiddenFromDocument, true, "HTTPONLY_VISIBLE");

    phase("http-cookie-redirect");
    const probe = await ownerContext.newPage();
    const probeUrl = httpOrigin + "/api/health";
    const captures = [];
    let initialStatus;
    let sessionCookieSent;
    probe.on("request", (request) => {
      if (request.url() !== probeUrl || request.redirectedFrom()) return;
      captures.push(request.allHeaders().then((headers) => { sessionCookieSent = (headers.cookie ?? "").includes(sessionName + "="); }));
    });
    probe.on("response", (response) => { if (response.url() === probeUrl) initialStatus = response.status(); });
    await probe.goto(probeUrl, { waitUntil: "networkidle", timeout: 20_000 });
    await Promise.all(captures);
    assert.equal(initialStatus, 308, "INITIAL_HTTP_REDIRECT_STATUS");
    assert.equal(sessionCookieSent, false, "SECURE_COOKIE_SENT_OVER_HTTP");
    assert.equal(new URL(probe.url()).origin, origin, "HTTP_REDIRECT_ORIGIN");
    evidence.initialHttp = { observed: captures.length > 0, status: initialStatus, sessionCookieSent, redirectedToHttps: true };
    await probe.close();

    phase("board-and-invite");
    const created = owner.waitForResponse((response) => new URL(response.url()).pathname === "/api/boards" && response.request().method() === "POST");
    await owner.getByRole("button", { name: "Создать доску", exact: true }).first().click();
    const response = await created;
    assert.equal(response.status(), 201, "CREATE_BOARD_STATUS");
    const boardId = (await response.json()).board.id;
    await owner.waitForURL((url) => url.pathname === `/board/${boardId}`);
    await saved(owner);
    await owner.getByRole("button", { name: "Поделиться", exact: true }).click();
    await owner.getByLabel("Права по приглашению", { exact: true }).selectOption("editor");
    await owner.getByRole("button", { name: "Создать ссылку", exact: true }).click();
    const invite = owner.getByLabel("Ссылка-приглашение", { exact: true });
    await expect(invite).not.toHaveValue("");
    const invitation = await invite.inputValue();
    await owner.keyboard.press("Escape");
    const guestContext = await context();
    const guest = await guestContext.newPage();
    currentPage = guest;
    await guest.goto(invitation, { waitUntil: "networkidle" });
    await guest.getByLabel("Как вас представить", { exact: true }).fill("TLS ученик");
    await guest.getByRole("button", { name: "Войти на доску", exact: true }).click();
    await saved(guest);
    evidence.guestCookieFlags = await cookieFlags(guestContext);
    evidence.guestSecureContext = await guest.evaluate(() => isSecureContext);
    assert.equal(evidence.guestSecureContext, true, "GUEST_SECURE_CONTEXT");
    for (const [page, expectedRole] of [[owner, "owner"], [guest, "editor"]]) {
      const result = await page.evaluate(async (id) => {
        const response = await fetch(`/api/boards/${id}/session`);
        const session = await response.json();
        return { status: response.status, role: session.role, protocol: new URL(session.connection.url).protocol, sameHost: new URL(session.connection.url).host === location.host };
      }, boardId);
      assert.deepEqual(result, { status: 200, role: expectedRole, protocol: "wss:", sameHost: true }, "SESSION_WSS_ROUTE");
    }
    evidence.sessionApiWss = true;
    evidence.anonymousEditor = await guest.evaluate(async () => (await (await fetch("/api/auth/get-session")).json()).user.isAnonymous === true);
    assert.equal(evidence.anonymousEditor, true, "GUEST_NOT_ANONYMOUS");

    phase("two-context-collaboration");
    await owner.getByRole("button", { name: /^Прямоугольник/ }).click();
    await owner.mouse.click(430, 320);
    await expect(canvas(owner).locator("rect.drop-shadow-md")).toHaveCount(1);
    await expect(canvas(guest).locator("rect.drop-shadow-md")).toHaveCount(1);
    await saved(owner);
    await guest.getByRole("button", { name: /^Эллипс/ }).click();
    await guest.mouse.click(700, 460);
    await expect(canvas(owner).locator("ellipse")).toHaveCount(1);
    await expect(canvas(guest).locator("ellipse")).toHaveCount(1);
    await saved(guest);
    await owner.reload({ waitUntil: "networkidle" });
    await guest.reload({ waitUntil: "networkidle" });
    for (const page of [owner, guest]) {
      await saved(page);
      await expect(canvas(page).locator("rect.drop-shadow-md")).toHaveCount(1);
      await expect(canvas(page).locator("ellipse")).toHaveCount(1);
    }
    evidence.sharedShapesSavedAndReloaded = true;

    phase("private-image-https");
    const png = await sharp({ create: { width: 64, height: 32, channels: 4, background: "#7c3aed" } }).png().toBuffer();
    const chooser = owner.waitForEvent("filechooser");
    await owner.getByRole("button", { name: "Изображение", exact: true }).click();
    await (await chooser).setFiles({ name: "tls-test.png", mimeType: "image/png", buffer: png });
    const images = (page) => canvas(page).locator('img[alt^="Превью слоя "]');
    await expect(images(owner)).toHaveCount(1);
    await expect(images(guest)).toHaveCount(1);
    await expect.poll(() => images(owner).evaluateAll((nodes) => nodes.every((image) => image.complete && image.naturalWidth === 64))).toBe(true);
    await saved(owner);
    const asset = await images(owner).first().getAttribute("src");
    const imageAccess = async (page, credentials) => page.evaluate(async ({ asset, credentials }) => {
      const response = await fetch(asset, { credentials });
      return { status: response.status, type: response.headers.get("content-type"), cache: response.headers.get("cache-control"), bytes: (await response.arrayBuffer()).byteLength };
    }, { asset, credentials });
    const ownerImage = await imageAccess(owner, "include");
    const guestImage = await imageAccess(guest, "include");
    const unauthenticatedImage = await imageAccess(owner, "omit");
    assert.equal(ownerImage.status, 200, "OWNER_IMAGE_ACCESS");
    assert.equal(guestImage.status, 200, "GUEST_IMAGE_ACCESS");
    assert.equal(unauthenticatedImage.status, 401, "ANONYMOUS_IMAGE_PRIVACY");
    assert.equal(ownerImage.type, "image/webp", "IMAGE_MIME");
    assert.match(ownerImage.cache, /private.*no-store/, "IMAGE_CACHE");
    assert.equal(ownerImage.bytes, guestImage.bytes, "IMAGE_BYTES");
    evidence.privateImage = { owner: 200, editor: 200, withoutCookie: 401, decoded: true, privateNoStore: true };

    currentPage = owner;
    phase("pdf-dialog-https");
    await owner.getByRole("button", { name: "PDF", exact: true }).click();
    phase("pdf-named-frame-https");
    await owner.getByRole("button", { name: "Добавить фрейм по выделению или координатам", exact: true }).click();
    await owner.getByLabel("Имя нового фрейма", { exact: true }).fill("TLS проверка");
    await owner.getByLabel("Фрейм: X", { exact: true }).fill("0");
    await owner.getByLabel("Фрейм: Y", { exact: true }).fill("0");
    await owner.getByLabel("Фрейм: Ширина", { exact: true }).fill("1200");
    await owner.getByLabel("Фрейм: Высота", { exact: true }).fill("800");
    await owner.getByRole("button", { name: "Добавить фрейм", exact: true }).click();
    await owner.getByLabel("Экспортировать фрейм TLS проверка", { exact: true }).check();
    const prepare = owner.getByRole("button", { name: "Создать предпросмотр", exact: true });
    await expect(prepare).toBeEnabled({ timeout: 25_000 });
    phase("pdf-preview-request-https");
    const prepared = owner.waitForResponse((response) => new URL(response.url()).pathname.endsWith("/pdf/preview") && response.request().method() === "POST");
    const preview = owner.waitForResponse((response) => new URL(response.url()).pathname.includes("/pdf/preview/") && response.request().method() === "GET");
    await prepare.click();
    evidence.pdfPreviewPostStatus = (await prepared).status();
    assert.equal(evidence.pdfPreviewPostStatus, 201, "PDF_PREVIEW_POST");
    evidence.pdfPreviewGetStatus = (await preview).status();
    assert.equal(evidence.pdfPreviewGetStatus, 200, "PDF_PREVIEW_GET");
    phase("pdf-preview-rendered-https");
    const iframe = owner.locator('iframe[title^="Предпросмотр:"]');
    await expect(iframe).toBeVisible();
    const frame = await iframe.elementHandle();
    await expect((await frame.contentFrame()).locator("section[data-page] svg").first()).toBeVisible();
    evidence.pdfPreviewHttps = true;
    assert.ok(evidence.wssFrames > 0, "WSS_FRAMES_MISSING");
    assert.equal(evidence.wsErrors, 0, "WSS_SOCKET_ERROR");
    assert.equal(evidence.pageErrors, 0, "PAGE_ERRORS");
    assert.equal(evidence.mixedContent, 0, "MIXED_CONTENT");
    assert.equal(evidence.insecureSubrequests, 0, "INSECURE_SUBREQUESTS");
    return evidence;
  } catch (error) {
    if (currentPage && !currentPage.isClosed()) {
      const url = new URL(currentPage.url());
      evidence.failedPage = {
        protocol: url.protocol,
        route: url.pathname === "/" ? "home" : url.pathname.startsWith("/board/") ? "board" : url.pathname === "/invite" ? "invite" : "other",
        loginButtons: await currentPage.getByRole("button", { name: "Войти", exact: true }).count().catch(() => -1),
        createBoardButtons: await currentPage.getByRole("button", { name: "Создать доску", exact: true }).count().catch(() => -1),
        dialogs: await currentPage.getByRole("dialog").count().catch(() => -1),
        emailFields: await currentPage.getByLabel("Почта", { exact: true }).count().catch(() => -1),
        passwordFields: await currentPage.getByLabel("Пароль", { exact: true }).count().catch(() => -1),
      };
    }
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
    for (const value of contexts) await value.close().catch(() => undefined);
    await browser.close();
  }
}
