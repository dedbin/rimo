import assert from "node:assert/strict";

/** Exercise the genuine production self-avatar; only this fixture's HTTP session JSON is substituted. */
export async function avatarBrowserCase(browser, { boardId, ownerId, origin, entry, storageState, report }) {
  const context = await browser.newContext({ baseURL: origin, storageState,
    viewport: { width: 1440, height: 1000 }, locale: "ru-RU", serviceWorkers: "block" });
  const observation = { name: entry.name, allowed: entry.allowed, substitutedResponses: 0, localImageRequests: 0, routeFailures: 0 };
  const inFlight = new Set();
  let closing = false;
  try {
    context.on("request", (incoming) => {
      const url = new URL(incoming.url());
      if (["http:", "https:"].includes(url.protocol) && url.origin !== origin) {
        if (report.foreignRequests.length < 40) report.foreignRequests.push({ case: entry.name, origin: url.origin, resourceType: incoming.resourceType() });
      }
      if (url.origin === origin && url.pathname === entry.image) observation.localImageRequests += 1;
    });
    const handleRoute = async (route) => {
      try {
        const incoming = route.request();
        const url = new URL(incoming.url());
        if (["http:", "https:"].includes(url.protocol) && url.origin !== origin) {
          await route.abort("blockedbyclient");
        } else if (url.origin === origin && url.pathname === `/api/boards/${boardId}/session` && incoming.method() === "GET") {
          const response = await route.fetch({ timeout: 15_000 });
          assert.equal(response.status(), 200, "FIXTURE_SESSION_UNAVAILABLE");
          const session = await response.json();
          assert.equal(session.board.id, boardId, "FIXTURE_BOARD_MISMATCH");
          assert.equal(session.user.id, ownerId, "FIXTURE_USER_MISMATCH");
          assert.equal(session.role, "owner", "FIXTURE_OWNER_REQUIRED");
          observation.substitutedResponses += 1;
          await route.fulfill({ response, json: { ...session, user: { ...session.user, name: "Проверка аватаров", image: entry.image } } });
        } else await route.continue();
      } catch {
        if (!closing) {
          observation.routeFailures += 1;
          if (report.routeFailures.length < 20) report.routeFailures.push({ case: entry.name, error: "Browser request routing failed" });
        }
        await route.abort("failed").catch(() => undefined);
      }
    };
    await context.route("**/*", (route) => {
      const task = handleRoute(route);
      inFlight.add(task);
      void task.then(() => inFlight.delete(task));
      return task;
    });
    const page = await context.newPage();
    page.on("pageerror", () => {
      if (report.pageErrors.length < 20) report.pageErrors.push({ case: entry.name, error: "Uncaught browser error" });
    });
    await page.goto(`/board/${boardId}`, { waitUntil: "networkidle", timeout: 30_000 });
    await page.getByText("Сохранено", { exact: true }).waitFor({ timeout: 30_000 });
    assert.ok(observation.substitutedResponses > 0, "FIXTURE_RESPONSE_NOT_CONSUMED");
    const images = page.getByAltText("Проверка аватаров (вы)", { exact: true });
    if (entry.allowed) {
      await images.waitFor({ state: "visible", timeout: 15_000 });
      const image = await images.evaluate(async (node) => {
        await node.decode();
        return { source: node.getAttribute("src"), complete: node.complete, width: node.naturalWidth };
      });
      observation.renderedImages = await images.count();
      observation.decoded = image.source === entry.image && image.complete && image.width > 0 &&
        (entry.expectedWidth === undefined || image.width === entry.expectedWidth);
    } else {
      await page.getByText("П", { exact: true }).waitFor({ state: "visible", timeout: 15_000 });
      // Keep a finite observation window after hydration for delayed image preloaders.
      await page.waitForTimeout(500);
      observation.initialsVisible = await page.getByText("П", { exact: true }).isVisible();
      observation.renderedImages = await images.count();
    }
    return observation;
  } finally {
    // Drain routing before closing, then settle any requests cancelled by context teardown.
    await Promise.allSettled([...inFlight]);
    closing = true;
    try { await context.close(); report.cleanup.push({ step: `close-browser-${entry.name}`, status: "complete" }); }
    catch { report.cleanup.push({ step: `close-browser-${entry.name}`, status: "failed" }); }
    await Promise.allSettled([...inFlight]);
  }
}

