import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppGate } from "@/components/auth/app-gate";

const calls = vi.hoisted(() => ({ session: vi.fn(), refetch: vi.fn(), signUp: vi.fn(), signIn: vi.fn(), send: vi.fn(), verify: vi.fn() }));
vi.mock("@/lib/auth-client", () => ({ authClient: {
  useSession: calls.session, signUp: { email: calls.signUp }, signIn: { email: calls.signIn },
  emailOtp: { sendVerificationOtp: calls.send, verifyEmail: calls.verify },
} }));
vi.mock("@/components/auth/loading", () => ({ Loading: () => <p>Проверяем сессию</p> }));
vi.mock("@/components/landing-navbar", async () => {
  const { AuthButton } = await import("@/components/auth/auth-button");
  return { RimoNavbar: () => <AuthButton initialMode="sign-up"><button>Регистрация</button></AuthButton> };
});
vi.mock("@/components/landing-hero", () => ({ RimoHero: () => null }));
vi.mock("@/components/landing-content", () => ({ RimoContent: () => null }));
vi.mock("@/components/landing-footer", () => ({ RimoFooter: () => null }));

function session(user: { emailVerified: boolean; isAnonymous: boolean } | null, isPending = false): void {
  calls.session.mockReturnValue({ data: user ? { user: { email: "teacher@example.test", ...user } } : null,
    isPending, error: null, refetch: calls.refetch });
}

beforeEach(() => {
  for (const mock of [calls.refetch, calls.signUp, calls.signIn, calls.send, calls.verify]) {
    mock.mockReset().mockResolvedValue({ error: null });
  }
  calls.session.mockReset();
  session(null, true);
});
afterEach(cleanup);

describe("AppGate session refresh", () => {
  it("keeps the OTP form and in-memory password through a background null-session refetch", async () => {
    const view = render(<AppGate><p>Доски владельца</p></AppGate>);
    expect(screen.getByText("Проверяем сессию")).toBeVisible();
    session(null);
    view.rerender(<AppGate><p>Доски владельца</p></AppGate>);
    fireEvent.click(screen.getByRole("button", { name: "Регистрация" }));
    const password = "synthetic registration password!";
    fireEvent.change(screen.getByLabelText("Имя", { exact: true }), { target: { value: "Преподаватель" } });
    fireEvent.change(screen.getByLabelText("Почта", { exact: true }), { target: { value: "teacher@example.test" } });
    fireEvent.change(screen.getByLabelText("Пароль", { exact: true }), { target: { value: password } });
    fireEvent.change(screen.getByLabelText("Повторите пароль"), { target: { value: password } });
    fireEvent.click(screen.getByRole("button", { name: "Создать аккаунт" }));
    await screen.findByRole("heading", { name: "Подтвердите почту" });
    await waitFor(() => expect(screen.getByLabelText("Код из письма")).toBeEnabled());
    const input = screen.getByLabelText("Код из письма");
    fireEvent.change(input, { target: { value: "001234" } });

    session(null, true);
    view.rerender(<AppGate><p>Доски владельца</p></AppGate>);
    expect(screen.queryByText("Проверяем сессию")).toBeNull();
    expect(screen.getByLabelText("Код из письма")).toBe(input);
    expect(input).toHaveValue("001234");
    session(null);
    view.rerender(<AppGate><p>Доски владельца</p></AppGate>);
    expect(screen.getByLabelText("Код из письма")).toBe(input);
    expect(calls.send).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Подтвердить почту" }));
    await waitFor(() => expect(calls.signIn).toHaveBeenCalledExactlyOnceWith({ email: "teacher@example.test", password }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("removes protected content immediately when an existing session disappears", () => {
    session({ emailVerified: true, isAnonymous: false });
    const view = render(<AppGate><p>Доски владельца</p></AppGate>);
    expect(screen.getByText("Доски владельца")).toBeVisible();
    session(null, true);
    view.rerender(<AppGate><p>Доски владельца</p></AppGate>);
    expect(screen.queryByText("Доски владельца")).toBeNull();
    expect(screen.getByRole("button", { name: "Регистрация" })).toBeVisible();
  });
});
