// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sendVerificationCode, verifyMailTransport } from "../server/mail";

const smtp = vi.hoisted(() => ({ createTransport: vi.fn(), sendMail: vi.fn(), verify: vi.fn() }));
vi.mock("nodemailer", () => ({ default: { createTransport: smtp.createTransport } }));

beforeEach(() => {
  vi.stubEnv("SMTP_HOST", "smtp.example.test");
  vi.stubEnv("SMTP_PORT", undefined);
  vi.stubEnv("SMTP_USER", "synthetic-smtp-user");
  vi.stubEnv("SMTP_PASSWORD", "  synthetic-smtp-password  ");
  vi.stubEnv("MAIL_FROM", "no-reply@example.test");
  smtp.createTransport.mockReset().mockReturnValue({ sendMail: smtp.sendMail, verify: smtp.verify });
  smtp.sendMail.mockReset().mockResolvedValue({ accepted: ["teacher@example.test"] });
  smtp.verify.mockReset().mockResolvedValue(true);
});

afterEach(() => { vi.unstubAllEnvs(); });

describe("verification email transport", () => {
  it("requires STARTTLS on the default SMTP port and disables message logging and external content", async () => {
    await sendVerificationCode("teacher@example.test", "123456");
    expect(smtp.createTransport).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      host: "smtp.example.test", port: 587, secure: false, requireTLS: true,
      auth: { user: "synthetic-smtp-user", pass: "  synthetic-smtp-password  " },
      tls: { rejectUnauthorized: true, minVersion: "TLSv1.2" },
      logger: false, debug: false, disableFileAccess: true, disableUrlAccess: true,
    }));
    const options = smtp.createTransport.mock.calls[0][0];
    for (const key of ["connectionTimeout", "greetingTimeout", "socketTimeout", "dnsTimeout"]) {
      expect(options[key]).toBeGreaterThan(0);
      expect(options[key]).toBeLessThanOrEqual(10_000);
    }
  });

  it("uses immediate TLS on port 465", async () => {
    vi.stubEnv("SMTP_PORT", "465");
    await sendVerificationCode("teacher@example.test", "000012");
    expect(smtp.createTransport).toHaveBeenCalledWith(expect.objectContaining({
      port: 465, secure: true, requireTLS: false,
    }));
  });

  it("sends the same code and expiry in Russian plain text and HTML to exactly one recipient", async () => {
    await sendVerificationCode("teacher@example.test", "000012");
    expect(smtp.sendMail).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      from: { name: "Rimo", address: "no-reply@example.test" }, to: "teacher@example.test",
      subject: "Код подтверждения почты в Rimo",
      text: expect.stringContaining("000012"), html: expect.stringContaining("000012"),
    }));
    const message = smtp.sendMail.mock.calls[0][0];
    expect(message.text).toContain("10 минут");
    expect(message.html).toContain("10 минут");
    expect(message.text).toContain("Никому не сообщайте");
  });

  it.each([
    ["SMTP_HOST", undefined], ["SMTP_USER", ""], ["SMTP_PASSWORD", undefined],
    ["SMTP_PORT", "NaN"], ["SMTP_PORT", "0"], ["SMTP_PORT", "65536"],
    ["MAIL_FROM", "invalid-address"], ["MAIL_FROM", "sender@example.test\r\nBcc: other@example.test"],
  ])("rejects invalid %s before opening a transport", async (key, value) => {
    vi.stubEnv(key, value);
    await expect(sendVerificationCode("teacher@example.test", "123456")).rejects.toMatchObject({
      status: 503, code: "MAIL_SEND_FAILED",
    });
    expect(smtp.createTransport).not.toHaveBeenCalled();
  });

  it.each([
    ["teacher@example.test,other@example.test", "123456"],
    ["teacher@example.test", "<script>"], ["teacher@example.test", "12345"],
  ])("rejects an invalid recipient or code without sending", async (email, otp) => {
    await expect(sendVerificationCode(email, otp)).rejects.toMatchObject({ code: "MAIL_SEND_FAILED" });
    expect(smtp.sendMail).not.toHaveBeenCalled();
  });

  it("redacts provider errors rather than exposing SMTP credentials or the code", async () => {
    smtp.sendMail.mockRejectedValue(new Error("synthetic-smtp-password AUTH request includes 123456"));
    const error = await sendVerificationCode("teacher@example.test", "123456").catch((value: unknown) => value);
    expect(error).toMatchObject({
      status: 503, code: "MAIL_SEND_FAILED", message: "Не удалось отправить код. Попробуйте позже.",
    });
    expect(String(error)).not.toContain("synthetic-smtp-password");
    expect(String(error)).not.toContain("123456");
    expect(error).not.toHaveProperty("cause");
  });

  it("can check SMTP configuration without sending a message", async () => {
    await verifyMailTransport();
    expect(smtp.verify).toHaveBeenCalledOnce();
    expect(smtp.sendMail).not.toHaveBeenCalled();
  });

  it("also redacts verification failures", async () => {
    smtp.verify.mockRejectedValue(new Error("synthetic-smtp-password authentication failed"));
    await expect(verifyMailTransport()).rejects.toMatchObject({
      status: 503, code: "MAIL_SEND_FAILED", message: "Не удалось отправить код. Попробуйте позже.",
    });
  });
});
