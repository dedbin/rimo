import { randomUUID } from "node:crypto";

import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { anonymous, emailOTP } from "better-auth/plugins";

import { getServerConfig } from "./config";
import { getPool } from "./db";
import { validatedProfile } from "./auth-profile";
import { HttpError } from "./http-error";
import { sendVerificationCode } from "./mail";
import { activateVerifiedOwner, withOwnerQuota } from "./quotas";

const disabledPaths = [
  "/verify-email", "/send-verification-email", "/sign-in/email-otp",
  "/email-otp/check-verification-otp", "/email-otp/forget-password",
  "/forget-password/email-otp", "/email-otp/request-password-reset", "/email-otp/reset-password",
  "/email-otp/request-email-change", "/email-otp/change-email",
  "/request-password-reset", "/reset-password", "/change-email",
];

function createAuth(allowSignUp: boolean) {
  const config = getServerConfig();
  return betterAuth({
    database: getPool(),
    secret: config.authSecret,
    baseURL: config.authUrl,
    trustedOrigins: [...config.trustedOrigins],
    disabledPaths,
    user: {
      additionalFields: {
        registrationPending: { type: "boolean", required: true, defaultValue: true, input: false },
      },
    },
    emailAndPassword: {
      enabled: true,
      disableSignUp: !allowSignUp,
      minPasswordLength: 12,
      requireEmailVerification: true,
    },
    emailVerification: {
      sendOnSignUp: false,
      sendOnSignIn: false,
      autoSignInAfterVerification: false,
      async beforeEmailVerification(user) {
        try {
          await activateVerifiedOwner(user.id);
        } catch (error) {
          if (error instanceof HttpError) {
            throw new APIError(error.status === 409 ? "CONFLICT" : "FORBIDDEN", {
              code: error.code, message: error.message,
            });
          }
          throw error;
        }
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      cookieCache: { enabled: false },
    },
    advanced: {
      useSecureCookies: config.authUrl.startsWith("https://"),
      database: { generateId: () => randomUUID() },
      ipAddress: { ipAddressHeaders: ["x-forwarded-for"] },
    },
    rateLimit: { enabled: true, window: 60, max: 30 },
    databaseHooks: {
      user: {
        create: { before: async (user) => ({
          data: { ...user, ...validatedProfile(user), emailVerified: false, registrationPending: user.isAnonymous !== true },
        }) },
        update: { before: async (user) => ({ data: { ...user, ...validatedProfile(user) } }) },
      },
    },
    plugins: [
      anonymous({ disableDeleteAnonymousUser: true }),
      emailOTP({
        otpLength: 6,
        expiresIn: 600,
        allowedAttempts: 5,
        storeOTP: "hashed",
        resendStrategy: "rotate",
        disableSignUp: true,
        sendVerificationOnSignUp: false,
        overrideDefaultEmailVerification: true,
        rateLimit: { window: 60, max: 10 },
        async sendVerificationOTP({ email, otp, type }) {
          if (type !== "email-verification") {
            throw new APIError("BAD_REQUEST", { code: "INVALID_OTP_TYPE", message: "Недопустимый тип кода." });
          }
          try {
            await sendVerificationCode(email, otp);
          } catch {
            throw new APIError("SERVICE_UNAVAILABLE", {
              code: "MAIL_SEND_FAILED", message: "Не удалось отправить код. Попробуйте позже.",
            });
          }
        },
      }),
    ],
  });
}

let authInstance: ReturnType<typeof createAuth> | undefined;
let registrationInstance: ReturnType<typeof createAuth> | undefined;

export function getAuth(options: { allowSignUp?: boolean } = {}) {
  if (options.allowSignUp) return createAuth(true);
  authInstance ??= createAuth(false);
  return authInstance;
}

export async function createOwnerAccount(input: { email: string; password: string; name: string }) {
  return withOwnerQuota(() => createAuth(true).api.signUpEmail({ body: input }));
}

export async function registerOwnerAccount(request: Request): Promise<Response> {
  const auth = registrationInstance ??= createAuth(true);
  try {
    return await withOwnerQuota(() => auth.handler(request));
  } catch (error) {
    if (error instanceof HttpError && error.code === "OWNER_LIMIT_REACHED") {
      return Response.json({ code: error.code, message: error.message }, {
        status: error.status,
        headers: { "Cache-Control": "no-store" },
      });
    }
    throw error;
  }
}

export type AuthSession = NonNullable<
  Awaited<ReturnType<ReturnType<typeof getAuth>["api"]["getSession"]>>
>;
