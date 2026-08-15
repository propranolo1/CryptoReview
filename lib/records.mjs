/**
 * 按用户提供的三张订单截图创建 HYPE 实盘复盘记录。
 * 入场时间使用实际成交时间；截图未显示止损触发价，因此不补造止损计划线。
 */
export function createHypeScreenshotTrade() {
  const entryTime = "2026-07-16T07:33:17.000Z";
  const exitTime = "2026-07-16T08:04:17.000Z";

  return {
    id: "hype-screenshot-review",
    title: "07-16 截图订单复盘",
    strategy: "限价开多 · 止盈改单 · 触发平仓",
    notes:
      "订单 10905798348 于 15:33:17 以 66.431 全量开多 22.88 HYPE；止盈单 10908281928 于 15:35:25 挂在 67.179，16:04:17 过期；订单 10909765328 同时触发市价平多，成交均价 65.79016。截图未显示止损触发价，因此只标记止损成交，不补画止损计划线。",
    symbol: "HYPEUSDT",
    side: "long",
    quantity: 22.88,
    entryPrice: 66.431,
    entryTime,
    stopLoss: null,
    takeProfit: null,
    exitPrice: 65.79016,
    exitTime,
    fee: 0.30398825,
    exits: [
      {
        quantity: 22.88,
        exitPrice: 65.79016,
        exitTime,
        fee: 0.75263954,
      },
    ],
    riskLevels: [
      {
        id: "tp-10908281928",
        orderId: "10908281928",
        kind: "takeProfit",
        price: 67.179,
        startTime: "2026-07-16T07:35:25.000Z",
        endTime: exitTime,
        endState: "expired",
      },
    ],
    orderIds: {
      entry: "10905798348",
      takeProfit: "10908281928",
      exit: "10909765328",
    },
    exitLabel: "止损成交",
    marketDataSource: "binance-futures",
    reportedRealizedPnl: -14.6622,
  };
}
