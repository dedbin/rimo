import { isIP } from "node:net";

import { toNextJsHandler } from "better-auth/next-js";
import { z } from "zod";

import { canUseAccount } from "@/lib/verified-user";
import { getAuth, registerOwnerAccount } from "@/server/auth";
import { getPool } from "@/server/db";
import {
  clearVerificationChallenge, issueVerificationChallenge, mayConfirmEmail,
} from "@/server/email-verification-challenge";
import { assertVerificationSendAllowed, VerificationSendLimitError } from "@/server/email-verification-limits";
import { withVerificationCodeLock } from "@/server/email-verification-lock";
import { assertSameOrigin, handleApi, readJsonObject, readRequestBuffer } from "@/server/http";
import { sendVerificationCode } from "@/server/mail";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const blocked = await beforeVerification(request);
  if (blocked) return blocked;
  return toNextJsHandler(getAuth()).GET(request);
}

function authFailure(status: number, code: string, message: string, retryAfter?: number): Response {
  return Response.json({ code, message }, {
    status,
    headers: { "Cache-Control": "no-store", ...(retryAfter ? { "Retry-After": String(retryAfter) } : {}) },
  });
}

function authPath(request: Request): string {
  return new URL(request.url).pathname.replace(/\/+$/, "");
}

function nonCanonicalPath(request: Request): boolean {
  const path = new URL(request.url).pathname;
  return path.includes("//") || path.includes("%") || path.includes("\\");
}

async function beforeVerification(request: Request): Promise<Response | null> {
  if (nonCanonicalPath(request)) return authFailure(404, "NOT_FOUND", "Маршрут не найден.");
  const path = authPath(request);
  const allowed = ["/get-session", "/sign-out", "/email-otp/send-verification-otp", "/email-otp/verify-email"];
  if (allowed.some((suffix) => path === `/api/auth${suffix}`)) return null;
  const session = await getAuth().api.getSession({ headers: request.headers, query: { disableCookieCache: true } });
  if (session && !canUseAccount(session.user)) {
    return authFailure(403, "EMAIL_NOT_VERIFIED", "Подтвердите почту, чтобы продолжить работу.");
  }
  return null;
}

export async function POST(request: Request): Promise<Response> {
  return handleApi(async () => {
    assertSameOrigin(request);
    const bytes = await readRequestBuffer(request, 16_384);
    const bounded = new Request(request.url, {
      method: request.method,
      headers: request.headers,
      body: new Uint8Array(bytes),
      signal: request.signal,
    });
    const path = authPath(request);
    const blocked = await beforeVerification(bounded);
    if (blocked) return blocked;
    if (["/api/auth/email-otp/send-verification-otp", "/api/auth/email-otp/verify-email"].includes(path)) {
      const input = await readJsonObject(bounded.clone());
      const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
      const sending = path.endsWith("/send-verification-otp");
      if ((sending && input.type !== "email-verification") || !z.email().safeParse(email).success) {
        return authFailure(400, "INVALID_OTP_REQUEST", "Проверьте почту и тип подтверждения.");
      }
      if (!await mayConfirmEmail(bounded, email)) {
        return authFailure(403, "VERIFICATION_REQUIRED", "Вернитесь к форме и войдите с почтой и паролем, чтобы запросить код.");
      }
      if (!sending) {
        try {
          const response = await withVerificationCodeLock(email, () => toNextJsHandler(getAuth()).POST(bounded));
          return response.ok ? clearVerificationChallenge(response) : response;
        } catch (error) {
          if (error instanceof VerificationSendLimitError) {
            return authFailure(error.status, error.code, error.message, error.retryAfter);
          }
          throw error;
        }
      }
      // Caddy supplies this header; the app has no public published port.
      const candidate = request.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim() ?? "";
      const ip = isIP(candidate) ? candidate : "unknown";
      let otp: string;
      try {
        otp = await withVerificationCodeLock(email, async () => {
          await assertVerificationSendAllowed(email, ip);
          await getPool().query('DELETE FROM verification WHERE identifier = $1', [`email-verification-otp-${email}`]);
          return getAuth().api.createVerificationOTP({ body: { email, type: "email-verification" } });
        });
      } catch (error) {
        if (error instanceof VerificationSendLimitError) {
          return authFailure(error.status, error.code, error.message, error.retryAfter);
        }
        throw error;
      }
      try {
        // Keep SMTP outside the lock and await delivery so failures reach the form.
        await sendVerificationCode(email, otp);
      } catch {
        return authFailure(503, "MAIL_SEND_FAILED", "Не удалось отправить код. Попробуйте позже.", 60);
      }
      return Response.json({ success: true }, { headers: { "Cache-Control": "no-store" } });
    }
    if (path === "/api/auth/sign-up/email") {
      const response = await registerOwnerAccount(bounded);
      if (!response.ok) return response;
      const data = await response.clone().json() as { user?: { id?: string; email?: string } };
      return data.user?.id && data.user.email
        ? issueVerificationChallenge(response, data.user.email.toLowerCase(), data.user.id)
        : clearVerificationChallenge(response);
    }
    const response = await toNextJsHandler(getAuth()).POST(bounded);
    if (path === "/api/auth/sign-in/email" && response.status === 403) {
      const data = await response.clone().json() as { code?: string };
      if (data.code === "EMAIL_NOT_VERIFIED") {
        const input = await readJsonObject(new Request(request.url, { method: "POST", body: new Uint8Array(bytes) }));
        if (typeof input.email === "string") return issueVerificationChallenge(response, input.email.trim().toLowerCase());
      }
    }
    return path === "/api/auth/sign-out" ? clearVerificationChallenge(response) : response;
  });
}
