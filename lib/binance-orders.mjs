const REQUIRED_HEADERS = [
  "用户ID",
  "时间",
  "订单编号",
  "代币名称/币种名称/币对",
  "类型",
  "方向",
  "价格",
  "平均价格",
  "金额",
  "执行金额",
  "已执行报价金额",
  "止损价格",
  "状态",
  "更新时间",
];

const QUANTITY_EPSILON = 1e-10;
const ACTIVE_STATUSES = new Set(["NEW", "PARTIALLY_FILLED", "PENDING_CANCEL"]);

/** 判断文本是否为 Binance U 本位合约“订单历史”中文 CSV。 */
export function isBinanceUsdmOrderHistoryCsv(input) {
  if (typeof input !== "string" || input.trim() === "") return false;
  try {
    const [header = []] = parseCsvRows(input.replace(/^\uFEFF/, ""));
    const normalized = new Set(header.map((value) => value.trim()));
    return REQUIRED_HEADERS.every((field) => normalized.has(field));
  } catch {
    return false;
  }
}

/**
 * 解析 Binance U 本位订单历史导出的中文 CSV。
 * 导出时间没有时区后缀，按文件名约定的 UTC+8 转换为 ISO 时间。
 */
export function parseBinanceUsdmOrderHistoryCsv(input) {
  if (typeof input !== "string") {
    throw new TypeError("Binance 订单历史 CSV 必须是文本");
  }

  const rows = parseCsvRows(input.replace(/^\uFEFF/, "")).filter((row) =>
    row.some((cell) => cell.trim() !== ""),
  );
  if (rows.length === 0) return [];

  const headers = rows[0].map((header) => header.trim());
  const missingHeaders = REQUIRED_HEADERS.filter((field) => !headers.includes(field));
  if (missingHeaders.length > 0) {
    throw new TypeError(`不是受支持的 Binance U 本位订单历史 CSV，缺少字段：${missingHeaders.join("、")}`);
  }

  return rows.slice(1).map((row, index) => {
    const record = Object.fromEntries(
      headers.map((header, columnIndex) => [header, row[columnIndex] ?? ""]),
    );
    const label = `第 ${index + 2} 行`;
    const userId = requiredText(record["用户ID"], `${label}用户 ID`);
    const orderId = requiredText(record["订单编号"], `${label}订单编号`);
    const symbol = requiredText(
      record["代币名称/币种名称/币对"],
      `${label}交易对`,
    ).toUpperCase();
    const orderType = requiredText(record["类型"], `${label}订单类型`).toUpperCase();
    const side = requiredText(record["方向"], `${label}方向`).toUpperCase();
    if (side !== "BUY" && side !== "SELL") {
      throw new TypeError(`${label}方向必须是 BUY 或 SELL`);
    }

    return {
      userId,
      orderId,
      symbol,
      orderType,
      side,
      limitPrice: optionalPositiveNumber(record["价格"], `${label}价格`),
      averagePrice: optionalPositiveNumber(record["平均价格"], `${label}平均价格`),
      originalQuantity: nonNegativeNumber(record["金额"], `${label}金额`),
      executedQuantity: nonNegativeNumber(record["执行金额"], `${label}执行金额`),
      executedQuoteQuantity: nonNegativeNumber(
        record["已执行报价金额"],
        `${label}已执行报价金额`,
      ),
      stopPrice: optionalPositiveNumber(record["止损价格"], `${label}止损价格`),
      status: requiredText(record["状态"], `${label}状态`).toUpperCase(),
      createdAt: parseUtc8Timestamp(record["时间"], `${label}创建时间`),
      updatedAt: parseUtc8Timestamp(record["更新时间"], `${label}更新时间`),
    };
  });
}

/**
 * 在“导入范围开始时仓位为 0”的前提下，以成交数量和 positionSide 重建完整开平仓。
 * CSV 没有逐笔成交时间，因此使用订单最终更新时间作为成交时间；盈亏不包含手续费。
 */
