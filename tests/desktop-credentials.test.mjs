import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createBinanceCredentialVault } from "../desktop/binance-credential-vault.mjs";
import { createDesktopRepository } from "../desktop/database.mjs";

function createSafeStorage(available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString(value) {
      return Buffer.from(value, "utf8").map((byte) => byte ^ 0x5a);
    },
    decryptString(value) {
      return Buffer.from(value).map((byte) => byte ^ 0x5a).toString("utf8");
    },
  };
}

test("API 密钥只以系统加密密文写入 SQLite，loadState 不会返回凭证", () => {
  const directory = mkdtempSync(join(tmpdir(), "cryptoreview-credentials-"));
  const databasePath = join(directory, "cryptoreview.sqlite");
  const repository = createDesktopRepository(databasePath);
  const vault = createBinanceCredentialVault({
    repository,
    safeStorage: createSafeStorage(),
    randomUUID: () => "account-uuid",
    now: () => 1784189000000,
  });

  try {
    const status = vault.save({ apiKey: "my-api-key", apiSecret: "my-super-secret", accountAlias: "SgsR" });
    assert.deepEqual(status, {
      configured: true,
      apiKeyHint: "…-key",
      lastSyncedAt: null,
      updatedAt: 1784189000000,
    });
    const storedCredentials = vault.read();
    assert.match(storedCredentials.accountId, /^binance-usdm:[a-f0-9]{64}$/);
    assert.deepEqual(
      { apiKey: storedCredentials.apiKey, apiSecret: storedCredentials.apiSecret },
      { apiKey: "my-api-key", apiSecret: "my-super-secret" },
    );
    assert.deepEqual(repository.loadState(), {
      orders: [],
      trades: [],
      openPositions: [],
      trainingResults: [],
      profiles: [],
    });
  } finally {
    repository.close();
  }

  const rawDatabase = readFileSync(databasePath);
  assert.equal(rawDatabase.includes(Buffer.from("my-api-key")), false);
  assert.equal(rawDatabase.includes(Buffer.from("my-super-secret")), false);
  rmSync(directory, { recursive: true, force: true });
});

test("系统加密不可用时拒绝明文降级，删除后不再返回密钥", () => {
  const repository = createDesktopRepository(":memory:");
  try {
    const unavailableVault = createBinanceCredentialVault({
      repository,
      safeStorage: createSafeStorage(false),
    });
    assert.throws(
      () => unavailableVault.save({ apiKey: "key", apiSecret: "secret", accountAlias: "SgsR" }),
      /系统安全存储不可用/,
    );

    const vault = createBinanceCredentialVault({
      repository,
      safeStorage: createSafeStorage(),
      randomUUID: () => "account-uuid",
    });
    vault.save({ apiKey: "key", apiSecret: "secret", accountAlias: "SgsR" });
    vault.remove();
    assert.deepEqual(vault.getStatus(), {
      configured: false,
      apiKeyHint: null,
      lastSyncedAt: null,
      updatedAt: null,
    });
    assert.throws(() => vault.read(), /尚未连接/);
  } finally {
    repository.close();
  }
});

test("同一 Binance 账户断开并更换 API Key 后仍复用稳定账户标识", () => {
  const repository = createDesktopRepository(":memory:");
  let uuidIndex = 0;
  const vault = createBinanceCredentialVault({
    repository,
    safeStorage: createSafeStorage(),
    randomUUID: () => `random-account-${++uuidIndex}`,
  });

  try {
    vault.save({ apiKey: "first-key", apiSecret: "first-secret", accountAlias: "SgsR" });
    const firstAccountId = vault.read().accountId;
    vault.remove();
    vault.save({ apiKey: "replacement-key", apiSecret: "replacement-secret", accountAlias: "SgsR" });
    const replacementAccountId = vault.read().accountId;
    vault.remove();
    vault.save({ apiKey: "another-account-key", apiSecret: "another-secret", accountAlias: "A9xQ" });
    const otherAccountId = vault.read().accountId;

    assert.equal(replacementAccountId, firstAccountId);
    assert.notEqual(otherAccountId, firstAccountId);
  } finally {
    repository.close();
  }
});
