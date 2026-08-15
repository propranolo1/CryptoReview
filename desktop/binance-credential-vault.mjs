import { createHash } from "node:crypto";

const PROVIDER = "binance-usdm";

/** 使用 Electron safeStorage 加密 Binance API 凭证并只将密文交给 SQLite。 */
export function createBinanceCredentialVault({
  repository,
  safeStorage,
  now = Date.now,
}) {
  if (!repository || typeof repository.getExchangeCredential !== "function") {
    throw new TypeError("Binance 凭证仓库不可用");
  }
  if (!safeStorage || typeof safeStorage.isEncryptionAvailable !== "function") {
    throw new TypeError("Electron 系统安全存储不可用");
  }

  function getStoredCredential() {
    return repository.getExchangeCredential(PROVIDER);
  }

  function getStatus() {
    const stored = getStoredCredential();
    return stored
      ? {
          configured: true,
          apiKeyHint: stored.apiKeyHint,
          lastSyncedAt: stored.lastSyncedAt,
          updatedAt: stored.updatedAt,
        }
      : {
          configured: false,
          apiKeyHint: null,
          lastSyncedAt: null,
          updatedAt: null,
        };
  }

  return {
    getStatus,

    save(credentials) {
      const { apiKey, apiSecret } = validateCredentials(credentials);
      const accountAlias = validateAccountAlias(credentials?.accountAlias);
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error("系统安全存储不可用，已拒绝以明文保存 Binance API 密钥");
      }
      const existing = getStoredCredential();
      const accountId = stableAccountId(accountAlias);
      const sameAccount = existing?.accountId === accountId;
      const updatedAt = normalizeTimestamp(now(), "凭证更新时间");
      const encryptedPayload = safeStorage.encryptString(JSON.stringify({ apiKey, apiSecret, accountAlias }));
      if (!(encryptedPayload instanceof Uint8Array) || encryptedPayload.length === 0) {
        throw new Error("系统安全存储未能生成有效密文");
      }
      repository.saveExchangeCredential({
        provider: PROVIDER,
        accountId,
        encryptedPayload,
        apiKeyHint: `…${apiKey.slice(-4)}`,
        updatedAt,
        lastSyncedAt: sameAccount && existing ? existing.lastSyncedAt : null,
      });
      return getStatus();
    },

    read() {
      const stored = getStoredCredential();
      if (!stored) throw new Error("Binance API 尚未连接");
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error("系统安全存储不可用，无法解密 Binance API 密钥");
      }
      try {
        const parsed = JSON.parse(safeStorage.decryptString(stored.encryptedPayload));
        const { apiKey, apiSecret } = validateCredentials(parsed);
        return { accountId: stored.accountId, apiKey, apiSecret };
      } catch (error) {
        throw new Error("Binance API 本机密文已损坏，请删除后重新连接", { cause: error });
      }
    },

    markSynced(syncedAt = now()) {
      const timestamp = normalizeTimestamp(syncedAt, "同步时间");
      if (!getStoredCredential()) throw new Error("Binance API 尚未连接");
      repository.updateExchangeCredentialSyncTime(PROVIDER, timestamp);
      return getStatus();
    },

    remove() {
      repository.deleteExchangeCredential(PROVIDER);
      return getStatus();
    },
  };
}

function validateCredentials(credentials) {
  if (!credentials || typeof credentials !== "object" || Array.isArray(credentials)) {
    throw new TypeError("Binance API 凭证格式无效");
  }
  const apiKey = validateSecretText(credentials.apiKey, "API Key");
  const apiSecret = validateSecretText(credentials.apiSecret, "Secret Key");
  return { apiKey, apiSecret };
}

function validateSecretText(value, label) {
  if (typeof value !== "string" || value.trim() === "" || value.length > 512) {
    throw new TypeError(`${label}必须是非空字符串`);
  }
  return value.trim();
}

function validateAccountAlias(value) {
  if (typeof value !== "string" || value.trim() === "" || value.trim().length > 128) {
    throw new TypeError("Binance 账户别名无效");
  }
  return value.trim();
}

function stableAccountId(accountAlias) {
  const digest = createHash("sha256")
    .update(`${PROVIDER}\u0000${accountAlias}`, "utf8")
    .digest("hex");
  return `${PROVIDER}:${digest}`;
}

function normalizeTimestamp(value, label) {
  const timestamp = Number(value);
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) {
    throw new TypeError(`${label}必须是有效毫秒时间戳`);
  }
  return timestamp;
}