export function reconstructBinanceUsdmReplays(inputOrders, options = {}) {
  if (!Array.isArray(inputOrders)) {
    throw new TypeError("Binance 订单记录必须是数组");
  }

  for (const order of inputOrders) validateNormalizedOrder(order);
  const openPositions = normalizeArray(options.openPositions).filter(
    (position) => Number(position?.quantity) > QUANTITY_EPSILON,
  );
  for (const position of openPositions) validateOpenPosition(position);
  const openPositionsByKey = new Map(
    openPositions.map((position) => [openPositionStorageKey(position), position]),
  );
  const matchedOpenPositionKeys = new Set();
  const candidateOpenPositionKeys = new Set();
  const syncedAtMs = typeof options.syncedAt === "number"
    ? options.syncedAt
    : Date.parse(options.syncedAt);
  const syncedAt = Number.isFinite(syncedAtMs)
    ? new Date(syncedAtMs).toISOString()
    : null;
  const allowHistoryOnlyOpenPositions =
    options.allowHistoryOnlyOpenPositions === true &&
    openPositions.length === 0 &&
    syncedAt !== null;
  const reconstructionOrders = canonicalizeReconstructionOrders(inputOrders);
  const groups = new Map();
  for (const order of reconstructionOrders) {
    const positionSide = normalizePositionSide(order.positionSide);
    const key = `${recordProfileKey(order)}\u0000${exchangeProviderForOrder(order)}\u0000${order.userId}\u0000${order.symbol}\u0000${positionSide}`;
    const group = groups.get(key) ?? [];
    group.push(order);
    groups.set(key, group);
  }

  const trades = [];
  const warnings = [];

  for (const orders of groups.values()) {
    const allOrders = [...orders].sort(compareOrdersByLifecycle);
    const executions = allOrders
      .filter((order) => order.executedQuantity > QUANTITY_EPSILON)
      .flatMap(orderExecutionSegments)
      .sort(compareExecutionSegments);

    let candidate = null;

    for (const execution of executions) {
      const { order, price } = execution;
      const direction = order.side === "BUY" ? 1 : -1;
      let remainingExecution = execution.quantity;

      while (remainingExecution > QUANTITY_EPSILON) {
        if (!candidate) {
          candidate = createCandidate(execution, direction, remainingExecution);
          remainingExecution = 0;
          continue;
        }

        if (candidate.direction === direction) {
          const entryFee = executionFeeForQuantity(execution, remainingExecution);
          candidate.positionQuantity += remainingExecution;
          candidate.totalEntryQuantity += remainingExecution;
          candidate.entryNotional += remainingExecution * price;
          candidate.entryFee += entryFee;
          candidate.feesKnown = candidate.feesKnown && execution.feeKnown;
          addCommissionEvidence(candidate, execution, remainingExecution);
          candidate.entries.push(
            candidateEntryFromExecution(execution, remainingExecution, entryFee),
          );
          candidate.entryOrders.push(order);
          remainingExecution = 0;
          continue;
        }

        const closeQuantity = Math.min(candidate.positionQuantity, remainingExecution);
        const exitFee = executionFeeForQuantity(execution, closeQuantity);
        candidate.exits.push({
          quantity: cleanNumber(closeQuantity),
          exitPrice: price,
          exitTime: execution.time,
          fee: cleanNumber(exitFee),
        });
        if (Number.isFinite(execution.reportedRealizedPnl)) {
          candidate.reportedRealizedPnl +=
            execution.reportedRealizedPnl * (closeQuantity / execution.quantity);
          candidate.reportedRealizedPnlKnown = true;
        }
        candidate.feesKnown = candidate.feesKnown && execution.feeKnown;
        addCommissionEvidence(candidate, execution, closeQuantity);
        candidate.exitOrders.push(order);
        candidate.positionQuantity -= closeQuantity;
        remainingExecution -= closeQuantity;

        if (candidate.positionQuantity <= QUANTITY_EPSILON) {
          trades.push(finalizeCandidate(candidate, allOrders));
          candidate = null;
        }
      }
    }

    if (candidate) {
      const positionKey = candidateStorageKey(candidate);
      candidateOpenPositionKeys.add(positionKey);
      const openPosition = openPositionsByKey.get(positionKey);
      if (
        openPosition &&
        openPositionDirection(openPosition) === candidate.direction &&
        valuesNearlyEqual(openPosition.quantity, candidate.positionQuantity)
      ) {
        trades.push(finalizeCandidate(candidate, allOrders, {
          openPosition,
          syncedAt: syncedAt ?? normalizeOptionalTimestamp(openPosition.syncedAt),
        }));
        matchedOpenPositionKeys.add(positionKey);
        candidate = null;
      }
    }

    if (
      candidate &&
      allowHistoryOnlyOpenPositions &&
      candidateHasSyncSource(candidate, "smart-money-public")
    ) {
      trades.push(finalizeCandidate(candidate, allOrders, {
        historyOnlyOpen: true,
        syncedAt,
      }));
      candidate = null;
    }

    if (candidate) {
      const orderIds = uniqueStrings([
        ...candidate.entryOrders.map((order) => order.orderId),
        ...candidate.exitOrders.map((order) => order.orderId),
      ]);
      warnings.push({
        code: "ambiguous_open_position",
        symbol: candidate.symbol,
        orderIds,
        message: `${candidate.symbol} 在导入范围内没有形成完整开平仓，已保存订单但未生成复盘。`,
      });
    }
  }

  for (const position of openPositions) {
    const positionKey = openPositionStorageKey(position);
    if (matchedOpenPositionKeys.has(positionKey) || candidateOpenPositionKeys.has(positionKey)) {
      continue;
    }
    warnings.push({
      code: "missing_open_position_history",
      symbol: position.symbol,
      orderIds: [],
      message: `${position.symbol} 当前仍有未平仓仓位，但同步范围内缺少可匹配的完整开仓历史，未生成推测复盘。`,
    });
  }

  trades.sort((left, right) => Date.parse(right.entryTime) - Date.parse(left.entryTime));
  warnings.sort((left, right) => left.symbol.localeCompare(right.symbol));
  return { trades, warnings };
}

/** 按账户、交易对和订单编号更新原始订单，重复导入不会增加副本。 */
export function mergeBinanceOrderRecords(currentOrders, incomingOrders) {
  const merged = new Map();
  for (const order of normalizeArray(currentOrders)) {
    validateNormalizedOrder(order);
    merged.set(orderStorageKey(order), order);
  }
  for (const order of normalizeArray(incomingOrders)) {
    validateNormalizedOrder(order);
    const key = orderStorageKey(order);
    const existing = merged.get(key);
    merged.set(key, existing ? mergeStoredOrderRecords(order, existing) : order);
  }
  return [...merged.values()];
}

/** API 每次更新都以当前仓位快照为准，移除已经不存在的旧未平仓快照。 */
export function mergeBinanceApiReplays(currentTrades, incomingTrades, options = {}) {
  return mergeApiReplaysForProvider(
    currentTrades,
    incomingTrades,
    "binance-usdm",
    options,
  );
}

/** OKX API 每次更新同样以当前仓位快照为准，但不会清理其他交易所的未平仓复盘。 */
export function mergeOkxApiReplays(currentTrades, incomingTrades, options = {}) {
  return mergeApiReplaysForProvider(
    currentTrades,
    incomingTrades,
    "okx-swap",
    options,
  );
}

function mergeApiReplaysForProvider(
  currentTrades,
  incomingTrades,
  provider,
  { accountId = null, profileId = null } = {},
) {
  const scopedAccountId =
    typeof accountId === "string" && accountId.trim() !== ""
      ? accountId.trim()
      : null;
  const incoming = normalizeArray(incomingTrades);
  return mergeImportedReplays(currentTrades, incoming).filter((trade) => {
    if (!(isAutomaticReplayForProvider(trade, provider) && trade?.openPosition)) return true;
    if (
      scopedAccountId !== null &&
      String(trade.openPosition.userId ?? "") !== scopedAccountId
    ) {
      return true;
    }
    if (
      typeof profileId === "string" &&
      profileId.trim() !== "" &&
      recordProfileKey(trade) !== profileId.trim()
    ) {
      return true;
    }
    return incoming.some((candidate) => replaysReferToSameSource(trade, candidate));
  });
}

/**
 * 按稳定来源键更新自动生成的复盘，并保留用户已经写入的复盘笔记。
 * 同一个开仓订单对应的旧内置示例也会被真实 CSV 重建记录替换。
 */
export function mergeImportedReplays(currentTrades, incomingTrades) {
  const current = normalizeArray(currentTrades);
  const incomingByKey = new Map();
  for (const trade of normalizeArray(incomingTrades)) {
    if (!trade || typeof trade !== "object") continue;
    incomingByKey.set(replayIdentity(trade), trade);
  }

  const mergedIncoming = [];
  for (const incoming of incomingByKey.values()) {
    const existing = findBestReplayMatch(current, incoming);
    const preservedNotes =
      existing && typeof existing.notes === "string" && existing.notes.trim() !== ""
        ? existing.notes
        : incoming.notes;
    const preservedOcrRiskLevels = normalizeArray(existing?.riskLevels).filter(
      (level) => level && typeof level === "object" && level.source === "ocr",
    );
    const shouldMergeRiskLevels =
      Array.isArray(incoming.riskLevels) || preservedOcrRiskLevels.length > 0;
    const shouldPreserveConditionOrders =
      existing && Object.prototype.hasOwnProperty.call(existing, "conditionOrders");
    const syncSources = mergeSyncSources(
      incoming.syncSources,
      existing?.syncSources,
      preservedOcrRiskLevels.length > 0 ? ["ocr-condition"] : [],
    );
    mergedIncoming.push({
      ...incoming,
      ...(syncSources.length > 0 ? { syncSources } : {}),
      ...(preservedNotes === undefined ? {} : { notes: preservedNotes }),
      ...(shouldMergeRiskLevels
        ? {
            riskLevels: mergeReplayRiskLevels(
              incoming.riskLevels,
              preservedOcrRiskLevels,
            ),
          }
        : {}),
      ...(shouldPreserveConditionOrders
        ? { conditionOrders: existing.conditionOrders }
        : {}),
    });
  }

  const untouched = current.filter(
    (trade) => !mergedIncoming.some((incoming) => replaysReferToSameSource(trade, incoming)),
  );
  return [...mergedIncoming, ...untouched];
}

