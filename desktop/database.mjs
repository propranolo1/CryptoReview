import { DatabaseSync } from "node:sqlite";

/**
 * 创建桌面端本地数据仓库。
 *
 * 数据库文件所在目录由调用方负责创建；传入 `:memory:` 可创建内存数据库。
 */
export function createDesktopRepository(databasePath) {
  if (typeof databasePath !== "string" || databasePath.trim() === "") {
    throw new TypeError("桌面数据库路径必须是非空字符串");
  }

  const database = new DatabaseSync(databasePath);
  let closed = false;

  try {
    database.exec("PRAGMA busy_timeout = 5000");
    database.exec(`
      CREATE TABLE IF NOT EXISTS imported_orders (
        order_key TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        symbol TEXT NOT NULL,
        order_id TEXT NOT NULL,
        sort_order INTEGER NOT NULL,
        payload TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS replay_trades (
        id TEXT PRIMARY KEY,
        sort_order INTEGER NOT NULL,
        payload TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS exchange_open_positions (
        provider TEXT NOT NULL,
        account_id TEXT NOT NULL,
        position_key TEXT NOT NULL,
        sort_order INTEGER NOT NULL,
        synced_at INTEGER NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY (provider, account_id, position_key)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS training_results (
        id TEXT PRIMARY KEY,
        sort_order INTEGER NOT NULL,
        payload TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS user_profiles (
        id TEXT PRIMARY KEY,
        sort_order INTEGER NOT NULL,
        payload TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS exchange_credentials (
        provider TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        encrypted_payload BLOB NOT NULL,
        api_key_hint TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        last_synced_at INTEGER
      ) STRICT;

      CREATE INDEX IF NOT EXISTS imported_orders_sort_order
        ON imported_orders(sort_order);

      CREATE INDEX IF NOT EXISTS replay_trades_sort_order
        ON replay_trades(sort_order);

      CREATE INDEX IF NOT EXISTS exchange_open_positions_sort_order
        ON exchange_open_positions(provider, account_id, sort_order);

      CREATE INDEX IF NOT EXISTS training_results_sort_order
        ON training_results(sort_order);

      CREATE INDEX IF NOT EXISTS user_profiles_sort_order
        ON user_profiles(sort_order);
    `);
  } catch (error) {
    database.close();
    throw error;
  }

  const selectOrders = database.prepare(
    "SELECT payload FROM imported_orders ORDER BY sort_order ASC, order_key ASC",
  );
  const selectTrades = database.prepare(
    "SELECT payload FROM replay_trades ORDER BY sort_order ASC, id ASC",
  );
  const selectOpenPositions = database.prepare(`
    SELECT payload, synced_at
    FROM exchange_open_positions
    ORDER BY provider ASC, account_id ASC, sort_order ASC, position_key ASC
  `);
  const selectTrainingResults = database.prepare(
    "SELECT payload FROM training_results ORDER BY sort_order ASC, id ASC",
  );
  const selectProfiles = database.prepare(
    "SELECT payload FROM user_profiles ORDER BY sort_order ASC, id ASC",
  );
  const selectNextOrder = database.prepare(
    "SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_sort_order FROM imported_orders",
  );
  const upsertOrder = database.prepare(`
    INSERT INTO imported_orders (
      order_key,
      user_id,
      symbol,
      order_id,
      sort_order,
      payload
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(order_key) DO UPDATE SET
      user_id = excluded.user_id,
      symbol = excluded.symbol,
      order_id = excluded.order_id,
      payload = excluded.payload
  `);
  const deleteTrades = database.prepare("DELETE FROM replay_trades");
  const insertTrade = database.prepare(
    "INSERT INTO replay_trades (id, sort_order, payload) VALUES (?, ?, ?)",
  );
  const deleteExchangeOpenPositions = database.prepare(`
    DELETE FROM exchange_open_positions
    WHERE provider = ? AND account_id = ?
  `);
  const insertExchangeOpenPosition = database.prepare(`
    INSERT INTO exchange_open_positions (
      provider,
      account_id,
      position_key,
      sort_order,
      synced_at,
      payload
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  const deleteTrainingResults = database.prepare("DELETE FROM training_results");
  const insertTrainingResult = database.prepare(
    "INSERT INTO training_results (id, sort_order, payload) VALUES (?, ?, ?)",
  );
  const deleteProfiles = database.prepare("DELETE FROM user_profiles");
  const deleteProfile = database.prepare("DELETE FROM user_profiles WHERE id = ?");
  const deleteProfileOrders = database.prepare(
    "DELETE FROM imported_orders WHERE json_extract(payload, '$.profileId') = ?",
  );
  const deleteProfileTrades = database.prepare(
    "DELETE FROM replay_trades WHERE json_extract(payload, '$.profileId') = ?",
  );
  const deleteProfileOpenPositions = database.prepare(
    "DELETE FROM exchange_open_positions WHERE json_extract(payload, '$.profileId') = ?",
  );
  const insertProfile = database.prepare(
    "INSERT INTO user_profiles (id, sort_order, payload) VALUES (?, ?, ?)",
  );
  const selectExchangeCredential = database.prepare(`
    SELECT provider, account_id, encrypted_payload, api_key_hint, updated_at, last_synced_at
    FROM exchange_credentials
    WHERE provider = ?
  `);
  const upsertExchangeCredential = database.prepare(`
    INSERT INTO exchange_credentials (
      provider,
      account_id,
      encrypted_payload,
      api_key_hint,
      updated_at,
      last_synced_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(provider) DO UPDATE SET
      account_id = excluded.account_id,
      encrypted_payload = excluded.encrypted_payload,
      api_key_hint = excluded.api_key_hint,
      updated_at = excluded.updated_at,
      last_synced_at = excluded.last_synced_at
  `);
  const deleteExchangeCredential = database.prepare(
    "DELETE FROM exchange_credentials WHERE provider = ?",
  );
  const updateExchangeCredentialSyncTime = database.prepare(`
    UPDATE exchange_credentials
    SET last_synced_at = ?, updated_at = ?
    WHERE provider = ?
  `);

  return {
    loadState() {
      ensureOpen(closed);
      return {
        orders: selectOrders.all().map(({ payload }) => parseStoredJson(payload, "订单")),
        trades: selectTrades.all().map(({ payload }) => parseStoredJson(payload, "复盘")),
        openPositions: selectOpenPositions
          .all()
          .map(({ payload, synced_at }) => ({
            ...parseStoredJson(payload, "当前仓位"),
            syncedAt: Number(synced_at),
          })),
        trainingResults: selectTrainingResults.all().map(({ payload }) =>
          parseStoredJson(payload, "训练记录"),
        ),
        profiles: selectProfiles.all().map(({ payload }) =>
          parseStoredJson(payload, "复盘用户"),
        ),
      };
    },

    saveOrders(orders) {
      ensureOpen(closed);
      const records = prepareOrders(orders);
      if (records.length === 0) return;

      runTransaction(database, () => {
        let nextSortOrder = Number(selectNextOrder.get().next_sort_order);
        for (const record of records) {
          upsertOrder.run(
            record.key,
            record.order.userId,
            record.order.symbol,
            record.order.orderId,
            nextSortOrder,
            record.payload,
          );
          nextSortOrder += 1;
        }
      });
    },

    saveExchangeSyncSnapshot({
      provider,
      accountId,
      orders,
      openPositions,
      syncedAt,
    }) {
      ensureOpen(closed);
      validateSyncProvider(provider);
      validateRequiredString(accountId, "同步账户 accountId");
      if (!Number.isSafeInteger(syncedAt) || syncedAt <= 0) {
        throw new TypeError("同步快照 syncedAt 必须是有效毫秒时间戳");
      }

      const orderRecords = prepareOrders(orders);
      const positionRecords = prepareOpenPositions(openPositions, {
        provider,
        accountId,
      });

      runTransaction(database, () => {
        let nextSortOrder = Number(selectNextOrder.get().next_sort_order);
        for (const record of orderRecords) {
          upsertOrder.run(
            record.key,
            record.order.userId,
            record.order.symbol,
            record.order.orderId,
            nextSortOrder,
            record.payload,
          );
          nextSortOrder += 1;
        }

        deleteExchangeOpenPositions.run(provider, accountId);
        positionRecords.forEach((record, sortOrder) => {
          insertExchangeOpenPosition.run(
            provider,
            accountId,
            record.key,
            sortOrder,
            syncedAt,
            record.payload,
          );
        });
      });
    },

    saveTrades(trades) {
      ensureOpen(closed);
      const records = prepareTrades(trades);

      runTransaction(database, () => {
        deleteTrades.run();
        records.forEach((record, sortOrder) => {
          insertTrade.run(record.trade.id, sortOrder, record.payload);
        });
      });
    },

    saveTrainingResults(results) {
      ensureOpen(closed);
      const records = prepareTrainingResults(results);

      runTransaction(database, () => {
        deleteTrainingResults.run();
        records.forEach((record, sortOrder) => {
          insertTrainingResult.run(record.result.id, sortOrder, record.payload);
        });
      });
    },

    saveProfiles(profiles) {
      ensureOpen(closed);
      const records = prepareProfiles(profiles);

      runTransaction(database, () => {
        deleteProfiles.run();
        records.forEach((record, sortOrder) => {
          insertProfile.run(record.profile.id, sortOrder, record.payload);
        });
      });
    },

    deleteProfile(profileId) {
      ensureOpen(closed);
      validateRequiredString(profileId, "复盘用户 ID");

      runTransaction(database, () => {
        deleteProfileOrders.run(profileId);
        deleteProfileTrades.run(profileId);
        deleteProfileOpenPositions.run(profileId);
        deleteProfile.run(profileId);
      });
    },

    getExchangeCredential(provider) {
      ensureOpen(closed);
      validateRequiredString(provider, "凭证 provider");
      const row = selectExchangeCredential.get(provider);
      if (!row) return null;
      return {
        provider: row.provider,
        accountId: row.account_id,
        encryptedPayload: Buffer.from(row.encrypted_payload),
        apiKeyHint: row.api_key_hint,
        updatedAt: Number(row.updated_at),
        lastSyncedAt: row.last_synced_at === null ? null : Number(row.last_synced_at),
      };
    },

    saveExchangeCredential(credential) {
      ensureOpen(closed);
      validateExchangeCredential(credential);
      upsertExchangeCredential.run(
        credential.provider,
        credential.accountId,
        Buffer.from(credential.encryptedPayload),
        credential.apiKeyHint,
        credential.updatedAt,
        credential.lastSyncedAt,
      );
    },

    deleteExchangeCredential(provider) {
      ensureOpen(closed);
      validateRequiredString(provider, "凭证 provider");
      deleteExchangeCredential.run(provider);
    },

    updateExchangeCredentialSyncTime(provider, syncedAt) {
      ensureOpen(closed);
      validateRequiredString(provider, "凭证 provider");
      if (!Number.isSafeInteger(syncedAt) || syncedAt <= 0) {
        throw new TypeError("凭证同步时间必须是有效毫秒时间戳");
      }
      updateExchangeCredentialSyncTime.run(syncedAt, syncedAt, provider);
    },

    close() {
      if (closed) return;
      database.close();
      closed = true;
    },
  };
}

function validateExchangeCredential(credential) {
  validateRecord(credential, "交易所凭证");
  validateRequiredString(credential.provider, "凭证 provider");
  validateRequiredString(credential.accountId, "凭证 accountId");
  validateRequiredString(credential.apiKeyHint, "凭证 apiKeyHint");
  if (!(credential.encryptedPayload instanceof Uint8Array) || credential.encryptedPayload.length === 0) {
    throw new TypeError("凭证 encryptedPayload 必须是非空密文");
  }
  if (!Number.isSafeInteger(credential.updatedAt) || credential.updatedAt <= 0) {
    throw new TypeError("凭证 updatedAt 必须是有效毫秒时间戳");
  }
  if (
    credential.lastSyncedAt !== null &&
    (!Number.isSafeInteger(credential.lastSyncedAt) || credential.lastSyncedAt <= 0)
  ) {
    throw new TypeError("凭证 lastSyncedAt 必须为空或有效毫秒时间戳");
  }
}

function prepareOrders(orders) {
  if (!Array.isArray(orders)) {
    throw new TypeError("订单记录必须是数组");
  }

  return orders.map((order, index) => {
    validateRecord(order, `第 ${index + 1} 条订单`);
    for (const field of ["userId", "symbol", "orderId"]) {
      validateRequiredString(order[field], `第 ${index + 1} 条订单的 ${field}`);
    }
    return {
      order,
      key: typeof order.profileId === "string" && order.profileId.trim() !== ""
        ? JSON.stringify([
            order.profileId.trim(),
            order.userId,
            order.symbol,
            order.orderId,
          ])
        : JSON.stringify([order.userId, order.symbol, order.orderId]),
      payload: serializeRecord(order, `第 ${index + 1} 条订单`),
    };
  });
}

function prepareTrades(trades) {
  if (!Array.isArray(trades)) {
    throw new TypeError("复盘记录必须是数组");
  }

  const ids = new Set();
  return trades.map((trade, index) => {
    validateRecord(trade, `第 ${index + 1} 条复盘`);
    validateRequiredString(trade.id, `第 ${index + 1} 条复盘的 id`);
    if (ids.has(trade.id)) {
      throw new TypeError(`复盘记录存在重复 id：${trade.id}`);
    }
    ids.add(trade.id);
    return {
      trade,
      payload: serializeRecord(trade, `第 ${index + 1} 条复盘`),
    };
  });
}

function prepareOpenPositions(openPositions, { provider, accountId }) {
  if (!Array.isArray(openPositions)) {
    throw new TypeError("当前仓位快照必须是数组");
  }

  const keys = new Set();
  return openPositions.map((position, index) => {
    validateRecord(position, `第 ${index + 1} 条当前仓位`);
    for (const field of ["userId", "symbol", "positionSide"]) {
      validateRequiredString(
        position[field],
        `第 ${index + 1} 条当前仓位的 ${field}`,
      );
    }
    if (position.userId !== accountId) {
      throw new TypeError(
        `第 ${index + 1} 条当前仓位不属于同步账户 ${accountId}`,
      );
    }
    if (
      position.exchangeProvider !== undefined &&
      position.exchangeProvider !== provider
    ) {
      throw new TypeError(
        `第 ${index + 1} 条当前仓位的 exchangeProvider 与同步来源不一致`,
      );
    }

    const key = JSON.stringify([position.symbol, position.positionSide]);
    if (keys.has(key)) {
      throw new TypeError(`当前仓位快照存在重复仓位：${key}`);
    }
    keys.add(key);
    return {
      key,
      payload: serializeRecord(position, `第 ${index + 1} 条当前仓位`),
    };
  });
}

function prepareTrainingResults(results) {
  if (!Array.isArray(results)) {
    throw new TypeError("训练记录必须是数组");
  }

  const ids = new Set();
  return results.map((result, index) => {
    validateRecord(result, `第 ${index + 1} 条训练记录`);
    validateRequiredString(result.id, `第 ${index + 1} 条训练记录的 id`);
    if (ids.has(result.id)) {
      throw new TypeError(`训练记录存在重复 id：${result.id}`);
    }
    ids.add(result.id);
    return {
      result,
      payload: serializeRecord(result, `第 ${index + 1} 条训练记录`),
    };
  });
}

function prepareProfiles(profiles) {
  if (!Array.isArray(profiles)) {
    throw new TypeError("复盘用户必须是数组");
  }

  const ids = new Set();
  const names = new Set();
  return profiles.map((profile, index) => {
    validateRecord(profile, `第 ${index + 1} 个复盘用户`);
    validateRequiredString(profile.id, `第 ${index + 1} 个复盘用户的 id`);
    validateRequiredString(profile.name, `第 ${index + 1} 个复盘用户的 name`);
    if (!Number.isFinite(Date.parse(profile.createdAt))) {
      throw new TypeError(`第 ${index + 1} 个复盘用户的 createdAt 无效`);
    }
    const normalizedName = profile.name.trim().toLocaleLowerCase("zh-CN");
    if (ids.has(profile.id)) {
      throw new TypeError(`复盘用户存在重复 id：${profile.id}`);
    }
    if (names.has(normalizedName)) {
      throw new TypeError(`复盘用户存在重复名称：${profile.name}`);
    }
    ids.add(profile.id);
    names.add(normalizedName);
    return {
      profile,
      payload: serializeRecord(profile, `第 ${index + 1} 个复盘用户`),
    };
  });
}

function validateRecord(record, label) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new TypeError(`${label}必须是对象`);
  }
}

function validateRequiredString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${label}必须是非空字符串`);
  }
}

function validateSyncProvider(provider) {
  if (provider !== "binance-usdm" && provider !== "okx-swap") {
    throw new TypeError("同步快照 provider 必须是 binance-usdm 或 okx-swap");
  }
}

function serializeRecord(record, label) {
  try {
    const payload = JSON.stringify(record);
    if (typeof payload !== "string") {
      throw new TypeError("序列化结果不是字符串");
    }
    return payload;
  } catch (error) {
    throw new TypeError(`${label}无法转换为 JSON：${error.message}`, { cause: error });
  }
}

function parseStoredJson(payload, label) {
  try {
    return JSON.parse(payload);
  } catch (error) {
    throw new Error(`本地数据库中的${label}数据不是有效 JSON`, { cause: error });
  }
}

function runTransaction(database, callback) {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = callback();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // 如果 SQLite 已经自动回滚，保留最初的写入错误。
    }
    throw error;
  }
}

function ensureOpen(closed) {
  if (closed) throw new Error("桌面数据库已经关闭");
}
