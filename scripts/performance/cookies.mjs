import { Cookie, CookieJar } from "tough-cookie";

export class CookieScopeError extends Error {}

/** Preserve Playwright's host-only/domain convention; let RFC6265 scope the header. */
export async function cookieHeaderForUrl(cookies, targetUrl) {
  try {
    const target = new URL(targetUrl);
    if (!["http:", "https:"].includes(target.protocol) || target.username || target.password) throw new Error();
    const jar = new CookieJar(undefined, { prefixSecurity: "strict" });
    for (const entry of cookies) {
      // CHIPS needs a top-level partition context, which Node providers do not have.
      if (entry.partitionKey !== undefined || entry.partitioned === true) continue;
      if (typeof entry.name !== "string" || typeof entry.value !== "string" || typeof entry.domain !== "string" ||
          typeof entry.path !== "string" || !entry.path.startsWith("/") || !Number.isFinite(entry.expires) ||
          typeof entry.secure !== "boolean" || typeof entry.httpOnly !== "boolean") throw new Error();
      const pair = Cookie.parse(`${entry.name}=${entry.value}`, { loose: false });
      if (!pair || pair.key !== entry.name || pair.value !== entry.value) throw new Error();
      const expires = entry.expires === -1 ? "Infinity" : new Date(entry.expires * 1_000);
      if (expires instanceof Date && !Number.isFinite(expires.getTime())) throw new Error();
      const domain = entry.domain.replace(/^\./, "");
      const cookie = new Cookie({ key: entry.name, value: entry.value,
        ...(entry.domain.startsWith(".") ? { domain } : {}), path: entry.path,
        secure: entry.secure, httpOnly: entry.httpOnly,
        expires,
        sameSite: entry.sameSite?.toLowerCase() });
      // Restore at its own domain; never broaden a host-only cookie to the requested host.
      const origin = new URL(`${cookie.secure ? "https:" : "http:"}//${domain}/`);
      await jar.setCookie(cookie, origin.href);
    }
    return await jar.getCookieString(target.href, { http: true, sameSiteContext: "strict" });
  } catch { throw new CookieScopeError("Cookie storage state cannot be scoped safely"); }
}

export async function websocketCookieHeader(context, applicationUrl, websocketUrl) {
  let target;
  try {
    const application = new URL(applicationUrl);
    const websocket = new URL(websocketUrl);
    if (application.hostname !== websocket.hostname || websocket.username || websocket.password ||
        !["http:", "https:"].includes(application.protocol) ||
        websocket.protocol !== (application.protocol === "https:" ? "wss:" : "ws:")) throw new Error();
    target = new URL(websocket);
    target.protocol = websocket.protocol === "wss:" ? "https:" : "http:";
  } catch { throw new CookieScopeError("Cookie authentication requires the same host and an HTTP/WS or HTTPS/WSS scheme pair"); }
  const { cookies } = await context.storageState();
  return cookieHeaderForUrl(cookies, target.href);
}