/**
 * 同一真实订单可能同时来自 CSV、OCR 和 API。重建前只在证据完整时合并来源，
 * 原始记录仍会全部保存在本地，便于后续校对与重新重建。
 */
function canonicalizeReconstructionOrders(inputOrders) {
  const officialOrders = [];
  const officialIndexesByIdentity = new Map();
  const ocrOrders = [];

  for (const order of inputOrders) {
    if (isOcrBasicOrder(order)) {
      ocrOrders.push(order);
      continue;
    }

    const identity = officialOrderIdentity(order);
    const candidateIndexes = officialIndexesByIdentity.get(identity) ?? [];
    const duplicateIndex = candidateIndexes.find((index) =>
      officialOrdersAreEquivalent(officialOrders[index], order),
    ) ?? -1;
    if (duplicateIndex < 0) {
      officialOrders.push(withOrderSyncSources(order));
      officialIndexesByIdentity.set(identity, [
        ...candidateIndexes,
        officialOrders.length - 1,
      ]);
      continue;
    }
    const existing = officialOrders[duplicateIndex];
    const incomingWins = officialSourcePriority(order) >= officialSourcePriority(existing);
    officialOrders[duplicateIndex] = incomingWins
      ? mergeOrderEvidence(order, existing)
      : mergeOrderEvidence(existing, order);
  }

  const unmatchedOcrOrders = ocrOrders.filter((ocrOrder) => {
    const matchingIndexes = officialOrders
      .map((officialOrder, index) =>
        ocrOrderMatchesOfficialOrder(ocrOrder, officialOrder) ? index : -1,
      )
      .filter((index) => index >= 0);
    if (matchingIndexes.length !== 1) return true;
    const [matchingIndex] = matchingIndexes;
    officialOrders[matchingIndex] = mergeOrderEvidence(
      officialOrders[matchingIndex],
      ocrOrder,
    );
    return false;
  });
  return [...officialOrders, ...unmatchedOcrOrders.map(withOrderSyncSources)];
}

function officialOrderIdentity(order) {
  return [
    exchangeProviderForOrder(order),
    String(order?.symbol ?? ""),
    String(order?.orderId ?? ""),
  ].join("\u0000");
}

function withOrderSyncSources(order) {
  return {
    ...order,
    syncSources: mergeSyncSources(order?.syncSources, inferOrderSyncSources(order)),
  };
}

function mergeOrderEvidence(preferred, other) {
  return {
    ...preferred,
    fills: mergeOrderFills(preferred?.fills, other?.fills),
    sourceOrderAliases: uniqueStrings([
      ...normalizeArray(preferred?.sourceOrderAliases),
      ...normalizeArray(other?.sourceOrderAliases),
      ...(preferred?.orderId !== other?.orderId ? [other?.orderId] : []),
    ]),
    syncSources: mergeSyncSources(
      preferred?.syncSources,
      other?.syncSources,
      inferOrderSyncSources(preferred),
      inferOrderSyncSources(other),
    ),
  };
}

function mergeStoredOrderRecords(preferred, other) {
  const merged = { ...other, ...preferred };
  const fills = mergeOrderFills(preferred?.fills, other?.fills);
  if (fills.length > 0) merged.fills = fills;

  const sourceOrderAliases = uniqueStrings([
    ...normalizeArray(preferred?.sourceOrderAliases),
    ...normalizeArray(other?.sourceOrderAliases),
  ]);
  if (sourceOrderAliases.length > 0) merged.sourceOrderAliases = sourceOrderAliases;

  const hasSyncEvidence = Boolean(
    preferred?.sourceKind ||
      other?.sourceKind ||
      preferred?.source ||
      other?.source ||
      normalizeArray(preferred?.syncSources).length ||
      normalizeArray(other?.syncSources).length,
  );
  if (hasSyncEvidence) {
    merged.syncSources = mergeSyncSources(
      preferred?.syncSources,
      other?.syncSources,
      inferOrderSyncSources(preferred),
      inferOrderSyncSources(other),
    );
  }
  return merged;
}

function mergeOrderFills(preferredFills, otherFills) {
  const merged = new Map();
  for (const fill of [...normalizeArray(otherFills), ...normalizeArray(preferredFills)]) {
    if (!fill || typeof fill !== "object") continue;
    const identity = String(
      fill.tradeId ??
        `${fill.orderId ?? ""}:${fill.time ?? ""}:${fill.price ?? ""}:${fill.quantity ?? ""}`,
    );
    merged.set(identity, fill);
  }
  return [...merged.values()];
}

function inferOrderSyncSources(order) {
  if (!order || typeof order !== "object") return [];
  if (
    order.sourceKind === "okx-api-normal" ||
    order.sourceKind === "okx-api-algo" ||
    exchangeProviderForOrder(order) === "okx-swap"
  ) {
    return ["okx-api"];
  }
  if (order.sourceKind === "api-normal" || order.sourceKind === "api-algo") {
    return ["binance-api"];
  }
  if (order.source === "smart-money-public") return ["smart-money-public"];
  if (order.source === "copy-trade-public") return ["copy-trade-public"];
  if (order.source === "ocr-follow") return ["ocr-follow"];
  if (isOcrBasicOrder(order)) return ["ocr-basic"];
  return ["binance-csv"];
}

function mergeSyncSources(...groups) {
  const priority = [
    "okx-api",
    "binance-api",
    "smart-money-public",
    "copy-trade-public",
    "binance-csv",
    "ocr-basic",
    "ocr-condition",
    "manual-csv",
    "manual-json",
    "built-in",
    "simulation",
    "legacy-import",
  ];
  const values = uniqueStrings(groups.flatMap((group) => normalizeArray(group)));
  return values.sort((left, right) => {
    const leftIndex = priority.indexOf(left);
    const rightIndex = priority.indexOf(right);
    if (leftIndex < 0 && rightIndex < 0) return left.localeCompare(right);
    if (leftIndex < 0) return 1;
    if (rightIndex < 0) return -1;
    return leftIndex - rightIndex;
  });
}