/** Both identities and every session/WS response are genuine in this peer scenario. */
export async function avatarPeerBrowserCase(browser, { boardId, ownerId, guestId, guestName, origin, entry, storageState, guestStorageState, report }) {
  const contexts = [];
  const inFlight = new Set();
  let closing = false;
  const observation = { name: entry.name, allowed: entry.allowed, ownerLocalImageRequests: 0,
    guestLocalImageRequests: 0, ownerWsFramesReceived: 0, guestWsFramesReceived: 0, routeFailures: 0, responsesSubstituted: false,
    phase: "initialization" };
  report.peerObservations ??= [];
  report.peerObservations.push(observation);
  const open = async (state, identity) => {
    observation.phase = `${identity}-context`;
    const context = await browser.newContext({ baseURL: origin, storageState: state,
      viewport: { width: 1440, height: 1000 }, locale: "ru-RU", serviceWorkers: "block" });
    contexts.push({ context, identity });
    context.on("request", (incoming) => {
      const url = new URL(incoming.url());
      if (["http:", "https:"].includes(url.protocol) && url.origin !== origin && report.foreignRequests.length < 40) {
        report.foreignRequests.push({ case: entry.name, identity, origin: url.origin, resourceType: incoming.resourceType() });
      }
      if (url.origin === origin && url.pathname === entry.image) observation[`${identity}LocalImageRequests`] += 1;
    });
    const handleRoute = async (route) => {
      try {
        const url = new URL(route.request().url());
        if (["http:", "https:"].includes(url.protocol) && url.origin !== origin) await route.abort("blockedbyclient");
        else await route.continue();
      } catch {
        if (!closing) {
          observation.routeFailures += 1;
          if (report.routeFailures.length < 20) report.routeFailures.push({ case: entry.name, identity, error: "Browser request routing failed" });
        }
        await route.abort("failed").catch(() => undefined);
      }
    };
    await context.route("**/*", (route) => {
      const task = handleRoute(route);
      inFlight.add(task);
      void task.then(() => inFlight.delete(task));
      return task;
    });
    const page = await context.newPage();
    page.on("pageerror", () => {
      if (report.pageErrors.length < 20) report.pageErrors.push({ case: entry.name, identity, error: "Uncaught browser error" });
    });
    page.on("websocket", (socket) => {
      socket.on("framereceived", () => { observation[`${identity}WsFramesReceived`] += 1; });
    });
    const sessionResponse = page.waitForResponse((response) => new URL(response.url()).origin === origin &&
      new URL(response.url()).pathname === `/api/boards/${boardId}/session` && response.request().method() === "GET", { timeout: 30_000 })
      .then((response) => ({ response }), () => ({ failed: true }));
    observation.phase = `${identity}-navigate`;
    await page.goto(`/board/${boardId}`, { waitUntil: "networkidle", timeout: 30_000 });
    observation.phase = `${identity}-session`;
    const captured = await sessionResponse;
    assert.ok(captured.response, "PEER_SESSION_RESPONSE_MISSING");
    assert.equal(captured.response.status(), 200, "PEER_SESSION_HTTP_STATUS");
    const session = await captured.response.json();
    assert.equal(session.board.id, boardId, "PEER_SESSION_BOARD_MISMATCH");
    assert.equal(session.user.id, identity === "owner" ? ownerId : guestId, "PEER_SESSION_USER_MISMATCH");
    assert.equal(session.role, identity === "owner" ? "owner" : "viewer", "PEER_SESSION_ACL_MISMATCH");
    if (identity === "guest") {
      assert.equal(session.user.name, guestName, "PEER_SESSION_NAME_MISMATCH");
      assert.equal(session.user.image, entry.image, "PEER_SESSION_IMAGE_MISMATCH");
    }
    observation[`${identity}SessionConfirmed`] = true;
    observation.phase = `${identity}-saved`;
    await page.getByText("Сохранено", { exact: true }).waitFor({ timeout: 30_000 });
    return page;
  };
  try {
    const ownerPage = await open(storageState, "owner");
    await open(guestStorageState, "guest");
    observation.phase = "peer-visible";
    // TooltipTrigger asChild overrides the root data-slot; use the observed avatar children.
    await ownerPage.waitForFunction(() => new Set([...document.querySelectorAll('[data-slot="avatar-image"], [data-slot="avatar-fallback"]')]
      .map((node) => node.parentElement)).size === 2);
    observation.peerVisible = true;
    observation.phase = "peer-avatar";
    const images = ownerPage.getByAltText(guestName, { exact: true });
    if (entry.allowed) {
      await images.waitFor({ state: "visible", timeout: 15_000 });
      observation.peerDecoded = await images.evaluate(async (node, expected) => {
        await node.decode();
        return node.getAttribute("src") === expected.image && node.complete && node.naturalWidth > 0 &&
          (expected.expectedWidth === undefined || node.naturalWidth === expected.expectedWidth);
      }, entry);
    } else {
      // BoardParticipants renders the single remote participant before the self-avatar.
      const initials = ownerPage.locator('[data-slot="avatar-fallback"]').first();
      await initials.waitFor({ state: "visible", timeout: 15_000 });
      await ownerPage.waitForTimeout(500);
      observation.peerInitialsVisible = await initials.isVisible() && (await initials.textContent()) === guestName.slice(0, 1);
    }
    observation.peerRenderedImages = await images.count();
    observation.phase = "complete";
    return observation;
  } catch (error) {
    observation.dom = await Promise.all(contexts.map(async ({ context, identity }) => {
      const page = context.pages()[0];
      return { identity, ...(page ? await page.evaluate(() => ({ avatars: new Set([...document.querySelectorAll('[data-slot="avatar-image"], [data-slot="avatar-fallback"]')]
        .map((node) => node.parentElement)).size,
        avatarImages: document.querySelectorAll('[data-slot="avatar-image"]').length,
        fallbacks: document.querySelectorAll('[data-slot="avatar-fallback"]').length,
        saved: document.querySelector('[data-save-state]')?.getAttribute("data-save-state") === "saved",
        alert: document.querySelector('[role="alert"]') !== null,
      })).catch(() => ({ unavailable: true })) : { unavailable: true }) };
    }));
    throw error;
  } finally {
    await Promise.allSettled([...inFlight]);
    closing = true;
    for (const { context, identity } of contexts.reverse()) {
      try { await context.close(); report.cleanup.push({ step: `close-peer-${identity}-${entry.name}`, status: "complete" }); }
      catch { report.cleanup.push({ step: `close-peer-${identity}-${entry.name}`, status: "failed" }); }
    }
    await Promise.allSettled([...inFlight]);
  }
}
