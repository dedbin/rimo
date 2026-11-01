import { emitKeypressEvents } from "node:readline";
import type { Key } from "node:readline";
import { createInterface } from "node:readline/promises";

import { getPool } from "../server/db";
import { beginOwnerRecovery, OwnerRecoveryError, validateRecoveryPassword } from "../server/owner-recovery";
import type { OwnerRecoveryChallenge } from "../server/owner-recovery";
import { loadEnvironment } from "./load-env";

function secretInput(label: string, maximum: number, signal: AbortSignal): Promise<string> {
  const input = process.stdin;
  if (!input.isTTY) throw new Error("TTY_REQUIRED");
  return new Promise((resolve, reject) => {
    let value = "";
    const previousRaw = input.isRaw;
    const cleanup = (): void => {
      clearTimeout(timer);
      input.removeListener("keypress", keypress);
      input.removeListener("end", abort);
      input.removeListener("error", abort);
      signal.removeEventListener("abort", abort);
      input.setRawMode(previousRaw);
      input.pause();
      process.stdout.write("\n");
    };
    const abort = (): void => { value = ""; cleanup(); reject(new Error("RECOVERY_CANCELLED")); };
    const keypress = (text: string | undefined, key: Key): void => {
      if (key.ctrl && ["c", "d"].includes(key.name ?? "")) { abort(); return; }
      if (key.name === "return" || key.name === "enter") {
        const result = value;
        value = "";
        cleanup();
        resolve(result);
        return;
      }
      if (key.name === "backspace") { value = Array.from(value).slice(0, -1).join(""); return; }
      if (!text || key.ctrl || key.meta || text.startsWith("\u001b")) return;
      value += text;
      if (value.length > maximum) { value = ""; cleanup(); reject(new Error("INPUT_TOO_LONG")); }
    };
    const timer = setTimeout(abort, 10 * 60 * 1_000);
    process.stdout.write(label);
    emitKeypressEvents(input);
    input.setRawMode(true);
    input.resume();
    input.on("keypress", keypress);
    input.once("end", abort);
    input.once("error", abort);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

async function main(): Promise<void> {
  if (process.argv.length === 3 && process.argv[2] === "--help") {
    process.stdout.write("Запускайте из корня Rimo: node --import=tsx scripts/recover-owner.ts\n" +
      "Почта: OWNER_EMAIL или запрос в терминале. Новый пароль: OWNER_RECOVERY_PASSWORD или скрытый ввод.\n" +
      "Код восстановления принимается только скрытым вводом в терминале, не через аргументы или файл.\n");
    return;
  }
  if (process.argv.length > 2 || !process.stdin.isTTY) {
    process.stderr.write("Восстановление требует интерактивного терминала и запуска без аргументов.\n");
    process.exitCode = 1;
    return;
  }
  loadEnvironment();
  const controller = new AbortController();
  let challenge: OwnerRecoveryChallenge | undefined;
  const interrupt = (): void => { controller.abort(); challenge?.cancel(); };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  let newPassword = process.env.OWNER_RECOVERY_PASSWORD;
  delete process.env.OWNER_RECOVERY_PASSWORD;
  let databaseUsed = false;
  try {
    if (newPassword !== undefined) validateRecoveryPassword(newPassword);
    let email = process.env.OWNER_EMAIL;
    if (!email) {
      const terminal = createInterface({ input: process.stdin, output: process.stdout });
      try { email = await terminal.question("Подтверждённая почта владельца: ", { signal: controller.signal }); }
      finally { terminal.close(); }
    }
    databaseUsed = true;
    challenge = await beginOwnerRecovery(email);
    process.stdout.write("Письмо восстановления отправлено на подтверждённую почту аккаунта. Код действует 10 минут; допускается 5 попыток.\n");
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = await secretInput("Код восстановления (ввод скрыт): ", 6, controller.signal);
      try { challenge.verify(code); break; }
      catch (error) {
        if (error instanceof OwnerRecoveryError && error.code === "INVALID_CODE") {
          process.stderr.write(`${error.message}\n`);
          continue;
        }
        throw error;
      }
    }
    if (newPassword === undefined) {
      newPassword = await secretInput("Новый пароль (12–128 символов, ввод скрыт): ", 128, controller.signal);
      validateRecoveryPassword(newPassword);
      const repeated = await secretInput("Повторите новый пароль (ввод скрыт): ", 128, controller.signal);
      if (newPassword !== repeated) throw new Error("PASSWORDS_DIFFER");
    }
    if (controller.signal.aborted) throw new Error("RECOVERY_CANCELLED");
    await challenge.complete(newPassword);
    process.stdout.write("Пароль изменён, все прежние сеансы завершены. Доски и права сохранены.\n");
  } catch (error) {
    const message = error instanceof OwnerRecoveryError ? error.message : "Восстановление не выполнено или отменено. Проверьте подключение и повторите процедуру.";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  } finally {
    challenge?.cancel();
    newPassword = undefined;
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    if (databaseUsed) await getPool().end();
  }
}

main().catch(() => {
  process.stderr.write("Восстановление не выполнено.\n");
  process.exitCode = 1;
});