function isOcrBasicOrder(order) {
  return order?.source === "ocr-basic" ||
    String(order?.userId ?? "") === "ocr-basic-local" ||
    String(order?.orderId ?? "").startsWith("ocr-basic-");
}

function officialOrdersAreEquivalent(left, right) {
  if (exchangeProviderForOrder(left) !== exchangeProviderForOrder(right)) return false;
  if (left.symbol !== right.symbol || left.orderId !== right.orderId) return false;
  if (left.side !== right.side) return false;
  if (normalizeOrderTypeForComparison(left.orderType) !== normalizeOrderTypeForComparison(right.orderType)) {
    return false;
  }
  if (!timestampsAreClose(left.createdAt, right.createdAt, 2_000)) return false;
  if (!valuesNearlyEqual(left.originalQuantity, right.originalQuantity)) return false;
  if (!valuesNearlyEqual(left.executedQuantity, right.executedQuantity)) return false;
  return relevantOrderPricesAreEqual(left, right);
}

function ocrOrderMatchesOfficialOrder(ocrOrder, officialOrder) {
  if (ocrOrder.symbol !== officialOrder.symbol || ocrOrder.side !== officialOrder.side) return false;
  if (normalizeOrderTypeForComparison(ocrOrder.orderType) !== normalizeOrderTypeForComparison(officialOrder.orderType)) {
    return false;
  }
  if (!timestampsAreClose(ocrOrder.createdAt, officialOrder.createdAt, 2_000)) return false;
  if (!valuesNearlyEqual(ocrOrder.originalQuantity, officialOrder.originalQuantity)) return false;
  if (!valuesNearlyEqual(ocrOrder.executedQuantity, officialOrder.executedQuantity)) return false;
  return relevantOrderPricesAreEqual(ocrOrder, officialOrder);
}

function relevantOrderPricesAreEqual(left, right) {
  const type = normalizeOrderTypeForComparison(left.orderType);
  if (type === "LIMIT") return valuesNearlyEqual(left.limitPrice, right.limitPrice);
  if (type === "MARKET" && left.averagePrice !== null && right.averagePrice !== null) {
    return valuesNearlyEqual(left.averagePrice, right.averagePrice);
  }
  return true;
}

function normalizeOrderTypeForComparison(value) {
  const type = String(value ?? "").toUpperCase();
  if (type.includes("LIMIT")) return "LIMIT";
  if (type.includes("MARKET")) return "MARKET";
  return type;
}

function normalizePositionSide(value) {
  const normalized = String(value ?? "BOTH").toUpperCase();
  return normalized === "LONG" || normalized === "SHORT" ? normalized : "BOTH";
}

function officialSourcePriority(order) {
  if (
    order.sourceKind === "api-normal" ||
    order.sourceKind === "api-algo" ||
    order.sourceKind === "okx-api-normal" ||
    order.sourceKind === "okx-api-algo"
  ) {
    return 2;
  }
  return 1;
}

function createCandidate(execution, direction, quantity) {
  const { order, price } = execution;
  const entryFee = executionFeeForQuantity(execution, quantity);
  const candidate = {
    exchangeProvider: exchangeProviderForOrder(order),
    profileId: optionalText(order.profileId),
    profileName: optionalText(order.profileName),
    userId: order.userId,
    symbol: order.symbol,
    positionSide: normalizePositionSide(order.positionSide),
    direction,
    positionQuantity: quantity,
    totalEntryQuantity: quantity,
    entryNotional: quantity * price,
    entryTime: execution.time,
    entryFee,
    feesKnown: execution.feeKnown,
    commissionByAsset: {},
    entryOrders: [order],
    entries: [candidateEntryFromExecution(execution, quantity, entryFee)],
    exitOrders: [],
    exits: [],
    reportedRealizedPnl: 0,
    reportedRealizedPnlKnown: false,
  };
  addCommissionEvidence(candidate, execution, quantity);
  return candidate;
}

