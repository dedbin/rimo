import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { getAuth } from "./auth";
import { getServerConfig } from "./config";
import { getPool } from "./db";

const COOKIE_NAME = "rimo.email_verification";
const LIFETIME_SECONDS = 1_800;

interface VerificationChallenge {
  readonly userId: string;
  readonly email: string;
  readonly expiresAt: number;
  readonly nonce: string;
}

function signature(payload: string): Buffer {
  return createHmac("sha256", getServerConfig().authSecret)
    .update(`rimo-email-verification:${payload}`).digest();
}

function cookie(value: string, maxAge: number): string {
  const secure = getServerConfig().authUrl.startsWith("https://") ? "; Secure" : "";
  return `${COOKIE_NAME}=${value}; Path=/api/auth; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure}`;
}

function withCookie(response: Response, value: string): Response {
  const headers = new Headers(response.headers);
  headers.append("Set-Cookie", value);
  headers.set("Cache-Control", "no-store");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

// Issue only for an actual newly-created user or after Better Auth checked the password.
export async function issueVerificationChallenge(
  response: Response, email: string, userId?: string,
): Promise<Response> {
  const result = await getPool().query<{ id: string }>(
    'SELECT id FROM "user" WHERE email = $1 AND "isAnonymous" = false AND ($2::text IS NULL OR id = $2)',
    [email, userId ?? null],
  );
  const user = result.rows[0];
  if (!user) return clearVerificationChallenge(response);
  const challenge: VerificationChallenge = {
    userId: user.id, email,
    expiresAt: Math.floor(Date.now() / 1_000) + LIFETIME_SECONDS,
    nonce: randomBytes(24).toString("base64url"),
  };
  const payload = Buffer.from(JSON.stringify(challenge)).toString("base64url");
  return withCookie(response, cookie(`${payload}.${signature(payload).toString("base64url")}`, LIFETIME_SECONDS));
}

export function clearVerificationChallenge(response: Response): Response {
  return withCookie(response, cookie("", 0));
}

function readChallenge(request: Request): VerificationChallenge | null {
  const item = request.headers.get("cookie")?.split(";")
    .map(value => value.trim()).find(value => value.startsWith(`${COOKIE_NAME}=`));
  if (!item || item.length > 1_024) return null;
  try {
    const [payload, mac, extra] = item.slice(COOKIE_NAME.length + 1).split(".");
    if (!payload || !mac || extra !== undefined) return null;
    const supplied = Buffer.from(mac, "base64url");
    const expected = signature(payload);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
    const value: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!value || typeof value !== "object") return null;
    const challenge = value as Partial<VerificationChallenge>;
    if (typeof challenge.userId !== "string" || typeof challenge.email !== "string" ||
        typeof challenge.nonce !== "string" || typeof challenge.expiresAt !== "number" ||
        !Number.isSafeInteger(challenge.expiresAt) || challenge.expiresAt <= Math.floor(Date.now() / 1_000)) return null;
    return challenge as VerificationChallenge;
  } catch {
    return null;
  }
}

export async function mayConfirmEmail(request: Request, email: string): Promise<boolean> {
  const session = await getAuth().api.getSession({ headers: request.headers, query: { disableCookieCache: true } });
  if (session && !session.user.isAnonymous && session.user.email.toLowerCase() === email) return true;
  const challenge = readChallenge(request);
  if (!challenge || challenge.email !== email) return false;
  const user = await getPool().query(
    'SELECT id FROM "user" WHERE id = $1 AND email = $2 AND "isAnonymous" = false',
    [challenge.userId, email],
  );
  return user.rowCount === 1;
}
