import { verifyMailTransport } from "../server/mail";
import { loadEnvironment } from "./load-env";

loadEnvironment();
verifyMailTransport().then(() => {
  process.stdout.write("SMTP connection, TLS and authentication verified. No email was sent.\n");
}).catch(() => {
  process.stderr.write("SMTP check failed. Check SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD and MAIL_FROM.\n");
  process.exitCode = 1;
});