function finalizeCandidate(
  candidate,
  allOrders,
  { openPosition = null, historyOnlyOpen = false, syncedAt = null } = {},
) {
  const entryPrice = cleanNumber(candidate.entryNotional / candidate.totalEntryQuantity);
  const lastExit = candidate.exits.at(-1) ?? null;
  const lifecycleEnd = lastExit?.exitTime ?? syncedAt ?? openPosition?.updateTime;
  const riskLevels = buildRiskLevels(candidate, allOrders, entryPrice, lifecycleEnd);
  const relatedOrders = uniqueOrders([
    ...candidate.entryOrders,
    ...candidate.exitOrders,
    ...riskLevels.map((level) => allOrders.find((order) => order.orderId === level.orderId)),
  ].filter(Boolean));
  relatedOrders.sort(compareOrdersByRelevantEvent);

  const sourceEntryOrderId = candidate.entryOrders[0].orderId;
  const sourceEntryAliases = uniqueStrings(
    normalizeArray(candidate.entryOrders[0].sourceOrderAliases),
  ).filter((orderId) => orderId !== sourceEntryOrderId);
  const syncSources = mergeSyncSources(
    ...relatedOrders.map((order) => order.syncSources ?? inferOrderSyncSources(order)),
  );
  const accountHash = stableHash(
    candidate.profileId
      ? `${candidate.profileId}\u0000${candidate.userId}`
      : candidate.userId,
  );
  const profile = replayProfile(candidate.exchangeProvider);
  const isFollowScreenshot = syncSources.includes("ocr-follow");
  const isSmartMoney = syncSources.includes("smart-money-public");
  const isPublicCopyTrade = syncSources.includes("copy-trade-public");
  const sourceKey = `${profile.sourcePrefix}:${accountHash}:${candidate.symbol}:${sourceEntryOrderId}`;
  const localDate = formatUtc8MonthDay(candidate.entryTime);

  const isOpen = Boolean(openPosition) || historyOnlyOpen;
  const fee = cleanNumber(candidate.entryFee);
  const feesKnown = candidate.feesKnown;
  const fundingFeesKnown = isOpen && typeof openPosition?.fundingFeesKnown === "boolean"
    ? openPosition.fundingFeesKnown
    : undefined;
  const fundingFees = fundingFeesKnown
    ? candidateFundingFees(candidate, openPosition, lifecycleEnd)
    : [];
  const fundingFee = cleanNumber(
    fundingFees.reduce((total, item) => total + item.amount, 0),
  );
  const commissionByAsset = Object.fromEntries(
    Object.entries(candidate.commissionByAsset)
      .filter(([, value]) => Math.abs(value) > QUANTITY_EPSILON)
      .map(([asset, value]) => [asset, cleanNumber(value)]),
  );

  return {
    id: `${profile.idPrefix}-${accountHash}-${candidate.symbol}-${sourceEntryOrderId}`,
    sourceKey,
    sourceEntryOrderId,
    sourceEntryAliases,
    sourceOrderIds: relatedOrders.map((order) => order.orderId),
    syncSources,
    ...(candidate.profileId ? { profileId: candidate.profileId } : {}),
    ...(candidate.profileName ? { profileName: candidate.profileName } : {}),
    title: isSmartMoney
      ? `${localDate} ${candidate.profileName ?? "聪明钱"}复盘`
      : isPublicCopyTrade
      ? `${localDate} ${candidate.profileName ?? "公开带单"}复盘`
      : isFollowScreenshot
        ? `${localDate} ${candidate.profileName ?? "跟单"}复盘`
        : `${localDate} 订单历史复盘`,
    strategy: isSmartMoney
      ? "Binance 聪明钱同步"
      : isPublicCopyTrade
      ? "Binance 公开带单同步"
      : isFollowScreenshot
        ? "跟单记录截图重建"
        : profile.strategy,
    notes: isSmartMoney
      ? "由 Binance 聪明钱主页关联的公开合约带单成交自动重建；公开数据不提供手续费，实际净盈亏可能与主页账户存在差异。"
      : isPublicCopyTrade
      ? "由 Binance 公开带单主页的成交历史自动重建；公开数据不提供手续费，实际净盈亏可能与带单员账户存在差异。"
      : isFollowScreenshot
      ? "由跟单详情时间线截图重建；截图未提供手续费，实际盈亏以截图成交盈亏为核对依据。"
      : feesKnown
        ? profile.notesWithFees
        : profile.notesWithoutFees,
    symbol: candidate.symbol,
    side: candidate.direction === 1 ? "long" : "short",
    quantity: cleanNumber(candidate.totalEntryQuantity),
    entryPrice,
    entryTime: candidate.entryTime,
    stopLoss: null,
    takeProfit: null,
    exitPrice: isOpen ? null : lastExit?.exitPrice ?? null,
    exitTime: isOpen ? null : lastExit?.exitTime ?? null,
    fee,
    entries: candidate.entries,
    exits: candidate.exits,
    riskLevels,
    exitLabel: isOpen ? "未平仓" : "平仓成交",
    marketDataSource: "binance-futures",
    feesKnown,
    commissionByAsset,
    ...(fundingFeesKnown !== undefined
      ? { fundingFeesKnown, fundingFees, fundingFee }
      : {}),
    ...(candidate.reportedRealizedPnlKnown
      ? { reportedRealizedPnl: cleanNumber(candidate.reportedRealizedPnl) }
      : {}),
    ...(isOpen
      ? openPosition
        ? {
            openPosition: {
              ...openPosition,
              syncedAt: syncedAt ?? openPosition.updateTime,
            },
          }
        : {
            openPositionEvidence: {
              source: "complete-order-history",
              syncedAt,
            },
          }
      : {}),
    reconstructionNotice: `${historyOnlyOpen
      ? "聪明钱关联的完整公开成交历史用于重建；币安当前仓位接口需要登录，本条未平仓状态按成交链剩余数量标记，不包含伪造的实时标记价。"
      : isSmartMoney || isPublicCopyTrade
      ? `${isSmartMoney ? "聪明钱关联" : "公开"}成交历史用于精确重建；仓位快照只用于核对未平仓数量，不会把仓位差分伪造成未知价格的成交。`
      : isFollowScreenshot
        ? "跟单截图只包含已展示的时间线成交；缺少的开仓或平仓会继续保存在订单档案中，补齐后才生成复盘。"
        : feesKnown
        ? profile.noticeWithFees
        : profile.noticeWithoutFees}${fundingFeesKnown === true
          ? " 已按 Binance 真实收益流水计入当前仓位累计资金费。"
          : fundingFeesKnown === false
            ? ` ${openPosition.fundingFeeNotice ?? "当前仓位资金费无法精确归属，盈亏暂未计入资金费。"}`
            : ""}`,
  };
}

function candidateHasSyncSource(candidate, source) {
  return [...candidate.entryOrders, ...candidate.exitOrders].some((order) =>
    mergeSyncSources(order.syncSources, inferOrderSyncSources(order)).includes(source),
  );
}

function candidateFundingFees(candidate, openPosition, lifecycleEnd) {
  if (!Array.isArray(openPosition?.fundingFees)) return [];
  const entryTimeMs = Date.parse(candidate.entryTime);
  const lifecycleEndMs = normalizeOptionalTimestamp(lifecycleEnd);
  const endTimeMs = lifecycleEndMs === null
    ? Number.POSITIVE_INFINITY
    : Date.parse(lifecycleEndMs);
  const byTransactionId = new Map();

  for (const fundingFee of openPosition.fundingFees) {
    const timeMs = Date.parse(String(fundingFee?.time ?? ""));
    if (
      !Number.isFinite(timeMs) ||
      timeMs < entryTimeMs ||
      timeMs > endTimeMs ||
      fundingFee.userId !== candidate.userId ||
      fundingFee.symbol !== candidate.symbol ||
      fundingFee.asset !== openPosition.marginAsset ||
      !Number.isFinite(Number(fundingFee.amount))
    ) {
      continue;
    }
    const transactionId = String(fundingFee.transactionId ?? "").trim();
    if (transactionId === "") continue;
    byTransactionId.set(transactionId, {
      ...fundingFee,
      transactionId,
      amount: cleanNumber(Number(fundingFee.amount)),
      time: new Date(timeMs).toISOString(),
    });
  }

  return [...byTransactionId.values()].sort(
    (left, right) => Date.parse(left.time) - Date.parse(right.time) ||
      left.transactionId.localeCompare(right.transactionId),
  );
}

function replayProfile(provider) {
  if (provider === "okx-swap") {
    return {
      sourcePrefix: "okx-swap",
      idPrefix: "import-okx-swap",
      strategy: "OKX U 本位永续订单重建",
      notesWithFees: "由 OKX U 本位永续订单与逐笔成交记录重建，盈亏已计入实际成交手续费。",
      notesWithoutFees: "由 OKX U 本位永续订单历史重建；部分逐笔成交或手续费币种无法完整核对。",
      noticeWithFees: "订单历史与逐笔成交已核对，盈亏包含 OKX 返回的实际手续费与返佣。",
      noticeWithoutFees: "订单历史已重建；缺少完整逐笔成交或手续费并非计价资产，盈亏可能未包含全部手续费。",
    };
  }
  return {
    sourcePrefix: "binance-futures",
    idPrefix: "import-binance-futures",
    strategy: "Binance U 本位订单重建",
    notesWithFees: "由 Binance U 本位订单与逐笔成交记录重建，盈亏已计入实际成交手续费。",
    notesWithoutFees: "由 Binance U 本位订单历史重建；部分逐笔成交或手续费币种无法完整核对。",
    noticeWithFees: "订单历史与逐笔成交已核对，盈亏包含 Binance 返回的实际手续费。",
    noticeWithoutFees: "订单历史已重建；缺少完整逐笔成交或手续费并非计价资产，盈亏可能未包含全部手续费。",
  };
}

