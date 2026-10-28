import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

export function prepareTestMail(runId: string): Record<string, string> {
  if (!/^[a-f0-9-]{36}$/.test(runId)) throw new Error("Invalid mail fixture namespace");
  const directory = path.resolve("temp/e2e", `mail-${runId}`);
  mkdirSync(directory, { recursive: true });
  const certificate = path.join(directory, "certificate.pem");
  const key = path.join(directory, "private-key.pem");
  const gitOpenSsl = "C:\\Program Files\\Git\\usr\\bin\\openssl.exe";
  const executable = process.env.RIMO_E2E_OPENSSL ?? (process.platform === "win32" && existsSync(gitOpenSsl) ? gitOpenSsl : "openssl");
  if (!existsSync(certificate) || !existsSync(key)) {
    try {
      execFileSync(executable, [
        "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost",
        "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1", "-keyout", key, "-out", certificate,
      ], { stdio: "ignore" });
    } catch {
      throw new Error("Local email E2E requires OpenSSL to generate its temporary STARTTLS certificate");
    }
  }
  const environment = {
    SMTP_HOST: "localhost", SMTP_PORT: "1025", SMTP_USER: `e2e-${runId}`,
    SMTP_PASSWORD: process.env.RIMO_E2E_SMTP_PASSWORD ?? randomBytes(32).toString("base64url"),
    MAIL_FROM: "verification@example.test",
    NODE_EXTRA_CA_CERTS: certificate, RIMO_E2E_SMTP_CERT: certificate, RIMO_E2E_SMTP_KEY: key,
    RIMO_E2E_MAILBOX_URL: "http://127.0.0.1:1080",
    RIMO_E2E_MAILBOX_TOKEN: process.env.RIMO_E2E_MAILBOX_TOKEN ?? randomBytes(32).toString("base64url"),
  };
  // The runner and its app/SMTP subprocesses share ephemeral credentials, never production SMTP.
  Object.assign(process.env, environment, { RIMO_E2E_SMTP_PASSWORD: environment.SMTP_PASSWORD });
  return environment;
}
