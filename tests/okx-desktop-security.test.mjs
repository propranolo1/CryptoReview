import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createBinanceCredentialVault } from "../desktop/binance-credential-vault.mjs";
import { createDesktopRepository } from "../desktop/database.mjs";
import { createOkxApiService } from "../desktop/okx-api-service.mjs";
import { createOkxCredentialVault } from "../desktop/okx-credential-vault.mjs";

function createSafeStorage(available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString(value) {
      return Buffer.from(value, "utf8").map((byte) => byte ^ 0x37);
    },
    decryptString(value) {
      return Buffer.from(value).map((byte) => byte ^ 0x37).toString("utf8");
    },
  };
}

test("OKX Key、Secret、Passphrase、UID 与 region 全部只存在于系统密文中", () => {
  const directory = mkdtempSync(join(tmpdir(), "cryptoreview-okx-credentials-"));
  const databasePath = join(directory, "cryptoreview.sqlite");
  const repository = createDesktopRepository(databasePath);
  const vault = createOkxCredentialVault({
    repository,
    safeStorage: createSafeStorage(),
    now: () => 1785300000000,
  });
  const credentials = {
    apiKey: "okx-api-key-sensitive",
    apiSecret: "okx-api-secret-sensitive",
    passphrase: "okx-passphrase-sensitive",
    accountUid: "okx-account-uid-sensitive",
    region: "global",
  };

  try {
    assert.deepEqual(vault.save(credentials), {
      configured: true,
      apiKeyHint: "已配置",
      lastSyncedAt: null,
      updatedAt: 1785300000000,
    });
    const stored = vault.read();
    assert.match(stored.accountId, /^okx-swap:[a-f0-9]{64}$/);
    assert.deepEqual(
      {
        apiKey: stored.apiKey,
        apiSecret: stored.apiSecret,
        passphrase: stored.passphrase,
        accountUid: stored.accountUid,
        region: stored.region,
      },
      credentials,
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
  for (const value of Object.values(credentials)) {
    assert.equal(rawDatabase.includes(Buffer.from(value)), false, `${value} 不应以明文写入 SQLite`);
  }
  rmSync(directory, { recursive: true, force: true });
});

test("OKX 与 Binance 凭据按 provider 共存，删除 OKX 不影响 Binance", () => {
  const repository = createDesktopRepository(":memory:");
  const safeStorage = createSafeStorage();
  const binanceVault = createBinanceCredentialVault({ repository, safeStorage });
  const okxVault = createOkxCredentialVault({ repository, safeStorage });

  try {
    binanceVault.save({
      apiKey: "binance-key",
      apiSecret: "binance-secret",
      accountAlias: "binance-alias",
    });
    okxVault.save({
      apiKey: "okx-key",
      apiSecret: "okx-secret",
      passphrase: "okx-passphrase",
      accountUid: "okx-uid",
      region: "global",
    });

    assert.equal(binanceVault.getStatus().configured, true);
    assert.equal(okxVault.getStatus().configured, true);
    okxVault.remove();
    assert.equal(okxVault.getStatus().configured, false);
    assert.equal(binanceVault.getStatus().configured, true);
    assert.equal(binanceVault.read().apiKey, "binance-key");
  } finally {
    repository.close();
  }
});

test("OKX 稳定账户标识由 UID 与 region 决定，换 Key 不重复账户", () => {
  const repository = createDesktopRepository(":memory:");
  const vault = createOkxCredentialVault({
    repository,
    safeStorage: createSafeStorage(),
  });

  try {
    vault.save({
      apiKey: "first-key",
      apiSecret: "first-secret",
      passphrase: "first-passphrase",
      accountUid: "same-uid",
      region: "global",
    });
    const firstAccountId = vault.read().accountId;
    vault.save({
      apiKey: "replacement-key",
      apiSecret: "replacement-secret",
      passphrase: "replacement-passphrase",
      accountUid: "same-uid",
      region: "global",
    });
    assert.equal(vault.read().accountId, firstAccountId);

    vault.save({
      apiKey: "region-key",
      apiSecret: "region-secret",
      passphrase: "region-passphrase",
      accountUid: "same-uid",
      region: "eea",
    });
    assert.notEqual(vault.read().accountId, firstAccountId);
  } finally {
    repository.close();
  }
});

test("OKX region 支持 EEA，省略时默认使用 global", () => {
  const repository = createDesktopRepository(":memory:");
  const vault = createOkxCredentialVault({
    repository,
    safeStorage: createSafeStorage(),
  });
  try {
    vault.save({
      apiKey: "default-key",
      apiSecret: "default-secret",
      passphrase: "default-passphrase",
      accountUid: "default-uid",
    });
    assert.equal(vault.read().region, "global");

    vault.save({
      apiKey: "eea-key",
      apiSecret: "eea-secret",
      passphrase: "eea-passphrase",
      accountUid: "eea-uid",
      region: "eea",
    });
    assert.equal(vault.read().region, "eea");
  } finally {
    repository.close();
  }
});

test("系统安全存储不可用时 OKX 拒绝明文降级", () => {
  const repository = createDesktopRepository(":memory:");
  const vault = createOkxCredentialVault({
    repository,
    safeStorage: createSafeStorage(false),
  });
  try {
    assert.throws(
      () => vault.save({
        apiKey: "key",
        apiSecret: "secret",
        passphrase: "passphrase",
        accountUid: "uid",
        region: "global",
      }),
      /系统安全存储不可用/,
    );
  } finally {
    repository.close();
  }
});

test("OKX API service 验证后保存身份，同步订单并更新时间", async () => {
  const calls = [];
  const repository = {
    saveExchangeSyncSnapshot(snapshot) {
      calls.push(["saveExchangeSyncSnapshot", snapshot]);
    },
  };
  const vault = {
    getStatus() {
      calls.push(["status"]);
      return { configured: false };
    },
    save(credentials) {
      calls.push(["save", credentials]);
      return { configured: true };
    },
    read() {
      calls.push(["read"]);
      return {
        accountId: "okx-swap:account",
        apiKey: "key",
        apiSecret: "secret",
        passphrase: "passphrase",
        accountUid: "uid",
        region: "global",
      };
    },
    markSynced(syncedAt) {
      calls.push(["markSynced", syncedAt]);
      return { configured: true, lastSyncedAt: syncedAt };
    },
    remove() {
      calls.push(["remove"]);
      return { configured: false };
    },
  };
  const client = {
    async validateCredentials(credentials) {
      calls.push(["validate", credentials]);
      return { accountUid: "uid", region: "global" };
    },
    async syncOrders(options) {
      calls.push(["sync", options]);
      return {
        accountId: "okx-swap:account",
        orders: [{ orderId: "order-1" }],
        openPositions: [],
        syncedAt: 1785300000000,
      };
    },
  };
  const service = createOkxApiService({ repository, vault, client });

  assert.deepEqual(
    await service.configure({
      apiKey: "key",
      apiSecret: "secret",
      passphrase: "passphrase",
      region: "global",
    }),
    { configured: true },
  );
  assert.deepEqual(
    await service.syncOrders({ startTime: 1, endTime: 2 }),
    {
      accountId: "okx-swap:account",
      orders: [{ orderId: "order-1" }],
      openPositions: [],
      syncedAt: 1785300000000,
      status: { configured: true, lastSyncedAt: 1785300000000 },
      syncMode: "full",
      requestedStartTime: 1,
      effectiveStartTime: 1,
    },
  );
  assert.deepEqual(calls, [
    ["validate", {
      apiKey: "key",
      apiSecret: "secret",
      passphrase: "passphrase",
      region: "global",
    }],
    ["save", {
      apiKey: "key",
      apiSecret: "secret",
      passphrase: "passphrase",
      region: "global",
      accountUid: "uid",
    }],
    ["read"],
    ["sync", {
      startTime: 1,
      endTime: 2,
      accountId: "okx-swap:account",
      apiKey: "key",
      apiSecret: "secret",
      passphrase: "passphrase",
      accountUid: "uid",
      region: "global",
    }],
    ["saveExchangeSyncSnapshot", {
      provider: "okx-swap",
      accountId: "okx-swap:account",
      orders: [{ orderId: "order-1" }],
      openPositions: [],
      syncedAt: 1785300000000,
    }],
    ["markSynced", 1785300000000],
  ]);
});

test("OKX API service 在标记同步成功前保存包含空仓的完整同步快照", async () => {
  const calls = [];
  const orders = [{ orderId: "order-1" }];
  const service = createOkxApiService({
    repository: {
      saveOrders() {},
      saveExchangeSyncSnapshot(snapshot) {
        calls.push(["saveExchangeSyncSnapshot", snapshot]);
      },
    },
    vault: {
      read() {
        return {
          accountId: "okx-swap:account",
          apiKey: "key",
          apiSecret: "secret",
          passphrase: "passphrase",
          accountUid: "uid",
          region: "global",
        };
      },
      markSynced(syncedAt) {
        calls.push(["markSynced", syncedAt]);
        return { configured: true, lastSyncedAt: syncedAt };
      },
    },
    client: {
      async syncOrders() {
        return {
          accountId: "okx-swap:account",
          orders,
          openPositions: [],
          syncedAt: 1785300000000,
        };
      },
    },
  });

  await service.syncOrders({ startTime: 1, endTime: 2 });

  assert.deepEqual(calls, [
    ["saveExchangeSyncSnapshot", {
      provider: "okx-swap",
      accountId: "okx-swap:account",
      orders,
      openPositions: [],
      syncedAt: 1785300000000,
    }],
    ["markSynced", 1785300000000],
  ]);
});

test("OKX 同步快照保存失败时不得标记同步成功", async () => {
  let markSyncedCalled = false;
  const service = createOkxApiService({
    repository: {
      saveOrders() {},
      saveExchangeSyncSnapshot() {
        throw new Error("同步快照写入失败");
      },
    },
    vault: {
      read() {
        return {
          accountId: "okx-swap:account",
          apiKey: "key",
          apiSecret: "secret",
          passphrase: "passphrase",
          accountUid: "uid",
          region: "global",
        };
      },
      markSynced() {
        markSyncedCalled = true;
        return { configured: true };
      },
    },
    client: {
      async syncOrders() {
        return {
          accountId: "okx-swap:account",
          orders: [{ orderId: "order-1" }],
          openPositions: [],
          syncedAt: 1785300000000,
        };
      },
    },
  });

  await assert.rejects(
    service.syncOrders({ startTime: 1, endTime: 2 }),
    /同步快照写入失败/,
  );
  assert.equal(markSyncedCalled, false);
});
