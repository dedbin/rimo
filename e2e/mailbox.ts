export async function waitForVerificationCode(email: string, after = 0): Promise<string> {
  const mailbox = process.env.RIMO_E2E_MAILBOX_URL;
  const token = process.env.RIMO_E2E_MAILBOX_TOKEN;
  if (!mailbox || !token) throw new Error("Email verification E2E requires its private local SMTP mailbox");
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const url = new URL("/code", mailbox);
    url.searchParams.set("email", email);
    url.searchParams.set("after", String(after));
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(3_000) });
    if (response.ok) {
      const result = await response.json() as { code?: string };
      if (typeof result.code === "string" && /^\d{6}$/.test(result.code)) return result.code;
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error("The test SMTP mailbox did not receive a verification email in time");
}
