/** API 更新结束前，显式等待合并后的订单与复盘都写入桌面数据库。 */
export async function persistDesktopReplaySnapshot(
  desktopApi,
  { orders, trades },
) {
  if (
    !desktopApi ||
    typeof desktopApi.saveOrders !== "function" ||
    typeof desktopApi.saveTrades !== "function"
  ) {
    throw new TypeError("桌面复盘保存接口不可用");
  }
  if (!Array.isArray(orders) || !Array.isArray(trades)) {
    throw new TypeError("桌面复盘快照必须包含订单和复盘数组");
  }

  await Promise.all([
    desktopApi.saveOrders(orders),
    desktopApi.saveTrades(trades),
  ]);
}
