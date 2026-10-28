import { randomBytes, randomUUID } from "node:crypto";

import { escapeIdentifier, Pool } from "pg";
import { afterAll, beforeAll, beforeEach, expect, vi } from "vitest";

import { GET as handleAuthGet, POST as handleAuthPost } from "../app/api/auth/[...all]/route";
import { getPool as serverPool } from "../server/db";
import { runMigrations } from "../server/migrations";

const delivery = vi.hoisted(() => ({ send: vi.fn<(email: string, otp: string) => Promise<void>>() }));
vi.mock("../server/mail", () => ({ sendVerificationCode: delivery.send }));
export const mail = delivery;

export const testDatabaseUrl = process.env.RIMO_TEST_DATABASE_URL;
export const origin = "http://localhost:3000";
export const password = randomBytes(24).toString("base64url");
let sequence = 0;
const verificationCookies = new Map<string, string>();

export function request(
  pathname: string, body?: unknown, sessionCookie?: string, requestOrigin = origin,
  clientIp = `198.51.${Math.floor(++sequence / 250)}.${sequence % 250 + 1}`,
): Request {
  return new Request(`${origin}${pathname}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", Origin: requestOrigin,
      "X-Forwarded-For": clientIp, ...(sessionCookie ? { Cookie: sessionCookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

export function credentials(): { name: string; email: string; password: string } {
  return { name: "Проверка почты", email: `${randomUUID()}@example.test`, password };
}

export function cookie(response: Response): string {
  return response.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
}

export function useVerificationDatabase(prefix: string): void {
  const schema = `${prefix}_${randomUUID().replaceAll("-", "")}`;
  const quoted = escapeIdentifier(schema);
  let admin: Pool | undefined;
  let created = false;
  beforeAll(async () => {
    admin = new Pool({ connectionString: testDatabaseUrl, connectionTimeoutMillis: 3_000 });
    await admin.query(`CREATE SCHEMA ${quoted}`);
    created = true;
    const isolated = new URL(testDatabaseUrl!);
    isolated.searchParams.set("options", `-c search_path=${schema}`);
    vi.stubEnv("DATABASE_URL", isolated.toString());
    vi.stubEnv("BETTER_AUTH_SECRET", randomBytes(32).toString("base64url"));
    vi.stubEnv("BETTER_AUTH_URL", origin);
    vi.stubEnv("MAX_OWNERS", "6");
    const current = await getPool().query<{ schema: string }>("SELECT current_schema() AS schema");
    if (current.rows[0].schema !== schema) throw new Error("Email tests require their isolated schema");
    await runMigrations();
  }, 30_000);
  beforeEach(async () => {
    mail.send.mockReset().mockResolvedValue(undefined);
    verificationCookies.clear();
    await getPool().query(`TRUNCATE ${quoted}."user", ${quoted}.verification, ${quoted}.email_verification_limits CASCADE`);
  });
  afterAll(async () => {
    if (created) await getPool().end();
    if (!/^[a-z_]+_[a-f0-9]{32}$/.test(schema)) throw new Error("Unsafe email test schema");
    if (created) await admin?.query(`DROP SCHEMA ${quoted} CASCADE`);
    await admin?.end();
    vi.unstubAllEnvs();
  });
}

export async function register(input = credentials()): Promise<{ id: string; email: string; name: string; password: string }> {
  const response = await authPost(request("/api/auth/sign-up/email", input));
  expect(response.status).toBe(200);
  expect(cookie(response)).not.toContain("session_token");
  const data = await response.json() as { user: { id: string } };
  const proof = cookie(response);
  expect(/rimo\.email_verification=[^;]+/.test(proof)).toBe(true);
  verificationCookies.set(input.email.trim().toLowerCase(), proof);
  return { ...input, id: data.user.id };
}

export async function sendCode(email: string, ip?: string): Promise<Response> {
  return authPost(request("/api/auth/email-otp/send-verification-otp", { email, type: "email-verification" }, verificationCookie(email), origin, ip));
}

export function deliveredCode(email: string): string {
  const delivery = mail.send.mock.calls.filter(call => call[0] === email).at(-1);
  if (!delivery) throw new Error("The test mailbox received no verification code");
  expect(delivery[1]).toMatch(/^\d{6}$/);
  return delivery[1];
}

export async function verifyCode(email: string, otp: string): Promise<Response> {
  return authPost(request("/api/auth/email-otp/verify-email", { email, otp }, verificationCookie(email)));
}

export async function login(email: string, inputPassword = password): Promise<Response> {
  const response = await authPost(request("/api/auth/sign-in/email", { email, password: inputPassword }));
  const proof = cookie(response);
  if (proof.includes("rimo.email_verification=") || proof.includes("session_token=")) {
    verificationCookies.set(email.trim().toLowerCase(), proof);
  }
  return response;
}

export function verificationCookie(email: string): string | undefined {
  return verificationCookies.get(email.trim().toLowerCase());
}

export async function seedLegacy(verified = false, anonymous = false): Promise<string> {
  const id = randomUUID();
  await getPool().query(
    'INSERT INTO "user"(id,name,email,"emailVerified","isAnonymous") VALUES($1,$2,$3,$4,$5)',
    [id, "Существующий владелец", `${id}@example.test`, verified, anonymous],
  );
  return id;
}

export async function authGet(incoming: Request): Promise<Response> {
  return handleAuthGet(incoming);
}

export async function authPost(incoming: Request): Promise<Response> {
  return handleAuthPost(incoming);
}

export function getPool(): ReturnType<typeof serverPool> {
  return serverPool();
}