function buildRiskLevels(candidate, allOrders, entryPrice, exitTime) {
  const oppositeSide = candidate.direction === 1 ? "SELL" : "BUY";
  const entryTimeMs = Date.parse(candidate.entryTime);
  const exitTimeMs = Date.parse(exitTime);
  if (!Number.isFinite(exitTimeMs)) return [];

  return allOrders
    .filter((order) => {
      if (order.side !== oppositeSide) return false;
      if (order.orderType === "MARKET") return false;
      const start = Date.parse(order.createdAt);
      const end = ACTIVE_STATUSES.has(order.status)
        ? Number.POSITIVE_INFINITY
        : Date.parse(order.updatedAt);
      return start <= exitTimeMs && end >= entryTimeMs;
    })
    .map((order) => riskLevelFromOrder(order, candidate.direction, entryPrice))
    .filter(Boolean)
    .sort((left, right) => Date.parse(left.startTime) - Date.parse(right.startTime));
}

function riskLevelFromOrder(order, tradeDirection, entryPrice) {
  const type = order.orderType.toUpperCase();
  let kind;
  let inferred = Boolean(order.lifecycleTimeEstimated);
  let price = order.stopPrice ?? order.limitPrice;

  if (type.includes("TAKE_PROFIT")) {
    kind = "takeProfit";
  } else if (type.includes("STOP")) {
    kind = "stopLoss";
  } else if (type === "LIMIT" && order.limitPrice !== null) {
    const favorable =
      tradeDirection === 1 ? order.limitPrice > entryPrice : order.limitPrice < entryPrice;
    if (!favorable) return null;
    kind = "takeProfit";
    inferred = true;
    price = order.limitPrice;
  } else {
    return null;
  }

  if (price === null || !Number.isFinite(price) || price <= 0) return null;
  const active = ACTIVE_STATUSES.has(order.status);
  return {
    id: `order-${order.orderId}`,
    orderId: order.orderId,
    kind,
    inferred,
    price,
    executionType: type.includes("MARKET") ? "market" : "limit",
    startTime: order.createdAt,
    endTime: active ? null : order.updatedAt,
    ...(active ? {} : { endState: normalizeRiskEndState(order.status) }),
  };
}

function normalizeRiskEndState(status) {
  if (status === "FILLED") return "filled";
  if (status === "CANCELED" || status === "CANCELLED") return "cancelled";
  if (status === "EXPIRED") return "expired";
  return "cancelled";
}

function executionPrice(order) {
  const price =
    order.averagePrice ??
    (order.executedQuoteQuantity > 0
      ? order.executedQuoteQuantity / order.executedQuantity
      : null) ??
    order.limitPrice;
  if (!Number.isFinite(price) || price <= 0) {
    throw new TypeError(`${order.symbol} 订单 ${order.orderId} 缺少有效成交均价`);
  }
  return cleanNumber(price);
}

function orderExecutionSegments(order) {
  const fills = normalizeArray(order.fills);
  const validFills = fills.filter(isUsableFill);
  const fillQuantity = validFills.reduce((total, fill) => total + Number(fill.quantity), 0);
  const fillsComplete =
    fills.length > 0 &&
    validFills.length === fills.length &&
    valuesNearlyEqual(fillQuantity, order.executedQuantity);

  if (!fillsComplete) {
    return [{
      id: String(order.orderId),
      order,
      quantity: order.executedQuantity,
      price: executionPrice(order),
      time: order.updatedAt,
      fee: 0,
      commission: 0,
      commissionAsset: null,
      feeKnown: false,
      reportedRealizedPnl: nullableFiniteNumber(order.reportedRealizedPnl),
    }];
  }

  const quoteAsset = quoteAssetForSymbol(order.symbol);
  return validFills.map((fill, index) => {
    const commissionAsset = String(fill.commissionAsset).toUpperCase();
    const commission = Number(fill.commission);
    const feeKnown = quoteAsset !== null && commissionAsset === quoteAsset;
    return {
      id: String(fill.tradeId ?? `${order.orderId}:${index}`),
      order,
      quantity: Number(fill.quantity),
      price: Number(fill.price),
      time: new Date(fill.time).toISOString(),
      fee: feeKnown ? commission : 0,
      commission,
      commissionAsset,
      feeKnown,
      reportedRealizedPnl: nullableFiniteNumber(fill.realizedPnl),
    };
  });
}

function candidateEntryFromExecution(execution, quantity, fee) {
  return {
    id: String(execution.id ?? execution.order.orderId),
    sourceOrderId: String(execution.order.orderId),
    quantity: cleanNumber(quantity),
    entryPrice: cleanNumber(execution.price),
    entryTime: execution.time,
    fee: cleanNumber(fee),
  };
}

function isUsableFill(fill) {
  return Boolean(
    fill &&
      typeof fill === "object" &&
      Number.isFinite(Number(fill.quantity)) &&
      Number(fill.quantity) > QUANTITY_EPSILON &&
      Number.isFinite(Number(fill.price)) &&
      Number(fill.price) > 0 &&
      Number.isFinite(Number(fill.commission)) &&
      typeof fill.commissionAsset === "string" &&
      fill.commissionAsset.trim() !== "" &&
      Number.isFinite(Date.parse(fill.time)),
  );
}

function quoteAssetForSymbol(symbol) {
  const normalized = String(symbol ?? "").toUpperCase();
  return ["USDT", "USDC", "BUSD"].find((asset) => normalized.endsWith(asset)) ?? null;
}

function executionFeeForQuantity(execution, quantity) {
  if (!execution.feeKnown || execution.quantity <= QUANTITY_EPSILON) return 0;
  return cleanNumber(execution.fee * (quantity / execution.quantity));
}

function addCommissionEvidence(candidate, execution, quantity) {
  if (!execution.commissionAsset || Math.abs(execution.commission) <= QUANTITY_EPSILON) return;
  const allocated = execution.commission * (quantity / execution.quantity);
  candidate.commissionByAsset[execution.commissionAsset] =
    (candidate.commissionByAsset[execution.commissionAsset] ?? 0) + allocated;
}

