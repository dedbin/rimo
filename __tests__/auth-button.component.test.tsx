import "@testing-library/jest-dom/vitest";

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AuthButton } from "@/components/auth/auth-button";

const calls = vi.hoisted(() => ({ signIn: vi.fn(), signUp: vi.fn() }));
vi.mock("@/lib/auth-client", () => ({
  authClient: { signIn: { email: calls.signIn }, signUp: { email: calls.signUp } },
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

  it("registers with trimmed profile fields, preserves the password and closes on success", async () => {
    open();
    fireEvent.submit(fillSignUp());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls.signUp).toHaveBeenCalledExactlyOnceWith({
      name: "Учитель", email: "teacher@example.test", password,
    });
    expect(calls.signIn).not.toHaveBeenCalled();
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
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
