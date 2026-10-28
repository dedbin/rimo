import nodemailer, { type Transporter } from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport";
import { z } from "zod";

import { HttpError } from "./http-error";

interface MailConfig {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly from: string;
}

function mailFailure(): HttpError {
  return new HttpError(503, "MAIL_SEND_FAILED", "Не удалось отправить код. Попробуйте позже.");
}

function requiredSetting(name: string, trim = true): string {
  const value = process.env[name];
  if (!value || !value.trim()) throw mailFailure();
  const result = trim ? value.trim() : value;
  if (/[\r\n]/.test(result)) throw mailFailure();
  return result;
}

// Read settings only when sending, so migrations and collaboration need no SMTP credentials.
function getMailConfig(): MailConfig {
  const port = Number(process.env.SMTP_PORT ?? "587");
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw mailFailure();
  const from = requiredSetting("MAIL_FROM");
  if (!z.email().safeParse(from).success) throw mailFailure();
  return Object.freeze({
    host: requiredSetting("SMTP_HOST"),
    port,
    user: requiredSetting("SMTP_USER"),
    password: requiredSetting("SMTP_PASSWORD", false),
    from,
  });
}

function createMailTransport(config: MailConfig): Transporter<SMTPTransport.SentMessageInfo, SMTPTransport.Options> {
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.port === 465,
    requireTLS: config.port !== 465,
    auth: { user: config.user, pass: config.password },
    tls: { rejectUnauthorized: true, minVersion: "TLSv1.2" },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 10_000,
    dnsTimeout: 10_000,
    disableFileAccess: true,
    disableUrlAccess: true,
    logger: false,
    debug: false,
  });
}

export async function sendVerificationCode(email: string, otp: string): Promise<void> {
  try {
    if (!z.email().safeParse(email).success || !/^\d{6}$/.test(otp)) throw mailFailure();
    const config = getMailConfig();
    await createMailTransport(config).sendMail({
      from: { name: "Rimo", address: config.from },
      to: email,
      subject: "Код подтверждения почты в Rimo",
      text: `Ваш код подтверждения почты в Rimo: ${otp}\n\nКод действует 10 минут. Никому не сообщайте его.\nЕсли вы не запрашивали код, просто проигнорируйте это письмо.`,
      html: `<p>Ваш код подтверждения почты в Rimo:</p><p style="font-size:28px;font-weight:700;letter-spacing:4px">${otp}</p><p>Код действует 10 минут. Никому не сообщайте его.</p><p>Если вы не запрашивали код, просто проигнорируйте это письмо.</p>`,
    });
  } catch {
    // Provider errors can contain credentials, message contents and complete SMTP commands.
    throw mailFailure();
  }
}

export async function verifyMailTransport(): Promise<void> {
  try {
    await createMailTransport(getMailConfig()).verify();
  } catch {
    throw mailFailure();
  }
}
