import { randomUUID } from "node:crypto";

import { betterAuth } from "better-auth";
import { anonymous } from "better-auth/plugins";

import { getServerConfig } from "./config";
import { getPool } from "./db";
import { validatedProfile } from "./auth-profile";
import { HttpError } from "./http-error";
import { withOwnerQuota } from "./quotas";

function createAuth(allowSignUp: boolean) {
  const config = getServerConfig();
  return betterAuth({
    database: getPool(),
    secret: config.authSecret,
    baseURL: config.authUrl,
    trustedOrigins: [...config.trustedOrigins],
    emailAndPassword: {
      enabled: true,
      disableSignUp: !allowSignUp,
      minPasswordLength: 12,
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      cookieCache: { enabled: false },
    },
    advanced: {
      useSecureCookies: config.authUrl.startsWith("https://"),
      database: { generateId: () => randomUUID() },
    },
    rateLimit: { enabled: true, window: 60, max: 30 },
    databaseHooks: {
      user: {
        create: { before: async (user) => ({ data: { ...user, ...validatedProfile(user) } }) },
        update: { before: async (user) => ({ data: { ...user, ...validatedProfile(user) } }) },
      },
    },
    plugins: [anonymous({ disableDeleteAnonymousUser: true })],
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