function compareExecutionSegments(left, right) {
  return (
    Date.parse(left.time) - Date.parse(right.time) ||
    compareOrdersByExecution(left.order, right.order)
  );
}

function compareOrdersByExecution(left, right) {
  return (
    Date.parse(left.updatedAt) - Date.parse(right.updatedAt) ||
    Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
    left.orderId.localeCompare(right.orderId)
  );
}

function compareOrdersByLifecycle(left, right) {
  return (
    Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
    Date.parse(left.updatedAt) - Date.parse(right.updatedAt) ||
    left.orderId.localeCompare(right.orderId)
  );
}

function compareOrdersByRelevantEvent(left, right) {
  const leftTime = left.executedQuantity > QUANTITY_EPSILON ? left.updatedAt : left.createdAt;
  const rightTime = right.executedQuantity > QUANTITY_EPSILON ? right.updatedAt : right.createdAt;
  return Date.parse(leftTime) - Date.parse(rightTime) || left.orderId.localeCompare(right.orderId);
}

function parseUtc8Timestamp(value, label) {
  const text = requiredText(value, label);
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(text);
  if (!match) throw new TypeError(`${label}格式无效：${text}`);
  const [, year, month, day, hour, minute, second] = match.map(Number);
  const utcTime = Date.UTC(year, month - 1, day, hour - 8, minute, second);
  const date = new Date(utcTime);
  const verification = new Date(utcTime + 8 * 60 * 60 * 1000);
  if (
    verification.getUTCFullYear() !== year ||
    verification.getUTCMonth() !== month - 1 ||
    verification.getUTCDate() !== day ||
    verification.getUTCHours() !== hour ||
    verification.getUTCMinutes() !== minute ||
    verification.getUTCSeconds() !== second
  ) {
    throw new TypeError(`${label}日期无效：${text}`);
  }
  return date.toISOString();
}

function formatUtc8MonthDay(isoTime) {
  return new Date(Date.parse(isoTime) + 8 * 60 * 60 * 1000).toISOString().slice(5, 10);
}

function orderStorageKey(order) {
  const profilePrefix = recordProfileKey(order);
  const legacyPrefix = profilePrefix === "profile-self" ? "" : `${profilePrefix}\u0000`;
  return `${legacyPrefix}${exchangeProviderForOrder(order)}\u0000${order.userId}\u0000${order.symbol}\u0000${order.orderId}`;
}

function candidateStorageKey(candidate) {
  return `${recordProfileKey(candidate)}\u0000${candidate.exchangeProvider ?? "binance-usdm"}\u0000${candidate.userId}\u0000${candidate.symbol}\u0000${candidate.positionSide}`;
}

function openPositionStorageKey(position) {
  return `${recordProfileKey(position)}\u0000${exchangeProviderForOrder(position)}\u0000${position.userId}\u0000${position.symbol}\u0000${normalizePositionSide(position.positionSide)}`;
}

function openPositionDirection(position) {
  if (position.side === "long") return 1;
  if (position.side === "short") return -1;
  const positionSide = normalizePositionSide(position.positionSide);
  if (positionSide === "LONG") return 1;
  if (positionSide === "SHORT") return -1;
  return Number(position.quantity) >= 0 ? 1 : -1;
}

function replayIdentity(trade) {
  return String(
    trade.sourceKey ??
      trade.id ??
      trade.sourceEntryOrderId ??
      trade.orderIds?.entry ??
      stableHash(JSON.stringify(trade)),
  );
}

function findBestReplayMatch(current, incoming) {
  return (
    current.find((trade) => trade?.id && trade.id === incoming.id) ??
    current.find(
      (trade) => trade?.sourceKey && incoming.sourceKey && trade.sourceKey === incoming.sourceKey,
    ) ??
    current.find((trade) => replaysReferToSameSource(trade, incoming)) ??
    current.find((trade) => automaticBinanceReplaysAreEquivalent(trade, incoming)) ??
    null
  );
}

function replaysReferToSameSource(left, right) {
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  if (recordProfileKey(left) !== recordProfileKey(right)) return false;
  if (replaysHaveConflictingProviders(left, right)) return false;
  if (left.id && right.id && left.id === right.id) return true;
  if (left.sourceKey && right.sourceKey && left.sourceKey === right.sourceKey) return true;
  const leftEntries = replayEntryIdentities(left);
  const rightEntries = new Set(replayEntryIdentities(right));
  if (leftEntries.some((entry) => rightEntries.has(entry))) return true;
  return automaticBinanceReplaysAreEquivalent(left, right);
}

function replayEntryIdentities(trade) {
  return uniqueStrings(
    [
      trade.sourceEntryOrderId,
      trade.orderIds?.entry,
      ...normalizeArray(trade.sourceEntryAliases),
    ].filter(
      (value) =>
        value !== null &&
        value !== undefined &&
        String(value).trim() !== "",
    ),
  );
}

function automaticBinanceReplaysAreEquivalent(left, right) {
  if (!isAutomaticBinanceReplay(left) || !isAutomaticBinanceReplay(right)) return false;
  if (recordProfileKey(left) !== recordProfileKey(right)) return false;
  if (replaysHaveConflictingProviders(left, right)) return false;
  if (String(left.symbol ?? "").toUpperCase() !== String(right.symbol ?? "").toUpperCase()) {
    return false;
  }
  if (left.side !== right.side) return false;
  if (!valuesNearlyEqual(left.quantity, right.quantity)) return false;
  if (!valuesNearlyEqual(left.entryPrice, right.entryPrice)) return false;
  if (!valuesNearlyEqual(left.exitPrice, right.exitPrice)) return false;
  return timestampsAreClose(left.entryTime, right.entryTime, 15_000) &&
    timestampsAreClose(left.exitTime, right.exitTime, 15_000);
}

function isAutomaticBinanceReplay(trade) {
  if (!trade || typeof trade !== "object") return false;
  return String(trade.sourceKey ?? "").startsWith("binance-futures:") ||
    String(trade.id ?? "").startsWith("import-binance-futures-");
}

function isAutomaticOkxReplay(trade) {
  if (!trade || typeof trade !== "object") return false;
  return String(trade.sourceKey ?? "").startsWith("okx-swap:") ||
    String(trade.id ?? "").startsWith("import-okx-swap-");
}

function isAutomaticReplayForProvider(trade, provider) {
  return provider === "okx-swap"
    ? isAutomaticOkxReplay(trade)
    : isAutomaticBinanceReplay(trade);
}

function replayProvider(trade) {
  if (isAutomaticOkxReplay(trade)) return "okx-swap";
  if (isAutomaticBinanceReplay(trade)) return "binance-usdm";
  return null;
}

function replaysHaveConflictingProviders(left, right) {
  const leftProvider = replayProvider(left);
  const rightProvider = replayProvider(right);
  return Boolean(leftProvider && rightProvider && leftProvider !== rightProvider);
}

