import { createHash } from "node:crypto";

const PROVIDER = "okx-swap";
const SUPPORTED_REGIONS = new Set(["global", "us", "eea"]);

/** 使用 Electron safeStorage 加密 OKX API 凭证并只将密文交给 SQLite。 */
export function createOkxCredentialVault({
  repository,
  safeStorage,
  now = Date.now,
}) {
  if (!repository || typeof repository.getExchangeCredential !== "function") {
    throw new TypeError("OKX 凭证仓库不可用");
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
      const normalized = validateStoredCredentials(credentials);
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error("系统安全存储不可用，已拒绝以明文保存 OKX API 凭证");
      }
      const existing = getStoredCredential();
      const accountId = stableAccountId(normalized.accountUid, normalized.region);
      const sameAccount = existing?.accountId === accountId;
      const updatedAt = normalizeTimestamp(now(), "凭证更新时间");
      const encryptedPayload = safeStorage.encryptString(JSON.stringify(normalized));
      if (!(encryptedPayload instanceof Uint8Array) || encryptedPayload.length === 0) {
        throw new Error("系统安全存储未能生成有效密文");
      }
      repository.saveExchangeCredential({
        provider: PROVIDER,
        accountId,
        encryptedPayload,
        // OKX 要求 API Key 全量加密，因此状态只保存不含密钥片段的固定提示。
        apiKeyHint: "已配置",
        updatedAt,
        lastSyncedAt: sameAccount && existing ? existing.lastSyncedAt : null,
      });
      return getStatus();
    },

    read() {
      const stored = getStoredCredential();
      if (!stored) throw new Error("OKX API 尚未连接");
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error("系统安全存储不可用，无法解密 OKX API 凭证");
      }
      try {
        const parsed = JSON.parse(safeStorage.decryptString(stored.encryptedPayload));
        return {
          accountId: stored.accountId,
          ...validateStoredCredentials(parsed),
        };
      } catch (error) {
        throw new Error("OKX API 本机密文已损坏，请删除后重新连接", { cause: error });
      }
    },

    markSynced(syncedAt = now()) {
      const timestamp = normalizeTimestamp(syncedAt, "同步时间");
      if (!getStoredCredential()) throw new Error("OKX API 尚未连接");
      repository.updateExchangeCredentialSyncTime(PROVIDER, timestamp);
      return getStatus();
    },

    remove() {
      repository.deleteExchangeCredential(PROVIDER);
      return getStatus();
    },
  };
}

function validateStoredCredentials(credentials) {
  if (!credentials || typeof credentials !== "object" || Array.isArray(credentials)) {
    throw new TypeError("OKX API 凭证格式无效");
  }
  return {
    apiKey: validateSecretText(credentials.apiKey, "API Key"),
    apiSecret: validateSecretText(credentials.apiSecret, "Secret Key"),
    passphrase: validateSecretText(credentials.passphrase, "Passphrase"),
    accountUid: validateIdentityText(credentials.accountUid, "OKX 账户 UID"),
    region: validateRegion(credentials.region),
  };
}

function validateSecretText(value, label) {
  if (typeof value !== "string" || value.trim() === "" || value.length > 512) {
    throw new TypeError(`${label}必须是非空字符串`);
  }
  return value.trim();
}

function validateIdentityText(value, label) {
  if (typeof value !== "string" || value.trim() === "" || value.trim().length > 128) {
    throw new TypeError(`${label}无效`);
  }
  return value.trim();
}

function validateRegion(value) {
  const region = value === undefined || value === null || value === ""
    ? "global"
    : typeof value === "string"
      ? value.trim().toLowerCase()
      : "";
  if (!SUPPORTED_REGIONS.has(region)) {
    throw new TypeError("OKX region 必须是 global、us 或 eea");
  }
  return region;
}

function stableAccountId(accountUid, region) {
  const digest = createHash("sha256")
    .update(`${PROVIDER}\u0000${region}\u0000${accountUid}`, "utf8")
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
