import { expect, test as base } from "@playwright/test";
import type { Page } from "@playwright/test";

import { canvas, saved } from "./board-ui";

interface BoardResponse { board?: { id?: string } }
interface Scenario {
  readonly createdBoards: Set<string>;
  createBoard: (title: string) => Promise<string>;
  guest: (url: string, name: string) => Promise<Page>;
}

export const test = base.extend<{ scenario: Scenario }>({
  scenario: async ({ context, browser, baseURL }, runTest, info) => {
    if (!baseURL) throw new Error("E2E base URL is required");
    const origin = new URL(baseURL).origin;
    const createdBoards = new Set<string>();
    const captures: Promise<void>[] = [];
    const awaitingCreation = new Set<Page>();
    const guests: Awaited<ReturnType<typeof browser.newContext>>[] = [];
    const errors: string[] = [];
    const watch = (page: Page): void => {
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("framenavigated", (frame) => {
        if (frame !== page.mainFrame() || !awaitingCreation.has(page)) return;
        const url = new URL(frame.url());
        const match = /^\/board\/([a-f0-9-]{36})$/.exec(url.pathname);
        if (url.origin === origin && match) { createdBoards.add(match[1]); awaitingCreation.delete(page); }
      });
    };
    context.on("page", watch);
    context.pages().forEach(watch);
    context.on("response", (response) => {
      const url = new URL(response.url());
      if (url.origin !== origin || !["/api/boards", "/api/boards/import"].includes(url.pathname) || response.request().method() !== "POST" || response.status() !== 201) return;
      const page = response.frame().page();
      awaitingCreation.add(page);
      captures.push(response.json().then((body: BoardResponse) => {
        if (body.board?.id) { createdBoards.add(body.board.id); awaitingCreation.delete(page); }
      }).catch(() => undefined));
    });
    const scenario: Scenario = {
      createdBoards,
      createBoard: async (title) => {
        const response = await context.request.post("/api/boards", { headers: { origin }, data: { title } });
        expect(response.status()).toBe(201);
        const body = await response.json() as BoardResponse;
        if (!body.board?.id) throw new Error("Create board returned no ID");
        createdBoards.add(body.board.id);
        return body.board.id;
      },
      guest: async (url, name) => {
        const guest = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] }, locale: "ru-RU", viewport: { width: 1440, height: 1000 } });
        guests.push(guest);
        guest.on("page", watch);
        const page = await guest.newPage();
        await page.goto(url, { waitUntil: "domcontentloaded" });
        await page.getByLabel("Как вас представить", { exact: true }).fill(name);
        await page.getByRole("button", { name: "Войти на доску", exact: true }).click();
        await expect(canvas(page)).toBeVisible();
        await saved(page);
        return page;
      },
    };
    try { await runTest(scenario); }
    finally {
      const cleanupErrors: string[] = [];
      const attempt = async (label: string, operation: () => Promise<unknown>): Promise<void> => {
        try { await operation(); }
        catch { cleanupErrors.push(label); }
      };
      await Promise.all(guests.map((guest, index) => attempt(`Close guest context ${index + 1}`, () => guest.close())));
      await Promise.all(captures.map((capture, index) => attempt(`Complete board capture ${index + 1}`, () => capture)));
      await Promise.all([...createdBoards].reverse().map((id) => attempt(`Delete test board ${id}`, async () => {
        const response = await context.request.delete(`/api/boards/${id}`, { headers: { origin } });
        if (![204, 404].includes(response.status())) cleanupErrors.push(`Delete test board ${id}: HTTP ${response.status()}`);
      })));
      if (info.status !== info.expectedStatus || cleanupErrors.length) {
        await attempt("Attach created board IDs", () => info.attach("created-boards", { body: JSON.stringify([...createdBoards]), contentType: "application/json" }));
      }
      if (errors.length) await attempt("Attach browser error evidence", () => info.attach("page-errors", { body: JSON.stringify(errors, null, 2), contentType: "application/json" }));
      if (cleanupErrors.length) await attempt("Attach cleanup summary", () => info.attach("cleanup-errors", { body: JSON.stringify(cleanupErrors), contentType: "application/json" }));
      expect.soft(cleanupErrors, "All E2E cleanup operations completed").toEqual([]);
      expect.soft(errors, "No uncaught browser errors").toEqual([]);
    }
  },
});
export { expect } from "@playwright/test";
