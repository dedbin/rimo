import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

import { simpleParser } from "mailparser";
import { SMTPServer } from "smtp-server";

const token = process.env.RIMO_E2E_MAILBOX_TOKEN;
const certificate = process.env.RIMO_E2E_SMTP_CERT;
const key = process.env.RIMO_E2E_SMTP_KEY;
if (!token || !certificate || !key || !process.env.SMTP_USER || !process.env.SMTP_PASSWORD) {
  throw new Error("The local SMTP fixture requires its ephemeral E2E settings");
}
const deliveries = new Map();
const smtp = new SMTPServer({
  secure: false, key: readFileSync(key), cert: readFileSync(certificate), logger: false,
  size: 64 * 1024,
  onAuth(auth, session, callback) {
    if (auth.username !== process.env.SMTP_USER || auth.password !== process.env.SMTP_PASSWORD) {
      return callback(new Error("Invalid test SMTP credentials"));
    }
    callback(null, { user: auth.username });
  },
  onData(stream, session, callback) {
    void simpleParser(stream).then(message => {
      const content = message.text ?? String(message.html ?? "");
      const code = /\b\d{6}\b/.exec(content)?.[0];
      if (!code) throw new Error("The test email contained no six-digit code");
      for (const recipient of session.envelope.rcptTo) {
        deliveries.set(recipient.address.toLowerCase(), { code, receivedAt: Date.now() });
      }
      if (deliveries.size > 100) deliveries.delete(deliveries.keys().next().value);
      callback();
    }).catch(() => callback(new Error("The test SMTP fixture could not read this email")));
  },
});
const mailbox = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1:1080");
  if (request.method === "GET" && url.pathname === "/health") {
    response.writeHead(200).end("ok");
    return;
  }
  const expected = Buffer.from(`Bearer ${token}`);
  const supplied = Buffer.from(request.headers.authorization ?? "");
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
    response.writeHead(403).end();
    return;
  }
  if (request.method !== "GET" || url.pathname !== "/code") {
    response.writeHead(404).end();
    return;
  }
  const delivery = deliveries.get((url.searchParams.get("email") ?? "").trim().toLowerCase());
  if (!delivery || delivery.receivedAt < Number(url.searchParams.get("after") ?? "0")) {
    response.writeHead(404, { "Cache-Control": "no-store" }).end();
    return;
  }
  response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(delivery));
});
smtp.on("error", () => { process.stderr.write("The local SMTP fixture failed\n"); process.exitCode = 1; });
smtp.listen(1025, "127.0.0.1", () => mailbox.listen(1080, "127.0.0.1"));
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => { mailbox.close(); smtp.close(() => process.exit(0)); });
}
