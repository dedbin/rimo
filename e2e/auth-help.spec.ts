import { expect, test } from "@playwright/test";

test("sign-in and registration expose the existing support contact", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] }, locale: "ru-RU" });
  try {
    const page = await context.newPage();
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Войти", exact: true }).first().click();
    const dialog = page.getByRole("dialog", { name: "Вход в Rimo" });
    await expect(dialog.getByRole("link", { name: "Забыли пароль? Написать в поддержку" }))
      .toHaveAttribute("href", "https://t.me/argtg_not_arctg");
    await dialog.getByRole("button", { name: "Нет аккаунта? Зарегистрироваться" }).click();
    await expect(page.getByRole("dialog", { name: "Регистрация в Rimo" })
      .getByRole("link", { name: "Помощь с регистрацией и входом" }))
      .toHaveAttribute("href", "https://t.me/argtg_not_arctg");
  } finally { await context.close(); }
});
