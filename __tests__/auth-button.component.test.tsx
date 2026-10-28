import "@testing-library/jest-dom/vitest";

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AuthButton } from "@/components/auth/auth-button";

const calls = vi.hoisted(() => ({ signIn: vi.fn(), signUp: vi.fn(), send: vi.fn(), verify: vi.fn() }));
vi.mock("@/lib/auth-client", () => ({
  authClient: {
    signIn: { email: calls.signIn }, signUp: { email: calls.signUp },
    emailOtp: { sendVerificationOtp: calls.send, verifyEmail: calls.verify },
  },
}));

type AuthResult = { error: { code?: string; status?: number } | null };
const password = "  synthetic password 2026!  ";

function open(initialMode: "sign-in" | "sign-up" = "sign-up"): void {
  render(<AuthButton initialMode={initialMode}><button>Открыть</button></AuthButton>);
  fireEvent.click(screen.getByRole("button", { name: "Открыть" }));
}

function fillSignUp(confirmPassword = password): HTMLFormElement {
  fireEvent.change(screen.getByLabelText("Имя", { exact: true }), { target: { value: "  Учитель  " } });
  fireEvent.change(screen.getByLabelText("Почта", { exact: true }), { target: { value: " teacher@example.test " } });
  fireEvent.change(screen.getByLabelText("Пароль", { exact: true }), { target: { value: password } });
  fireEvent.change(screen.getByLabelText("Повторите пароль", { exact: true }), { target: { value: confirmPassword } });
  return screen.getByRole("dialog").querySelector("form")!;
}

beforeEach(() => {
  calls.signIn.mockReset().mockResolvedValue({ error: null });
  calls.signUp.mockReset().mockResolvedValue({ error: null });
  calls.send.mockReset().mockResolvedValue({ error: null });
  calls.verify.mockReset().mockResolvedValue({ error: null });
});
afterEach(cleanup);

