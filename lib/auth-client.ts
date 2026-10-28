"use client";

import { createAuthClient } from "better-auth/react";
import { anonymousClient, emailOTPClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({ plugins: [anonymousClient(), emailOTPClient()] });
