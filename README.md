# 复盘舱（CryptoReview）

复盘舱用于导入历史交易仓位，在真实历史 K 线上标记入场、离场、止盈和止损，并从入场点开始逐根回放，实时查看已实现、未实现与总盈亏。

## 当前能力

- 提供基于 Electron 43（内置 Node.js 24）的 Windows x64 与 macOS Apple Silicon / Intel 桌面版，行情请求、导入与存储都在本机完成。
- Windows 安装版启动后会检查公开 GitHub Release；发现新版本后在后台下载，并允许用户点击“重启更新”。顶部版本按钮也可随时手动检查。
- 导入通用 CSV / JSON 仓位，兼容中英文字段。
- 可直接导入 Binance U 本位合约订单历史 CSV，按成交记录自动生成完整开平仓复盘。
- 支持多仓、空仓、手续费和分批平仓。
- 通过同源服务端代理读取 Binance Spot 与 USDⓈ-M Futures 公共历史 K 线。
- 桌面版可连接 Binance USER_DATA 只读 API，自动发现账户交易对并分别同步基础委托和新版 Algo 条件单；密钥由当前操作系统安全存储加密，不进入网页或明文数据库。
- 桌面版也可连接 OKX USDT 线性永续只读 API，同步基础单、条件单、逐笔成交、手续费与当前未平仓仓位。OKX API Key、Secret、Passphrase、账户 UID 和区域全部由 Electron `safeStorage` 加密，只保存于本机。
- 支持 5 分钟、15 分钟、1 小时、4 小时和日线切换。
- 支持单根 K 线逐步形成，完成后再进入下一根，并提供播放、暂停、前后单步、重置、进度拖动和倍速。
- 图表使用位于蜡烛上下方的 BUY/SELL 箭头标记成交，绘制黄色虚线成本线，并按历史挂单时间动态显示止盈止损线。
- 图表支持 EMA21、EMA200、成交量、OI、Delta、CVD 六项指标独立开关；日间/夜间按钮切换整个软件，K 线画布始终使用白底黑白风格，成交量保持涨绿跌红，OI 覆盖入场前可见 K 线。
- 左侧可按 UTC+8 最终平仓日期筛选，交易只在最后平仓日出现一次；选择“全部”时交易列表在侧栏内部滚动，不会拉长整页。顶部可切换到独立的“交易表现”模块，查看累计盈利曲线、每日盈利、胜率和平均盈亏比。
- 桌面版使用本地 SQLite 保存原始订单、交易所当前仓位快照、复盘与笔记；API 更新完成后，重新打开软件会直接恢复本机数据，无需再次更新。网页模式继续使用浏览器存储。数据不会上传，重复导入也不会重复创建记录。
- 网络不可用时使用明确标识的演示 K 线，盈亏仍按导入成交计算。
- 内置 HYPE 截图订单复盘，以及基于 2026-07-15（UTC+8）Binance 历史 K 线的 BTC、SOL 模拟交割。

## Windows 桌面版

安装依赖后，可直接构建并启动桌面应用：

```bash
npm install
npm run desktop:run
```

桌面版通过 Electron 安全窗口加载仅监听 `127.0.0.1` 的本地服务。窗口开启上下文隔离、沙箱与 Web 安全，关闭 Node.js 页面集成；preload 只暴露固定的存储、Binance / OKX 只读同步与视频导出 IPC，不开放通用主进程调用。

订单与复盘默认保存到：

```text
%APPDATA%/CryptoReview/data/cryptoreview.db
```

代码实际使用 `app.getPath("userData")/data/cryptoreview.db`，因此在用户或系统自定义 Electron 数据目录时，以应用返回的路径为准。首次打开桌面版时，已有浏览器 `localStorage` 中的 Binance 订单、导入复盘和笔记会与 SQLite 内容合并并迁移保存；若数据库读取失败，应用会提示并回退到浏览器本地存储。

生成 Windows x64 便携目录：

```bash
npm run desktop:package
```

主程序输出为 `out/CryptoReview-win32-x64/CryptoReview.exe`；该目录用于便携运行和开发核对，不具备原地自动更新能力。

生成支持自动更新的 Windows 安装包：

```bash
npm run desktop:make:win
```

产物位于 `out/make/squirrel.windows/x64/`，其中 `CryptoReview Setup.exe` 是首次安装入口。自动更新只对通过该安装器安装的版本生效；便携目录仍可运行，但不会替换自身文件。当前 Windows 安装包尚未代码签名，系统可能显示安全提示。

## GitHub 发布与版本更新

公开仓库为 `propranolo1/CryptoReview`。推送 `v*` 标签后，GitHub Actions 会运行完整测试、生成 Squirrel.Windows 安装包并创建同名 GitHub Release。日常版本可使用：

```bash
npm run release:patch
npm run release:minor
npm run release:major
```

这些命令会更新 `package.json` 与锁文件版本、创建 Git 标签，并把 `main` 和标签推送到 GitHub。应用启动约 15 秒后自动检查，之后每 6 小时检查一次；顶部版本按钮可立即手动检查。macOS 当前未签名，因此只提示 GitHub 新版本并打开 Release 下载页，不执行应用内自动安装。

## macOS 桌面版

项目提供 macOS Apple Silicon（arm64）与 Intel（x64）的 ZIP 打包脚本：

```bash
npm run desktop:make:mac:arm64
npm run desktop:make:mac:x64
```

也可以依次生成两个架构：

```bash
npm run desktop:make:mac
```

