import assert from "node:assert/strict";
import test from "node:test";

import {
  BINANCE_SMART_MONEY_PROFILE_ID,
  DEFAULT_TRADE_PROFILE_ID,
  XIAOHONG_TRADE_PROFILE_ID,
  createTradeProfile,
  filterRecordsByTradeProfile,
  getTradeProfileId,
  isProtectedTradeProfile,
  normalizeTradeProfiles,
  removeRecordsForTradeProfile,
  removeTradeProfile,
} from "../lib/trade-profiles.mjs";

test("旧记录自动归入我的账户，并预置小洪用户", () => {
  const profiles = normalizeTradeProfiles([]);

  assert.deepEqual(
    profiles.map(({ id, name }) => ({ id, name })),
    [
      { id: DEFAULT_TRADE_PROFILE_ID, name: "我的账户" },
      { id: XIAOHONG_TRADE_PROFILE_ID, name: "小洪" },
      {
        id: BINANCE_SMART_MONEY_PROFILE_ID,
        name: "不停梭- · 1万U不停梭挑战",
      },
    ],
  );
  assert.equal(getTradeProfileId({ id: "legacy-trade" }), DEFAULT_TRADE_PROFILE_ID);
  assert.equal(
    getTradeProfileId({ id: "xiaohong-trade", profileId: XIAOHONG_TRADE_PROFILE_ID }),
    XIAOHONG_TRADE_PROFILE_ID,
  );
});

test("复盘与订单可以按用户严格隔离", () => {
  const records = [
    { id: "legacy" },
    { id: "self", profileId: DEFAULT_TRADE_PROFILE_ID },
    { id: "xiaohong", profileId: XIAOHONG_TRADE_PROFILE_ID },
  ];

  assert.deepEqual(
    filterRecordsByTradeProfile(records, DEFAULT_TRADE_PROFILE_ID).map((item) => item.id),
    ["legacy", "self"],
  );
  assert.deepEqual(
    filterRecordsByTradeProfile(records, XIAOHONG_TRADE_PROFILE_ID).map((item) => item.id),
    ["xiaohong"],
  );
});

test("可新建额外用户，并拒绝空名称与重名", () => {
  const profiles = normalizeTradeProfiles([]);
  const next = createTradeProfile(profiles, "阿杰", 1_785_427_200_000);

  assert.equal(next.name, "阿杰");
  assert.match(next.id, /^profile-/);
  assert.equal(next.createdAt, "2026-07-30T16:00:00.000Z");
  assert.throws(() => createTradeProfile(profiles, "  "), /用户名称/);
  assert.throws(() => createTradeProfile(profiles, "小洪"), /已经存在/);
});

test("可删除新建用户及其记录，但不能删除内置用户", () => {
  const profiles = normalizeTradeProfiles([]);
  const custom = createTradeProfile(profiles, "阿杰", 1_785_427_200_000);
  const withCustom = [...profiles, custom];
  const records = [
    { id: "legacy" },
    { id: "custom-order", profileId: custom.id },
    { id: "xiaohong-order", profileId: XIAOHONG_TRADE_PROFILE_ID },
  ];

  assert.equal(isProtectedTradeProfile(custom.id), false);
  assert.equal(isProtectedTradeProfile(DEFAULT_TRADE_PROFILE_ID), true);
  assert.deepEqual(
    removeTradeProfile(withCustom, custom.id).map((profile) => profile.id),
    profiles.map((profile) => profile.id),
  );
  assert.deepEqual(
    removeRecordsForTradeProfile(records, custom.id).map((record) => record.id),
    ["legacy", "xiaohong-order"],
  );
  assert.throws(
    () => removeTradeProfile(withCustom, XIAOHONG_TRADE_PROFILE_ID),
    /内置用户不能删除/,
  );
});
