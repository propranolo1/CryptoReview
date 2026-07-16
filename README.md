# 复盘舱（CryptoReview）

复盘舱用于导入历史交易仓位，在真实历史 K 线上标记入场、离场、止盈和止损，并从入场点开始逐根回放，实时查看已实现、未实现与总盈亏。

## 当前能力

- 导入 CSV / JSON 仓位，兼容中英文字段。
- 支持多仓、空仓、手续费和分批平仓。
- 通过同源服务端代理读取 Binance Spot 公共历史 K 线。
- 支持 5 分钟、15 分钟、1 小时、4 小时和日线切换。
- 支持播放、暂停、前后单步、重置、进度拖动和倍速。
- 图表标记入场/离场成交，并绘制固定止盈止损计划线。
- 复盘结果与笔记保存在当前浏览器，不上传导入文件。
- 网络不可用时使用明确标识的演示 K 线，盈亏仍按导入成交计算。

## 本地运行

需要 Node.js `>=22.13.0`。

```bash
npm install
npm run dev
```

打开终端输出的本地地址，默认是 `http://localhost:3000`。

## 验证

```bash
npm test
npm exec tsc -- --noEmit
```

`npm test` 会先执行生产构建，再运行服务端首屏、导入解析和交易盈亏回归测试。

## 导入字段

最小 CSV 示例：

```csv
symbol,side,quantity,entryPrice,entryTime,stopLoss,takeProfit,exitPrice,exitTime,fee
BTCUSDT,long,0.18,94250,2025-05-06T08:00:00Z,91700,101200,101450,2025-05-09T01:00:00Z,13.8
```

必需字段：`symbol`、`side`、`quantity`、`entryPrice`、`entryTime`。`side` 可使用 `long/short`、`buy/sell` 或中文方向。JSON 可通过 `exits` 数组表达多笔离场成交。

## 说明

- 当前行情适配器是 Binance Spot；合约仓位需要后续接入对应 Futures 数据源后再使用。
- K 线 OHLC 无法判断同一根蜡烛内止盈和止损哪个先触发，因此系统不会根据价格线猜测成交，最终盈亏只使用导入的真实成交记录。
- Binance 单次最多返回 1000 根 K 线；跨度很长时，细周期可能无法覆盖最终离场点。
- 本项目只用于交易复盘，不构成投资建议，也不执行任何下单操作。

更完整的架构和修改约定见 [AI_README.md](./AI_README.md)。
