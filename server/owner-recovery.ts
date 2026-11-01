import { createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { performance } from "node:perf_hooks";

import { hashPassword } from "better-auth/crypto";
import type { Pool } from "pg";
import { z } from "zod";

import { acquireCredentialLock } from "./credential-lock";
import { getPool } from "./db";
import { HttpError } from "./http-error";
import { sendOwnerRecoveryCode } from "./mail";

const VALID_FOR_MS = 10 * 60 * 1_000;
const MAX_ATTEMPTS = 5;

export type OwnerRecoveryErrorCode = "INVALID_EMAIL" | "ACCOUNT_INELIGIBLE" | "DELIVERY_FAILED" |
  "INVALID_CODE" | "ATTEMPTS_EXHAUSTED" | "CHALLENGE_EXPIRED" | "CHALLENGE_UNAVAILABLE" |
  "PROOF_REQUIRED" | "PASSWORD_INVALID" | "ACCOUNT_CHANGED" | "CREDENTIAL_OPERATION_BUSY";

export class OwnerRecoveryError extends Error {
  constructor(readonly code: OwnerRecoveryErrorCode, message: string) {
    super(message);
    this.name = "OwnerRecoveryError";
  }
}

interface OwnerAccount {
  readonly userId: string;
  readonly accountId: string | null;
  readonly email: string;
  readonly password: string | null;
  readonly emailVerified: boolean;
  readonly isAnonymous: boolean;
  readonly registrationPending: boolean;
}

interface EligibleAccount extends OwnerAccount {
  readonly accountId: string;
  readonly password: string;
}

const ACCOUNT_QUERY = `SELECT u.id AS "userId", a.id AS "accountId", lower(u.email) AS email,
  a.password, u."emailVerified", u."isAnonymous", u."registrationPending"
  FROM "user" u LEFT JOIN account a ON a."userId"=u.id AND a."providerId"='credential'`;

function eligible(account: OwnerAccount | undefined): account is EligibleAccount {
  return !!account && account.emailVerified && !account.isAnonymous && !account.registrationPending &&
    typeof account.accountId === "string" && typeof account.password === "string" && account.password.length > 0;
}

interface RecoveryState {
  readonly account: EligibleAccount;
  readonly createdAt: number;
  readonly key: Buffer;
  readonly digest: Buffer;
  attempts: number;
  verified: boolean;
}

export interface OwnerRecoveryChallenge {
  verify(code: string): void;
  complete(newPassword: string): Promise<void>;
  cancel(): void;
}

interface RecoveryOptions {
  readonly database?: Pool;
  readonly sendCode?: (email: string, code: string) => Promise<void>;
  readonly now?: () => number;
}

export function validateRecoveryPassword(password: string): void {
  if (typeof password !== "string" || password.length < 12 || password.length > 128) {
    throw new OwnerRecoveryError("PASSWORD_INVALID", "Новый пароль должен содержать от 12 до 128 символов.");
  }
}

async function replaceCredential(database: Pool, account: EligibleAccount, password: string, valid: () => void): Promise<void> {
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    await acquireCredentialLock(client, account.email);
    // Lock both identities and recheck the exact credential version after hashing.
    const current = await client.query<OwnerAccount>(
      `${ACCOUNT_QUERY.replace("LEFT JOIN", "JOIN")} WHERE u.id=$1 AND a.id=$2 FOR UPDATE OF u, a`,
      [account.userId, account.accountId],
    );
    const row = current.rows[0];
    if (current.rows.length !== 1 || !eligible(row) || row.email !== account.email || row.password !== account.password) {
      throw new OwnerRecoveryError("ACCOUNT_CHANGED", "Данные аккаунта изменились. Начните восстановление заново.");
    }
    valid();
    await client.query('UPDATE account SET password=$1, "updatedAt"=now() WHERE id=$2 AND "userId"=$3',
      [password, account.accountId, account.userId]);
    await client.query('DELETE FROM session WHERE "userId"=$1', [account.userId]);
    valid();
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (error instanceof HttpError && error.code === "CREDENTIAL_OPERATION_BUSY") {
      throw new OwnerRecoveryError("CREDENTIAL_OPERATION_BUSY", "Выполняется вход или смена пароля. Начните восстановление заново через несколько секунд.");
    }
    throw error;
  } finally { client.release(); }
}