产物位于 `out/make/zip/darwin/` 下对应的 `arm64` 或 `x64` 目录。当前 macOS 应用未进行 Apple Developer ID 代码签名或公证，首次打开可能被 Gatekeeper 拦截。Windows 主机可以准备 macOS 打包产物，但不能完成 Apple 公证，也不能替代真实 Mac 上的启动、Keychain、视频编码和权限验证；交付前必须分别在 Apple Silicon 与 Intel Mac 上实测。

Windows 与 macOS 使用各自操作系统的安全存储。SQLite 中的 API 密文不能跨系统或跨系统用户解密；迁移订单和复盘数据库后，需要在新系统重新连接 Binance / OKX API。

## 网页开发模式

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

### Binance U 本位订单历史

从 Binance 导出的“合约订单历史记录”CSV 可以直接导入，无需先整理成上面的通用字段。系统会保存文件中的原始订单，并根据已成交数量、买卖方向和订单更新时间重建能够完整闭合的交易；同一文件再次导入时会稳定更新已有订单和复盘，不会产生重复记录。

订单历史重建默认采用单向持仓模式，并假设导入范围开始时净仓位为 0。无法在当前导入范围内闭合，或无法确认是开仓还是平仓的记录，只会保存在原始订单库中，不会生成可能错误的复盘。

### Binance 个人 API 同步（仅桌面版）

点击顶部“交易所 API”并选择 Binance，输入 API Key 与 Secret 后验证连接。请使用只开放 USER_DATA、关闭交易和提现权限并设置 IP 白名单的独立 Key。Secret 不会上传或写入 `localStorage`/日志；提交后由 Electron 主进程签名，经过系统安全存储加密后才写入本机 SQLite，表单中的明文会立即清空。应用会使用 Binance 返回的唯一账户别名生成稳定本地标识，同一账户断开或更换 Key 后重新同步不会重复生成复盘。

同步时只需选择日期范围，不再手动填写交易对。应用会从指定范围的收益流水、全账户当前基础/Algo 挂单和本机已有档案自动发现交易对，再按 Binance 的要求逐交易对查询历史，并把区间拆成不足 7 天的窗口；单个窗口若达到 1000 条上限，还会继续按时间细分，HTTP 429 会按官方 `Retry-After` 等待后重试。结果会与 CSV/OCR 订单稳定合并，并按 `positionSide` 分开还原双向持仓。订单、当前未平仓仓位快照与复盘全部写入 SQLite 后才提示更新成功，下一次启动会直接恢复。官方普通单和条件单历史最多约 90 天；撤销或过期且零成交的旧单可能只保留 3 天，因此应定期同步并保留本地数据库。

### OKX 个人 API 同步（仅桌面版）

在顶部交易所 API 窗口选择 OKX，填写 API Key、Secret、Passphrase 与账户区域。区域支持 `global`、`us`、`eea`，默认 `global`。请创建只读 Key，关闭交易和提币权限，并配置 IP 白名单。

连接验证、签名和请求只发生在 Electron 主进程。API Key、Secret、Passphrase、OKX 账户 UID 和区域会一起通过系统 `safeStorage` 加密，明文不会进入 `localStorage`、日志或普通应用状态。切换电脑、操作系统或系统用户后必须重新连接。

同步时只选择日期范围，无需逐个填写交易对。应用会从 OKX USDT 线性永续的订单、条件单、逐笔成交和当前仓位中自动发现合约，读取最近约 3 个月的可用历史并立即保存到 SQLite。OKX 的成交数量 `sz` 是合约张数，不能直接当作币数量；同步器会读取合约规格，并按 `ctVal` 与 `ctValCcy` 换算成项目统一使用的标的币数量，再进行仓位和盈亏重建。

## 说明

- HYPE 等永续记录使用 Binance USDⓈ-M Futures `/fapi/v1/klines`；若官方接口因网络位置受限，页面会明确标识演示行情，不会把其他交易所数据标成 Binance。
- Binance CSV 订单历史没有逐笔成交时间，复盘使用订单“更新时间”近似作为成交时间；文件也不含手续费、`positionSide` 和 `reduceOnly`，因此 CSV 重建的盈亏不含手续费，也不能可靠还原双向持仓。个人 API 返回 `positionSide` 时可分别还原 LONG/SHORT，但任何来源都无法补出同步范围开始前已经存在的仓位。
- 由 Binance U 本位订单历史生成的复盘始终使用 Binance USDⓈ-M Futures 行情，不按现货行情回放。
- OKX 同步得到的是 OKX 真实订单、成交、手续费与仓位，但当前复盘图表仍读取 Binance USDⓈ-M Futures 公共历史行情，并会分别标明订单来源与行情来源。两所价格可能存在细微差异；若 OKX 合约在 Binance 没有对应 U 本位交易对，该笔记录仍会保存在本机，但可能无法显示 K 线或导出视频。
- OKX 私有历史接口可取得的范围约为最近 3 个月，不能把交易所接口当作永久档案；应定期同步并备份本机 SQLite。
- K 线 OHLC 无法判断同一根蜡烛内止盈和止损哪个先触发，因此系统不会根据价格线猜测成交，最终盈亏只使用导入的真实成交记录。
- Binance 单次最多返回 1000 根 K 线；跨度很长时，细周期可能无法覆盖最终离场点。
- 本项目只用于交易复盘，不构成投资建议，也不执行任何下单操作。

更完整的架构和修改约定见 [AI_README.md](./AI_README.md)。
