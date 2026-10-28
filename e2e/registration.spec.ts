import { randomBytes } from "node:crypto";

import { expect, test } from "@playwright/test";
import { Pool } from "pg";

import { openBoard } from "./board-ui";
import { waitForVerificationCode } from "./mailbox";

// Sign-up request bodies contain passwords; retain no Playwright trace for this test.
test.use({ trace: "off" });

test("registration verifies email, creates a private workspace and supports signing in again", async ({ browser, context, baseURL }, info) => {
  test.skip(Boolean(info.config.metadata.external), "Account cleanup requires the isolated local/CI database.");
  if (!baseURL || !process.env.DATABASE_URL) throw new Error("Local registration E2E requires its application database.");
  const runId = String(info.config.metadata.runId);
  if (!/^[a-f0-9-]{36}$/.test(runId)) throw new Error("Unexpected registration test namespace.");
  const email = `e2e-registration-${runId}@example.test`;
  const name = `Проверка регистрации ${runId.slice(0, 8)}`;
  const password = randomBytes(24).toString("base64url");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const fresh = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] }, locale: "ru-RU" });
  const origin = new URL(baseURL).origin;
  let registeredId: string | undefined;
  let existingOwnerBoardId: string | undefined;
  let registrationStarted = false;
  try {
    const preexisting = await pool.query('SELECT id FROM "user" WHERE email = $1', [email]);
    expect(preexisting.rowCount).toBe(0);
    const otherBoard = await context.request.post("/api/boards", { headers: { origin }, data: { title: `Private ${runId}` } });
    expect(otherBoard.status()).toBe(201);
    existingOwnerBoardId = (await otherBoard.json()).board.id;

    const page = await fresh.newPage();
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Регистрация", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Регистрация в Rimo" });
    await dialog.getByLabel("Имя", { exact: true }).fill(name);
    await dialog.getByLabel("Почта", { exact: true }).fill(email);
    await dialog.getByLabel("Пароль", { exact: true }).fill(password);
    await dialog.getByLabel("Повторите пароль", { exact: true }).fill(password);
    const registration = page.waitForResponse(response => new URL(response.url()).pathname === "/api/auth/sign-up/email" && response.request().method() === "POST");
    registrationStarted = true;
    const verificationRequestedAt = Date.now();
    await dialog.getByRole("button", { name: "Создать аккаунт", exact: true }).click();
    const response = await registration;
    expect(response.status()).toBe(200);
    const user = (await response.json()).user;
    if (typeof user?.id !== "string" || user.email !== email || user.name !== name) throw new Error("Registration returned an unexpected account.");
    registeredId = user.id;
    await expect(page.getByRole("heading", { name: "Подтвердите почту", exact: true })).toBeVisible();
    expect(await fresh.request.get("/api/auth/get-session").then(result => result.json())).toBeNull();
    const code = await waitForVerificationCode(email, verificationRequestedAt);
    await page.getByLabel("Код из письма", { exact: true }).fill(code);
    await page.getByRole("button", { name: "Подтвердить почту", exact: true }).click();
    await expect(page.getByRole("button", { name: "Создать доску", exact: true }).first()).toBeVisible();
    const session = await fresh.request.get("/api/auth/get-session");
    expect((await session.json()).user.id).toBe(registeredId);
    const privateBoard = await fresh.request.get(`/api/boards/${existingOwnerBoardId}`);
    expect(privateBoard.status()).toBe(404);

    const created = await fresh.request.post("/api/boards", { headers: { origin }, data: { title: `Моя новая доска ${runId}` } });
    expect(created.status()).toBe(201);
    const boardId = (await created.json()).board.id as string;
    await openBoard(page, boardId);
    const ownBoards = await fresh.request.get("/api/boards");
    const boards = (await ownBoards.json()).boards as { id: string }[];
    expect(boards.map(board => board.id)).toContain(boardId);
    expect(boards.map(board => board.id)).not.toContain(existingOwnerBoardId);

    const signedOut = await fresh.request.post("/api/auth/sign-out", { headers: { origin }, data: {} });
    expect(signedOut.status()).toBe(200);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Войти", exact: true }).first().click();
    const login = page.getByRole("dialog", { name: "Вход в Rimo" });
    await login.getByLabel("Почта", { exact: true }).fill(email);
    await login.getByLabel("Пароль", { exact: true }).fill(password);
    await login.getByRole("button", { name: "Войти", exact: true }).click();
    await expect(page.getByRole("button", { name: "Создать доску", exact: true }).first()).toBeVisible();
    await openBoard(page, boardId);
  } finally {
    const cleanupErrors: string[] = [];
    const attempt = async (label: string, operation: () => Promise<unknown>): Promise<void> => {
      try { await operation(); } catch { cleanupErrors.push(label); }
    };
    try {
      await attempt("Close registration context", () => fresh.close());
      if (existingOwnerBoardId) {
        await attempt("Delete this test's existing-owner board", async () => {
          const removed = await context.request.delete(`/api/boards/${existingOwnerBoardId}`, { headers: { origin } });
          if (![204, 404].includes(removed.status())) throw new Error("Board cleanup rejected.");
        });
      }
      // Guard every selector: never delete an existing owner or any other test's data.
      if (registeredId) {
        await attempt("Delete only the confirmed new account", async () => {
          const result = await pool.query(
            'DELETE FROM "user" WHERE email = $1 AND name = $2 AND "isAnonymous" = false AND id = $3',
            [email, name, registeredId],
          );
          if (result.rowCount !== 1) throw new Error("Account cleanup did not match exactly one owned row.");
        });
      } else if (registrationStarted) cleanupErrors.push("New account could not be confirmed; no account was deleted.");
    } finally { await attempt("Close database pool", () => pool.end()); }
    expect.soft(cleanupErrors, "All registration cleanup operations completed").toEqual([]);
  }
});
