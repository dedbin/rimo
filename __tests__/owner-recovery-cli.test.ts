// @vitest-environment node

import { execFile } from "node:child_process";

import { describe, expect, it } from "vitest";

async function command(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, ["--import=tsx", "scripts/recover-owner.ts", ...args], {
      cwd: process.cwd(), windowsHide: true, timeout: 10_000,
      env: { ...process.env, OWNER_RECOVERY_PASSWORD: "Synthetic private password 2026!" },
    }, (error, stdout, stderr) => resolve({ code: error ? Number(error.code) || 1 : 0, stdout, stderr }));
  });
}

describe("operator recovery CLI input boundaries", () => {
  it("offers help without SMTP or a database and does not echo the private password", async () => {
    const result = await command(["--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Код восстановления принимается только скрытым вводом");
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain("Synthetic private password");
  });

  it("refuses piped input before reading environment files or sending mail", async () => {
    const result = await command([]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("интерактивного терминала");
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toContain("Synthetic private password");
  });

  it("never accepts an email, code or password through command arguments", async () => {
    const result = await command(["--code", "synthetic-argument-secret"]);
    expect(result.code).toBe(1);
    expect(result.stderr).not.toContain("synthetic-argument-secret");
    expect(result.stdout).toBe("");
  });
});
