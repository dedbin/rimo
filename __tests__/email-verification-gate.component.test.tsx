import "@testing-library/jest-dom/vitest";

import { useEffect } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EmailVerificationGate } from "@/components/auth/email-verification-gate";

const calls = vi.hoisted(() => ({ session: vi.fn(), refetch: vi.fn(), send: vi.fn(), verify: vi.fn(), signOut: vi.fn(), mount: vi.fn() }));
vi.mock("@/lib/auth-client", () => ({ authClient: {
  useSession: calls.session, signOut: calls.signOut,
  emailOtp: { sendVerificationOtp: calls.send, verifyEmail: calls.verify },
} }));
vi.mock("@/components/auth/loading", () => ({ Loading: () => <p>Загрузка</p> }));

function Children() {
  useEffect(() => { calls.mount(); }, []);
  return <p>Открытая доска</p>;
}

function session(user: { emailVerified: boolean; isAnonymous: boolean; registrationPending?: boolean } | null, isPending = false) {
  calls.session.mockReturnValue({
    data: user ? { user: { email: "teacher@example.test", ...user } } : null,
    isPending, error: null, refetch: calls.refetch,
  });
}

beforeEach(() => {
  calls.session.mockReset();
  calls.mount.mockReset();
  calls.refetch.mockReset().mockResolvedValue(undefined);
  calls.send.mockReset().mockResolvedValue({ error: null });
  calls.verify.mockReset().mockResolvedValue({ error: null });
  calls.signOut.mockReset().mockResolvedValue({ error: null });
  session({ emailVerified: false, isAnonymous: false });
});
afterEach(cleanup);

describe("EmailVerificationGate", () => {
  it("keeps board effects unmounted until the existing owner confirms email", async () => {
    const view = render(<EmailVerificationGate><Children /></EmailVerificationGate>);
    expect(screen.getByRole("heading", { name: "Подтвердите почту" })).toBeVisible();
    expect(calls.mount).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByLabelText("Код из письма")).toBeEnabled());
    fireEvent.change(screen.getByLabelText("Код из письма"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Подтвердить почту" }));
    await waitFor(() => expect(calls.refetch).toHaveBeenCalledTimes(1));
    expect(calls.mount).not.toHaveBeenCalled();
    session({ emailVerified: true, isAnonymous: false });
    view.rerender(<EmailVerificationGate><Children /></EmailVerificationGate>);
    expect(screen.getByText("Открытая доска")).toBeVisible();
    expect(calls.mount).toHaveBeenCalledTimes(1);
  });

  it("allows invited anonymous users with unverified synthetic email", () => {
    session({ emailVerified: false, isAnonymous: true });
    render(<EmailVerificationGate><Children /></EmailVerificationGate>);
    expect(screen.getByText("Открытая доска")).toBeVisible();
    expect(calls.send).not.toHaveBeenCalled();
  });

  it("blocks a pending registration even if its email flag is already true", async () => {
    session({ emailVerified: true, isAnonymous: false, registrationPending: true });
    render(<EmailVerificationGate><Children /></EmailVerificationGate>);
    expect(screen.getByRole("heading", { name: "Подтвердите почту" })).toBeVisible();
    expect(calls.mount).not.toHaveBeenCalled();
    await waitFor(() => expect(calls.send).toHaveBeenCalledTimes(1));
  });

  it("waits for session loading before mounting board effects", () => {
    session(null, true);
    render(<EmailVerificationGate fallback={<p>Загружаем доску</p>}><Children /></EmailVerificationGate>);
    expect(screen.getByText("Загружаем доску")).toBeVisible();
    expect(calls.mount).not.toHaveBeenCalled();
  });

  it("allows signing out from the mandatory confirmation screen", async () => {
    render(<EmailVerificationGate><Children /></EmailVerificationGate>);
    await waitFor(() => expect(screen.getByRole("button", { name: "Выйти из аккаунта" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Выйти из аккаунта" }));
    await waitFor(() => expect(calls.signOut).toHaveBeenCalledTimes(1));
    expect(calls.refetch).toHaveBeenCalledTimes(1);
  });

  it("offers retry when session refresh fails", () => {
    calls.session.mockReturnValue({ data: null, isPending: false, error: new Error("offline"), refetch: calls.refetch });
    render(<EmailVerificationGate><Children /></EmailVerificationGate>);
    expect(screen.getByRole("alert")).toHaveTextContent("Не удалось проверить вход.");
    expect(calls.mount).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    expect(calls.refetch).toHaveBeenCalledTimes(1);
  });
});