export async function beginOwnerRecovery(email: string, options: RecoveryOptions = {}): Promise<OwnerRecoveryChallenge> {
  const normalized = typeof email === "string" ? email.trim().toLowerCase() : "";
  if (normalized.length > 254 || !z.email().safeParse(normalized).success) {
    throw new OwnerRecoveryError("INVALID_EMAIL", "Укажите действующий адрес почты владельца.");
  }
  const database = options.database ?? getPool();
  const result = await database.query<OwnerAccount>(`${ACCOUNT_QUERY} WHERE lower(u.email)=$1`, [normalized]);
  const account = result.rows[0];
  if (result.rows.length !== 1 || !eligible(account)) {
    throw new OwnerRecoveryError("ACCOUNT_INELIGIBLE", "Нужен существующий подтверждённый аккаунт владельца с паролем.");
  }
  const now = options.now ?? (() => performance.now());
  const key = randomBytes(32);
  const code = String(randomInt(1_000_000)).padStart(6, "0");
  let state: RecoveryState | null = {
    account: { ...account }, key, digest: createHmac("sha256", key).update(code).digest(),
    createdAt: now(), attempts: 0, verified: false,
  };
  let cancelled = false;
  const clear = (): void => {
    state?.key.fill(0);
    state?.digest.fill(0);
    state = null;
  };
  const cancel = (): void => { cancelled = true; clear(); };
  const assertFresh = (createdAt: number): void => {
    const age = now() - createdAt;
    if (age < 0 || age >= VALID_FOR_MS) {
      cancel();
      throw new OwnerRecoveryError("CHALLENGE_EXPIRED", "Срок действия кода истёк. Начните восстановление заново.");
    }
  };
  const current = (): RecoveryState => {
    if (!state) throw new OwnerRecoveryError("CHALLENGE_UNAVAILABLE", "Восстановление завершено или отменено. Начните заново.");
    assertFresh(state.createdAt);
    return state;
  };
  try { await (options.sendCode ?? sendOwnerRecoveryCode)(account.email, code); }
  catch {
    cancel();
    throw new OwnerRecoveryError("DELIVERY_FAILED", "Не удалось отправить письмо восстановления. Пароль не изменён.");
  }
  return Object.freeze({
    verify(input: string): void {
      const value = current();
      if (value.verified) throw new OwnerRecoveryError("CHALLENGE_UNAVAILABLE", "Код уже проверен. Продолжите установку пароля.");
      value.attempts += 1;
      const candidate = createHmac("sha256", value.key).update(/^\d{6}$/.test(input) ? input : "").digest();
      const matches = timingSafeEqual(candidate, value.digest);
      candidate.fill(0);
      if (!matches) {
        if (value.attempts >= MAX_ATTEMPTS) {
          cancel();
          throw new OwnerRecoveryError("ATTEMPTS_EXHAUSTED", "Пять попыток исчерпаны. Начните восстановление заново.");
        }
        throw new OwnerRecoveryError("INVALID_CODE", "Код не подошёл. Проверьте письмо восстановления.");
      }
      value.verified = true;
      value.key.fill(0);
      value.digest.fill(0);
    },
    async complete(newPassword: string): Promise<void> {
      const value = current();
      if (!value.verified) throw new OwnerRecoveryError("PROOF_REQUIRED", "Сначала подтвердите код из письма восстановления.");
      validateRecoveryPassword(newPassword);
      // Consume before awaiting to prevent reuse/concurrent completion of this proof.
      clear();
      const password = await hashPassword(newPassword);
      const valid = (): void => {
        if (cancelled) throw new OwnerRecoveryError("CHALLENGE_UNAVAILABLE", "Восстановление отменено. Пароль не изменён.");
        assertFresh(value.createdAt);
      };
      valid();
      await replaceCredential(database, value.account, password, valid);
    },
    cancel,
  });
}
