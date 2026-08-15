import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const projectUrl = new URL("../", import.meta.url);

test("顶部提供复盘用户切换和新建入口，导入只作用于当前用户", async () => {
  const [component, globals] = await Promise.all([
    readFile(new URL("app/components/TradeReplay.tsx", projectUrl), "utf8"),
    readFile(new URL("app/globals.css", projectUrl), "utf8"),
  ]);

  assert.match(component, /复盘用户/);
  assert.match(component, /新建用户/);
  assert.match(component, /activeProfileId/);
  assert.match(component, /filterRecordsByTradeProfile/);
  assert.match(component, /导入到：\{activeProfile\.name\}/);
  assert.match(component, /<FollowTradeImport/);
  assert.match(component, /profileId:\s*activeProfileId/);
  assert.match(globals, /\.profile-switcher/);
  assert.match(globals, /\.profile-create-dialog/);
});

test("跟单截图提供本地 OCR 校对并明确目标用户", async () => {
  const [component, runner] = await Promise.all([
    readFile(new URL("app/components/FollowTradeImport.tsx", projectUrl), "utf8"),
    readFile(new URL("app/lib/follow-trade-ocr.ts", projectUrl), "utf8"),
  ]);

  assert.match(component, /识别跟单记录/);
  assert.match(component, /OCR 跟单记录校对/);
  assert.match(component, /导入到“\{profileName\}”/);
  assert.match(component, /图片仅在本机识别，不会上传/);
  assert.match(component, /开多/);
  assert.match(component, /平多/);
  assert.match(component, /截图盈亏/);
  assert.match(runner, /parseFollowTradeTimelineText/);
  assert.match(runner, /\["chi_sim", "eng"\]/);
});
