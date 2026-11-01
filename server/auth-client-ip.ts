import { isIP } from "node:net";

// Only the final hop supplied by our reverse proxy is trusted. The app port
// must stay private; client-supplied prefixes must not split rate-limit buckets.
export function authClientIp(headers: Headers): string {
  const candidate = headers.get("x-forwarded-for")?.split(",").at(-1)?.trim() ?? "";
  return isIP(candidate) ? candidate : "unknown";
}

export function authRequestHeaders(headers: Headers): Headers {
  const normalized = new Headers(headers);
  const ip = authClientIp(headers);
  if (ip === "unknown") normalized.delete("x-forwarded-for");
  else normalized.set("x-forwarded-for", ip);
  return normalized;
}