describe("AuthButton", () => {
  it("lets an existing user switch to registration and back without submitting", () => {
    open("sign-in");
    expect(screen.getByRole("heading", { name: "Вход в Rimo" })).toBeVisible();
    expect(screen.queryByLabelText("Имя", { exact: true })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Нет аккаунта? Зарегистрироваться" }));
    expect(screen.getByRole("heading", { name: "Регистрация в Rimo" })).toBeVisible();
    expect(screen.getByLabelText("Имя", { exact: true })).toBeVisible();
    expect(screen.getByLabelText("Повторите пароль", { exact: true })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Уже есть аккаунт? Войти" }));
    expect(screen.getByRole("heading", { name: "Вход в Rimo" })).toBeVisible();
    expect(screen.queryByLabelText("Повторите пароль", { exact: true })).toBeNull();
    expect(calls.signIn).not.toHaveBeenCalled();
    expect(calls.signUp).not.toHaveBeenCalled();
  });

  it("rejects mismatched passwords before creating an account", () => {
    open();
    fireEvent.submit(fillSignUp("different synthetic password"));
    expect(screen.getByRole("alert")).toHaveTextContent("Пароли не совпадают.");
    expect(calls.signUp).not.toHaveBeenCalled();
    expect(calls.signIn).not.toHaveBeenCalled();
  });

  it("registers, confirms the email and signs in with the in-memory password", async () => {
    open();
    fireEvent.submit(fillSignUp());
    await waitFor(() => expect(screen.getByRole("heading", { name: "Подтвердите почту" })).toBeVisible());
    expect(calls.signUp).toHaveBeenCalledExactlyOnceWith({
      name: "Учитель", email: "teacher@example.test", password,
    });
    expect(calls.signIn).not.toHaveBeenCalled();
    await waitFor(() => expect(calls.send).toHaveBeenCalledTimes(1));
    expect(calls.send).toHaveBeenCalledWith({ email: "teacher@example.test", type: "email-verification" }, expect.any(Object));
    await waitFor(() => expect(screen.getByLabelText("Код из письма")).toBeEnabled());
    fireEvent.change(screen.getByLabelText("Код из письма"), { target: { value: "001234" } });
    fireEvent.click(screen.getByRole("button", { name: "Подтвердить почту" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls.verify).toHaveBeenCalledWith({ email: "teacher@example.test", otp: "001234" }, expect.any(Object));
    expect(calls.signIn).toHaveBeenCalledExactlyOnceWith({ email: "teacher@example.test", password });
  });

  it("preserves existing email sign-in and closes after authentication", async () => {
    open("sign-in");
    fireEvent.change(screen.getByLabelText("Почта", { exact: true }), { target: { value: " teacher@example.test " } });
    fireEvent.change(screen.getByLabelText("Пароль", { exact: true }), { target: { value: password } });
    fireEvent.click(screen.getByRole("button", { name: /^Войти$/ }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls.signIn).toHaveBeenCalledExactlyOnceWith({ email: "teacher@example.test", password });
    expect(calls.signUp).not.toHaveBeenCalled();
  });

  it.each([
    [{ code: "OWNER_LIMIT_REACHED", status: 409 }, "Свободных аккаунтов пока нет. Обратитесь к владельцу сервиса."],
    [{ status: 429 }, "Слишком много попыток. Попробуйте через минуту."],
  ])("explains a registration rejection and lets the user retry: %j", async (error, message) => {
    calls.signUp.mockResolvedValueOnce({ error });
    open();
    fireEvent.submit(fillSignUp());
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(screen.getByRole("button", { name: "Создать аккаунт" })).toBeEnabled();
    expect(screen.getByLabelText("Почта", { exact: true })).toHaveValue("teacher@example.test");
    expect(screen.getByRole("dialog")).toBeVisible();
  });

  it("blocks repeat submission and mode changes until the pending request finishes", async () => {
    let finish!: (result: AuthResult) => void;
    calls.signUp.mockImplementationOnce(() => new Promise<AuthResult>((resolve) => { finish = resolve; }));
    open();
    const form = fillSignUp();
    fireEvent.submit(form);
    expect(screen.getByRole("button", { name: "Создаём аккаунт…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Уже есть аккаунт? Войти" })).toBeDisabled();
    expect(screen.getByLabelText("Почта", { exact: true })).toBeDisabled();
    fireEvent.submit(form);
    expect(calls.signUp).toHaveBeenCalledTimes(1);
    await act(async () => { finish({ error: null }); });
    await waitFor(() => expect(screen.getByRole("heading", { name: "Подтвердите почту" })).toBeVisible());
  });

  it("resumes confirmation when sign-in reports an unverified email", async () => {
    calls.signIn.mockResolvedValueOnce({ error: { code: "EMAIL_NOT_VERIFIED", status: 403 } });
    open("sign-in");
    fireEvent.change(screen.getByLabelText("Почта", { exact: true }), { target: { value: "teacher@example.test" } });
    fireEvent.change(screen.getByLabelText("Пароль", { exact: true }), { target: { value: password } });
    fireEvent.click(screen.getByRole("button", { name: /^Войти$/ }));
    await screen.findByRole("heading", { name: "Подтвердите почту" });
    await waitFor(() => expect(screen.getByLabelText("Код из письма")).toBeEnabled());
    fireEvent.change(screen.getByLabelText("Код из письма"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Подтвердить почту" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls.signIn).toHaveBeenCalledTimes(2);
    expect(calls.signUp).not.toHaveBeenCalled();
  });

  it("returns to sign-in after confirmation if the password needs to be entered again", async () => {
    calls.signIn.mockResolvedValueOnce({ error: { code: "INVALID_EMAIL_OR_PASSWORD", status: 401 } });
    open();
    fireEvent.submit(fillSignUp());
    await screen.findByRole("heading", { name: "Подтвердите почту" });
    await waitFor(() => expect(screen.getByLabelText("Код из письма")).toBeEnabled());
    fireEvent.change(screen.getByLabelText("Код из письма"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Подтвердить почту" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Почта подтверждена. Войдите с паролем своего аккаунта.");
    expect(screen.getByRole("heading", { name: "Вход в Rimo" })).toBeVisible();
    expect(screen.getByLabelText("Почта", { exact: true })).toHaveValue("teacher@example.test");
    expect(screen.getByLabelText("Пароль", { exact: true })).toHaveValue("");
  });

  it("drops the password when leaving and reopening the confirmation flow", async () => {
    open();
    fireEvent.submit(fillSignUp());
    await screen.findByRole("heading", { name: "Подтвердите почту" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Вернуться к форме" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Вернуться к форме" }));
    expect(screen.getByLabelText("Пароль", { exact: true })).toHaveValue("");
    expect(calls.signIn).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });
});
