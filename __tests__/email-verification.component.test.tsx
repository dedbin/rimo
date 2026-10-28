import "@testing-library/jest-dom/vitest";

import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EmailVerification } from "@/components/auth/email-verification";

const calls = vi.hoisted(() => ({ send: vi.fn(), verify: vi.fn() }));
vi.mock("@/lib/auth-client", () => ({ authClient: {
  emailOtp: { sendVerificationOtp: calls.send, verifyEmail: calls.verify },
} }));

beforeEach(() => {
  calls.send.mockReset().mockResolvedValue({ error: null });
  calls.verify.mockReset().mockResolvedValue({ error: null });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

async function fillCode(value = "123456"): Promise<void> {
  await waitFor(() => expect(screen.getByLabelText("Код из письма")).toBeEnabled());
  fireEvent.change(screen.getByLabelText("Код из письма"), { target: { value } });
}

describe("EmailVerification", () => {
  it("sends once in StrictMode and accepts a pasted code with leading zeros", async () => {
    const verified = vi.fn().mockResolvedValue(undefined);
    render(<StrictMode><EmailVerification email="teacher@example.test" onVerified={verified} /></StrictMode>);
    await fillCode("");
    expect(calls.send).toHaveBeenCalledTimes(1);
    const input = screen.getByLabelText("Код из письма");
    expect(input).toHaveAttribute("autocomplete", "one-time-code");
    expect(input).toHaveAttribute("inputmode", "numeric");
    fireEvent.paste(input, { clipboardData: { getData: () => "00 12 34" } });
    expect(input).toHaveValue("001234");
    fireEvent.click(screen.getByRole("button", { name: "Подтвердить почту" }));
    await waitFor(() => expect(verified).toHaveBeenCalledTimes(1));
    expect(calls.verify).toHaveBeenCalledWith({ email: "teacher@example.test", otp: "001234" }, expect.any(Object));
  });

  it.each([
    ["INVALID_OTP", "Код не подошёл.", false],
    ["OTP_EXPIRED", "Срок действия кода истёк.", true],
    ["TOO_MANY_ATTEMPTS", "Попытки закончились.", true],
    ["OWNER_LIMIT_REACHED", "Свободных аккаунтов пока нет.", true],
  ])("explains %s and requires a new code when appropriate", async (code, message, needsNewCode) => {
    calls.verify.mockResolvedValueOnce({ error: { code } });
    const verified = vi.fn();
    render(<EmailVerification email="teacher@example.test" onVerified={verified} />);
    await fillCode();
    fireEvent.click(screen.getByRole("button", { name: "Подтвердить почту" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(verified).not.toHaveBeenCalled();
    if (needsNewCode) expect(screen.getByRole("button", { name: "Подтвердить почту" })).toBeDisabled();
    else expect(screen.getByRole("button", { name: "Подтвердить почту" })).toBeEnabled();
  });

  it("keeps the resend cooldown after an SMTP failure and allows retrying afterward", async () => {
    vi.useFakeTimers();
    calls.send.mockResolvedValueOnce({ error: { code: "MAIL_SEND_FAILED", status: 503 } });
    render(<EmailVerification email="teacher@example.test" onVerified={vi.fn()} />);
    await act(async () => {});
    expect(screen.getByRole("alert")).toHaveTextContent("Не удалось отправить письмо.");
    expect(screen.getByRole("button", { name: "Отправить ещё раз через 60 с" })).toBeDisabled();
    expect(calls.send).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    fireEvent.click(screen.getByRole("button", { name: "Отправить код ещё раз" }));
    await act(async () => {});
    expect(calls.send).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("status")).toHaveTextContent("Если адрес ожидает подтверждения");
  });

  it.each(["VERIFICATION_REQUIRED", "VERIFICATION_EXPIRED"])("explains %s without requesting credentials in the code form", async (code) => {
    calls.send.mockResolvedValueOnce({ error: { code, status: 403 } });
    const verified = vi.fn();
    render(<EmailVerification email="teacher@example.test" onVerified={verified} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Вернитесь к форме и войдите с почтой и паролем, чтобы запросить код.");
    expect(screen.queryByLabelText("Пароль", { exact: true })).toBeNull();
    expect(calls.verify).not.toHaveBeenCalled();
    expect(verified).not.toHaveBeenCalled();
  });

  it("enforces the resend countdown and clears the previous code after resend", async () => {
    vi.useFakeTimers();
    render(<EmailVerification email="teacher@example.test" onVerified={vi.fn()} />);
    await act(async () => {});
    expect(screen.getByRole("button", { name: "Отправить ещё раз через 60 с" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Код из письма"), { target: { value: "123456" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    fireEvent.click(screen.getByRole("button", { name: "Отправить код ещё раз" }));
    await act(async () => {});
    expect(calls.send).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText("Код из письма")).toHaveValue("");
  });

  it("uses Retry-After from the server rather than assuming a one-minute block", async () => {
    vi.useFakeTimers();
    calls.send.mockImplementationOnce(async (_body: unknown, options: { onError: (context: { response: Response }) => void }) => {
      options.onError({ response: new Response(null, { status: 429, headers: { "Retry-After": "600" } }) });
      return { error: { status: 429 } };
    });
    render(<EmailVerification email="teacher@example.test" onVerified={vi.fn()} />);
    await act(async () => {});
    expect(screen.getByRole("alert")).toHaveTextContent("Слишком много запросов.");
    expect(screen.getByRole("button", { name: "Отправить ещё раз через 600 с" })).toBeDisabled();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(screen.getByRole("button", { name: "Отправить ещё раз через 540 с" })).toBeDisabled();
  });

  it("does not submit a code twice while verification is pending", async () => {
    let finish!: (value: { error: null }) => void;
    calls.verify.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const verified = vi.fn().mockResolvedValue(undefined);
    render(<EmailVerification email="teacher@example.test" onVerified={verified} />);
    await fillCode();
    const form = screen.getByLabelText("Код из письма").closest("form")!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(calls.verify).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("Код из письма")).toBeDisabled();
    await act(async () => { finish({ error: null }); });
    expect(verified).toHaveBeenCalledTimes(1);
  });
});