function exchangeProviderForOrder(order) {
  const explicit = String(order?.exchangeProvider ?? "").toLowerCase();
  const sourceKind = String(order?.sourceKind ?? "").toLowerCase();
  const userId = String(order?.userId ?? "").toLowerCase();
  if (
    explicit === "okx-swap" ||
    sourceKind.startsWith("okx-api-") ||
    userId.startsWith("okx-swap:")
  ) {
    return "okx-swap";
  }
  return "binance-usdm";
}

function recordProfileKey(record) {
  return optionalText(record?.profileId) ?? "profile-self";
}

function optionalText(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function nullableFiniteNumber(value) {
  const number = Number(value);
  return value !== null && value !== undefined && Number.isFinite(number)
    ? number
    : null;
}

function mergeReplayRiskLevels(incomingRiskLevels, preservedOcrRiskLevels) {
  const merged = new Map();
  for (const level of normalizeArray(incomingRiskLevels)) {
    if (!level || typeof level !== "object") continue;
    merged.set(riskLevelIdentity(level), level);
  }
  for (const level of preservedOcrRiskLevels) {
    merged.set(riskLevelIdentity(level), level);
  }
  return [...merged.values()];
}

function riskLevelIdentity(level) {
  if (typeof level.id === "string" && level.id.trim() !== "") {
    return `id:${level.id}`;
  }
  return `fallback:${stableHash(JSON.stringify([
    level.source ?? "",
    level.kind ?? "",
    level.startTime ?? "",
    level.price ?? "",
  ]))}`;
}

function validateNormalizedOrder(order) {
  if (!order || typeof order !== "object") {
    throw new TypeError("Binance 订单记录必须是对象");
  }
  for (const field of ["userId", "orderId", "symbol", "orderType", "side", "status"] ) {
    if (typeof order[field] !== "string" || order[field].trim() === "") {
      throw new TypeError(`Binance 订单字段 ${field} 无效`);
    }
  }
  for (const field of ["originalQuantity", "executedQuantity", "executedQuoteQuantity"]) {
    if (!Number.isFinite(order[field]) || order[field] < 0) {
      throw new TypeError(`Binance 订单字段 ${field} 无效`);
    }
  }
  for (const field of ["createdAt", "updatedAt"]) {
    if (!Number.isFinite(Date.parse(order[field]))) {
      throw new TypeError(`Binance 订单字段 ${field} 无效`);
    }
  }
}

function validateOpenPosition(position) {
  if (!position || typeof position !== "object") {
    throw new TypeError("Binance 当前仓位必须是对象");
  }
  for (const field of ["userId", "symbol"]) {
    if (typeof position[field] !== "string" || position[field].trim() === "") {
      throw new TypeError(`Binance 当前仓位字段 ${field} 无效`);
    }
  }
  for (const field of ["quantity", "entryPrice", "markPrice"]) {
    if (!Number.isFinite(Number(position[field])) || Number(position[field]) <= 0) {
      throw new TypeError(`Binance 当前仓位字段 ${field} 无效`);
    }
  }
  if (position.updateTime && !Number.isFinite(Date.parse(position.updateTime))) {
    throw new TypeError("Binance 当前仓位字段 updateTime 无效");
  }
  if (
    position.syncedAt !== undefined &&
    position.syncedAt !== null &&
    normalizeOptionalTimestamp(position.syncedAt) === null
  ) {
    throw new TypeError("Binance 当前仓位字段 syncedAt 无效");
  }
  if (
    position.fundingFeesKnown !== undefined &&
    typeof position.fundingFeesKnown !== "boolean"
  ) {
    throw new TypeError("Binance 当前仓位字段 fundingFeesKnown 无效");
  }
  if (position.fundingFees !== undefined) {
    if (!Array.isArray(position.fundingFees)) {
      throw new TypeError("Binance 当前仓位字段 fundingFees 无效");
    }
    for (const fundingFee of position.fundingFees) {
      if (
        !fundingFee ||
        typeof fundingFee !== "object" ||
        fundingFee.userId !== position.userId ||
        fundingFee.symbol !== position.symbol ||
        typeof fundingFee.transactionId !== "string" ||
        fundingFee.transactionId.trim() === "" ||
        !Number.isFinite(Number(fundingFee.amount)) ||
        typeof fundingFee.asset !== "string" ||
        fundingFee.asset.trim() === "" ||
        !Number.isFinite(Date.parse(String(fundingFee.time ?? "")))
      ) {
        throw new TypeError("Binance 当前仓位资金费流水无效");
      }
    }
  }
}

function normalizeOptionalTimestamp(value) {
  const timestamp =
    typeof value === "number" ? value : Date.parse(String(value ?? ""));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function parseCsvRows(source) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (character === '"') {
        if (source[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += character;
      }
      continue;
    }

    if (character === '"' && cell === "") {
      quoted = true;
    } else if (character === ",") {
      row.push(cell);
      cell = "";
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && source[index + 1] === "\n") index += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += character;
    }
  }

  if (quoted) throw new SyntaxError("CSV 存在未闭合的引号");
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function optionalPositiveNumber(value, label) {
  if (String(value ?? "").trim() === "") return null;
  const number = nonNegativeNumber(value, label);
  return number === 0 ? null : number;
}

function nonNegativeNumber(value, label) {
  const text = String(value ?? "").trim();
  if (text === "") throw new TypeError(`${label}不能为空`);
  const number = Number(text);
  if (!Number.isFinite(number) || number < 0) {
    throw new TypeError(`${label}必须是大于或等于 0 的数字`);
  }
  return number;
}

function requiredText(value, label) {
  const text = String(value ?? "").trim();
  if (!text) throw new TypeError(`${label}不能为空`);
  return text;
}

function uniqueStrings(values) {
  return [...new Set(values.map(String))];
}

function uniqueOrders(orders) {
  const unique = new Map();
  for (const order of orders) unique.set(orderStorageKey(order), order);
  return [...unique.values()];
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function stableHash(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function cleanNumber(value) {
  return Number(value.toFixed(12));
}

function valuesNearlyEqual(left, right) {
  if (left === null || left === undefined || right === null || right === undefined) {
    return left === right;
  }
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (!Number.isFinite(leftNumber) || !Number.isFinite(rightNumber)) return false;
  const scale = Math.max(1, Math.abs(leftNumber), Math.abs(rightNumber));
  return Math.abs(leftNumber - rightNumber) <= scale * 1e-9;
}

function timestampsAreClose(left, right, toleranceMs) {
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  return Number.isFinite(leftTime) && Number.isFinite(rightTime) &&
    Math.abs(leftTime - rightTime) <= toleranceMs;
}
