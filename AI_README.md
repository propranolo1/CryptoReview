# CryptoReview 架构说明

## 项目目标

CryptoReview 是一个交易复盘工具。用户导入历史仓位与止盈止损设置后，系统读取对应交易对的历史 K 线，在图表中标注入场、离场、止盈和止损，并从入场位置逐根回放，最终计算这笔交易的已实现、未实现和总盈亏。

## 当前版本范围

- 数据源：现货交易读取 Binance Spot，永续合约读取 Binance USDⓈ-M Futures 公共历史 K 线；行情不需要 API Key。桌面版可选连接只读 Binance USER_DATA API，或 OKX USDT 线性永续只读 API，同步账户基础委托、条件单、逐笔成交手续费与当前未平仓快照。OKX 订单复盘当前仍使用 Binance USDⓈ-M Futures 公共行情，订单来源与行情来源分开标记。
- 内置复盘：HYPEUSDT 使用用户截图中的真实开仓、止盈挂单变化与触发平仓记录；BTCUSDT、SOLUSDT 使用 2026-07-15（UTC+8）历史 K 线模拟交割。
- 导入格式：通用仓位 CSV/JSON，或 Binance U 本位合约订单历史 CSV；订单历史可直接按成交记录重建复盘。
- 本地 OCR：顶部统一“导入”菜单内可选择订单记录、基础单截图、条件单截图或跟单时间线截图。基础单写入订单档案并重建开平仓；条件单只给已有复盘补充 TP/SL 动态挂单；跟单截图识别“开启/关闭做多或做空”、均价、成交数量、总价值与已实现盈亏，校对后按当前复盘用户保存。图片不会上传。
- 复盘用户：顶部可切换或新建彼此隔离的复盘用户，默认保留“我的账户”、预置“小洪”，并预置由 Binance 聪明钱主页 `5078319056891617536` 解析出的“不停梭- · 1万U不停梭挑战”。旧版本没有 `profileId` 的订单和复盘自动归入“我的账户”；CSV、JSON、基础单 OCR、条件单 OCR 与跟单 OCR 均只写入当前用户，交易列表、日期筛选与交易表现也只读取当前用户。交易所 API 凭证仍属于本机自己的账户，只能在“我的账户”下更新，避免把私有 API 数据误归入他人档案。
- 公开带单同步：每个复盘用户都可在“导入 → 同步公开带单”中绑定一个 Binance 公开带单主页。首次手动同步按页读取完整公开成交历史，之后软件打开时可按 30 秒、1 分钟或 5 分钟在本机自动轮询最近成交与当前仓位；成交使用主页返回的方向、持仓方向、数量、均价、已实现盈亏和时间重建，重复轮询使用稳定事件 ID 合并。仓位快照只用于核对未平仓数量与提示开仓/加仓/减仓/平仓变化，不会把缺少成交价的快照差分伪造成交易。
- 聪明钱主页同步：“导入 → 同步聪明钱”接受 Binance 官方 `/smart-money/profile/{topTraderId}` URL，先由固定本地代理读取公开身份资料，再使用返回的 `futuresCopyTradePortfolioId` 绑定其官方关联的公开合约带单档案。首次导入自动创建或更新独立复盘用户、切换到该用户并完整分页同步成交，之后复用公开带单轮询与 SQLite 持久化；同一 URL 使用稳定用户 ID，不会重复建用户或重复保存订单。聪明钱网页的“仓位/仓位历史/最新操作记录”接口本身要求 Binance 登录，应用不读取登录 Cookie，也不绕过私有接口；只有存在官方公开关联档案时才生成真实回放，否则明确拒绝，不根据表现或仓位猜测成交。
- 方向：多仓与空仓。
- 图表：固定白底黑白空心 K 线、蓝色点状现价线、EMA21、EMA200、成交量、OI、Delta、CVD、成交量染色、位于蜡烛上下方的 BUY/SELL 箭头、黄色虚线成本线，以及随回放时刻出现或移除的止盈/止损价格线。成交量染色默认使用前 20 根平均量计算 RVOL，并以 30 根回看窗口统计最高/最低量；RVOL 严格超过 3 倍或成为窗口最高量时，上涨 K 线染绿、下跌 K 线染红，RVOL 不高于 0.25 倍或成为窗口最低量时统一染黄，两个周期可在“指标显示”中调整。每笔基础开仓、加仓和平仓都会在实际成交时刻生成箭头；黄色成本线只按截至当前已经发生的开仓成交动态加权。K 线上方持续显示当前仓位比例条：满仓填满轨道，减仓后显示 `1/2` 等剩余比例，加仓来源使用同方向的相近色阶分段。各项指标可独立开关；日间/夜间开关切换整个软件外观，K 线画布始终保持白色。
- XIN Mentorship：按用户提供的 Pine Script v6 默认参数实现独立副图，包含 WT1/WT2、±53/±60 超买超卖线、MFI 面积、复合动量柱、普通/强力/黄金买入、普通/强力卖出、WEAK/BLDG 预警与背离标记。交易回放中默认开启并可从“指标显示”独立关闭，状态栏显示当前 XIN 状态、WT1，并在悬停提示 RSI、MFI、Momentum 与 Accel；训练模式在当前选中的主图周期显示该副图，4H/1D 小图保持原布局。所有计算只使用当前回放游标以前的数据和正在形成的当前 K 线，不读取未来行情；脚本自带回测统计不并入真实交易或训练表现。
- 回放：5 分钟、15 分钟、1 小时、4 小时、1 天；支持播放、暂停、单步、重置和速度切换。切换时间周期时以当前绝对回放时间重新定位到目标周期的 K 线内部进度，切换前正在播放则在目标周期行情加载后继续播放；切换交易仍从新交易入场点开始。改单、TP/SL 触发及部分/全部平仓直接标在现有进度条上，颜色区分操作类型，悬停或键盘聚焦时才显示详情。仓位比例、动态成本、累计手续费和盈亏只使用当前回放时刻以前的开仓、加仓和平仓；平仓盈亏按发生当时的加权成本锁定，后续加仓不会反向改写。仓位比例分母为截至当前已经出现过的最大持仓，不提前暴露未来加仓。回放工作区使用“交易列表 + 主图”双栏布局，当前盈亏与视频导出位于图表工具栏，右侧详情栏不再占用主图宽度。
- 视频导出：每笔已完全平仓的交易可在“回放结果”中导出固定 1920×1080 的本地复盘视频。视频统一以 5 分钟 K 线为播放基准，默认从入场前 10 根开始、到最终平仓后 100 根结束，前后数量可编辑，并可选择 0.5×、1×、2×、4× K 线速度。主图固定保留 80 个可视槽位和播放起点之前的行情上下文，右侧不再显示交易详情，改为同步显示由当前回放时刻 5 分钟数据聚合出的 1H、4H、1D 小图；主图与底部操作进度之间同步绘制当前仓位比例条。画面继承动态成本、逐笔 BUY/SELL 与盈亏快照；成交箭头在其 K 线仍处于 80 槽窗口期间持续显示，同根同方向多笔成交会错位避免重叠。桌面版边编码边写盘，不上传视频。
- 训练模式：随机截取一段 Binance USDⓈ-M Futures 的 BTCUSDT 15m 历史行情作为推进和成交触发基准，主图可切换显示 15m、1H、4H、1D，并在右侧上下保留由已揭示 15m 行情聚合的 4H、1D 小图；主图每局或切换周期时默认显示约 80 根，小图最多显示 30 根。训练交易页只保留顶部交易工具栏，删除下方重复的“模拟下单”和“训练账户”面板，图表按桌面窗口剩余高度撑满首屏；本局操作审计仍位于图表下方。主图与两个小图均使用 RVOL/最高最低量 K 线染色，彩色只填充实体，黑色描边和影线始终保留；下方成交量柱继续使用涨绿跌红。所有图表支持缩放与平移，同一局逐根推进、下单及 TP/SL 修改不会覆盖当前周期的手动视口。开局通过单页不超过 1,000 根的向前分页保留 2,880 根 15m 历史上下文和 160 根待训练行情，可形成约 30 根日线，但图表只接收当前游标及此前数据。逐根推进时，主图 K 线、成交量、量能染色与 XIN 指标只追加或更新最后一个点，1H/4H/1D 使用一次性缓存聚合器；仅新训练局或切换时间框架时整批初始化。绘图投影按动画帧合并缩放、平移和拖动事件，无坐标变化时不触发 React 更新；成本、TP/SL 与限价线也只按差异创建、更新或移除。用户可点击按钮或按右方向键逐根推进，可做多、做空、按 10%/25%/50%/100% 资金开仓或加仓，并按相同比例减仓或全部平仓。持仓后可拖动黄色成本线向盈利/亏损方向设置 TP/SL；TP 与 SL 使用顶部当前选中的本次操作比例作为触发仓位，部分触发后只移除已成交的风险线。主图目标价格处点击鼠标右键可按 25%/50%/100% 创建 BUY/SELL LIMIT，点击图中的挂单线可确认撤单；挂单从下一根 15m K 线起按 OHLC 判断，跳空时按限价或更优开盘价成交，挂单线、撤单、成交与失效记录均进入完整操作审计。主图绘图工具支持水平线、矩形框与矩形填充色；绘图使用统一的真实时间和价格坐标，在 15m、1H、4H、1D 主图切换以及右侧 4H/1D 小图间同步，矩形时间端点按目标周期的 UTC K 线桶投影。当前片段走完仍有持仓或未成交限价单时继续读取后续真实 K 线，清仓且撤销全部挂单前禁止结束训练。每次开仓、加仓、减仓、平仓、限价单生命周期和 TP/SL 修改都会保存现实记录时间、历史 K 线索引与 OHLC、操作前后仓位、数量、保证金和盈亏；自动触发明确标记为“K 线内触发，精确秒数未知”。训练成绩使用独立看板统计累计盈亏、胜率、平均盈亏比，并可展开查看每局完整操作明细，不混入真实交易表现；从未发生开仓的空训练局不进入总局数、胜率、累计盈亏、每日汇总、R、回撤、持仓时间和方向/周期成绩，实际完成过交易但最终盈亏为 0 的平手局仍正常计入。“训练表现”内可把全部已完成记录导出为带版本号的 JSON、重新导入并按训练 id 合并，或在确认后清空全部已完成训练，导入与清空都会沿用现有本地持久化流程。
- 训练绘图调整：矩形填充色固定为灰、绿、红三种；点击矩形后显示四个角点，拖动框体可整体移动，拖动角点可调整时间和价格范围，选中矩形后点击色块可直接换色。所有修改继续同步到 15m、1H、4H、1D 主图及右侧高周期小图。
- 结果：已实现盈亏、未实现盈亏、总盈亏、实际手续费、收益率、持仓数量和风险收益比。
- 归档与统计：交易按 UTC+8 的最终平仓日期唯一归档；未平仓交易只出现在“全部”，不会混入平仓日期。左栏以徽标显示成交记录来自 Binance API、OKX API、CSV、OCR 或手动导入；顶部可在“交易回放”“交易表现”和“训练模式”间切换。真实交易表现展示累计盈利曲线、每日盈利柱图与日历、胜率、平均盈亏比及已平仓手续费合计；训练成绩由训练模式内的独立看板统计，二者不混合。
- 运行形态：既保留网页开发模式，也提供基于 Electron 43（内置 Node.js 24）的 Windows x64、macOS arm64 与 macOS x64 桌面版；桌面版仍完全在本机运行，不依赖云端部署。桌面窗口初始使用 1600×1000 的回退尺寸，并在首次显示时最大化以适配当前屏幕工作区。
- 版本发布：源码发布到公开仓库 `propranolo1/CryptoReview`。Windows 使用 Electron Forge Squirrel maker 生成 Setup、`.nupkg` 与 `RELEASES`，推送 `v*` 标签后由 GitHub Actions 完整测试并创建 Release。桌面主进程只请求固定 GitHub Release API 与 `update.electronjs.org`，启动 15 秒后及每 6 小时检查一次；顶部版本按钮支持手动检查，下载完成后由用户确认重启安装。便携目录和开发模式只检测版本、不替换自身；未签名 macOS 构建只提示 Release 下载页。
- 存储：网页模式继续使用浏览器 `localStorage`；桌面版将复盘用户、订单、复盘、各交易所账户最后一次同步的未平仓仓位快照和已完成训练成绩写入本地 SQLite，其中仓位快照按交易所与账户隔离，复盘用户与训练成绩使用独立数据表。每次 API 更新会先在同一数据库事务中保存订单与当前仓位快照，再保存重建后的复盘；所有写入完成后界面才提示更新成功。冷启动直接读取这些数据恢复，无需再次点击更新。订单去重键在原有交易所、账户、交易对和订单号之前加入可选复盘用户范围；旧记录继续沿用原键，新用户的同一订单不会覆盖“我的账户”。Binance API Key / Secret，以及 OKX API Key / Secret / Passphrase / 账户 UID / region，均由 Electron `safeStorage` 使用当前操作系统安全存储加密后写入 SQLite；明文不进入 `localStorage`、日志或 `loadState()`，凭证表单提交后也会清空。

## 代码结构

```text
app/
  api/copy-trade/lead-portfolio/route.ts # 固定代理 Binance 公开带单详情、仓位与分页成交历史
  api/smart-money/profile/route.ts # 固定读取 Binance 聪明钱公开身份与官方关联合约带单 ID
  api/market/klines/route.ts  # Binance Spot / USDⓈ-M Futures K 线同源代理与参数校验
  api/market/open-interest/route.ts # Binance USDⓈ-M Futures 历史 OI 代理
  components/TradeReplay.tsx # 导入、交易列表、图表、回放与结果界面
  components/BasicOrderImport.tsx # 基础单截图识别、字段校对与批量写入
  components/ConditionOrderImport.tsx # 条件单截图识别、交易匹配与校对
  components/FollowTradeImport.tsx # 跟单时间线截图识别、字段校对与当前用户写入
  components/LeadPortfolioMonitor.tsx # 公开带单主页绑定、手动同步、自动轮询频率与状态
  components/SmartMoneyImport.tsx # 聪明钱 URL 输入、自动建用户与完整同步入口
  components/PerformanceOverview.tsx # 交易表现指标、精确提示、累计/每日盈利图与盈利日历
  components/TrainingMode.tsx # BTC 15m 主图、4H/1D 小图、分仓训练与独立表现看板
  components/BinanceApiConnect.tsx # Binance / OKX 只读 API 连接、日期选择、交易对自动发现与同步界面
  components/ReplayVideoExport.tsx # 单笔交易 1080P 视频配置、录制、进度与取消界面
  lib/replay-video-renderer.ts # 固定 1920×1080 的复盘视频 Canvas 帧渲染器
  lib/basic-order-ocr.ts     # 本地基础单 OCR 运行器与低对比度列补识别
  lib/condition-order-ocr.ts # 本地条件单 OCR 运行器
  lib/follow-trade-ocr.ts    # 本地跟单时间线 OCR 运行器
  page.tsx                    # 单页入口
  layout.tsx                  # 全局元数据
  globals.css                 # 全局视觉与响应式样式
desktop/
  main.mjs                    # Electron 生命周期、安全窗口、固定 IPC 与数据库启动
  local-server.mjs            # 仅监听 127.0.0.1 的 vinext 构建产物本地服务
  preload.cjs                 # 通过 contextBridge 暴露受限的桌面数据接口
  database.mjs                # 基于 Node.js 内置 SQLite 的订单、仓位快照、复盘与训练成绩仓库
  binance-usdm-client.mjs     # Binance USER_DATA 签名、订单/逐笔成交分窗读取与当前仓位标准化
  binance-credential-vault.mjs # safeStorage 凭证加解密与状态读取
  binance-api-service.mjs     # 凭证、同步客户端与 SQLite 持久化协调
  okx-client.mjs              # OKX 私有接口签名、订单/成交/仓位读取与 ctVal 张数换算
  okx-credential-vault.mjs    # OKX 三项密钥、UID、region 的 safeStorage 加解密
  okx-api-service.mjs         # OKX 凭证、同步客户端与 SQLite 持久化协调
  video-export-service.mjs    # 保存对话框、视频分块顺序写盘与半成品清理
  update-service.mjs          # GitHub Release 版本检查、Squirrel 下载状态与重启安装
  squirrel-startup.mjs        # Windows Squirrel 安装、升级、卸载快捷方式事件
lib/
  binance-orders.mjs          # Binance U 本位订单历史解析、稳定去重与复盘重建
  binance-orders.d.mts        # Binance 订单历史领域函数的 TypeScript 声明
  copy-trade-monitor.mjs      # 公开主页 ID 校验、成交/仓位标准化、稳定订单与快照差分
  copy-trade-monitor.d.mts    # 公开带单监控配置与快照类型声明
  smart-money-profile.mjs     # 聪明钱 URL 校验、公开资料标准化与稳定用户创建/更新
  smart-money-profile.d.mts   # 聪明钱主页资料与用户来源配置类型声明
  basic-orders.mjs            # 基础单 OCR 词元解析、稳定订单号与 CSV 去重匹配
  basic-orders.d.mts          # 基础单领域函数的 TypeScript 声明
  conditional-orders.mjs      # 条件单 OCR 解析与动态 TP/SL 挂接
  conditional-orders.d.mts    # 条件单领域函数的 TypeScript 声明
  follow-trade-records.mjs     # 跟单时间线文本解析与稳定订单转换
  follow-trade-records.d.mts   # 跟单时间线领域类型声明
  indicators.mjs              # EMA、RVOL/量能极值染色、成交量 Delta、CVD 与回放时刻指标截取
  indicators.d.mts            # 指标领域函数的 TypeScript 声明
  market.mjs                  # Binance K 线端点与响应转换
  performance.mjs             # 最终平仓日期归档、交易表现统计与盈利日历纯函数
  performance.d.mts           # 归档与统计领域函数的 TypeScript 声明
  training-market.mjs         # BTC 训练行情随机窗口、上下文截取与后续真实行情续接
  training-records.mjs        # 训练记录版本化 JSON 导入导出、校验与按 id 合并
  training-chart-update.mjs   # 训练图表整批初始化、追加、末柱更新与无变化判定
  training.mjs                # 训练仓位、TP/SL 自动触发、账户快照与表现统计
  trade-profiles.mjs          # 复盘用户默认值、新建、迁移与记录隔离
  trade-profiles.d.mts        # 复盘用户领域类型声明
  records.mjs                 # 截图订单复盘记录
  replay.mjs                  # 单根 K 线演进、逐笔成交快照、动态成本盈亏、仓位比例与回放帧纯函数
  risk.mjs                    # 成本线与动态止盈止损纯函数
  replay.d.mts                # 回放纯函数的 TypeScript 声明
  video-export.mjs            # 已平仓校验、前后 K 线窗口与逐阶段视频帧计划
  video-market.mjs            # 视频所需 Binance K 线分页读取与边界去重
  video-open-interest.mjs     # 视频所需 Binance Futures OI 分页读取与边界去重
  video-timeframes.mjs        # 视频固定可视上下文与无未来数据的 1H/4H/1D 聚合
  simulation.mjs              # 由历史 K 线生成模拟交割与本地示例迁移
  simulation.d.mts            # 模拟交割函数的 TypeScript 声明
  trade.mjs                   # 导入解析与盈亏纯函数
  trade.d.mts                 # 领域函数的 TypeScript 声明
tests/
  binance-orders.test.mjs     # Binance 订单历史解析、重建与去重回归测试
  basic-orders.test.mjs       # 基础单 OCR、方向映射、去重与复盘重建测试
  conditional-orders.test.mjs # 条件单 OCR 与 TP/SL 挂接测试
  follow-trade-records.test.mjs # 跟单时间线解析、订单转换与复盘重建测试
  desktop-database.test.mjs   # SQLite 仓库与写入校验测试
  desktop-package.test.mjs    # Electron 配置和 preload 接口测试
  desktop-server.test.mjs     # 本地服务、安全窗口和 IPC 测试
  binance-api-orders.test.mjs # HMAC 签名、基础单/Algo 映射与分窗同步测试
  desktop-credentials.test.mjs # safeStorage 密文落库与无明文回归测试
  okx-api-orders.test.mjs     # OKX 签名、张数换算、订单/成交/仓位与历史同步测试
  okx-desktop-security.test.mjs # OKX safeStorage、provider 隔离与受限服务测试
  okx-reconstruction.test.mjs # OKX 来源隔离、复盘重建与重复同步测试
  performance.test.mjs        # 最终平仓日期去重与交易表现统计测试
  replay.test.mjs             # K 线演进、逐笔动态成本盈亏、无未来仓位比例、成交事件与操作节点测试
  training-market.test.mjs    # 训练行情随机窗口、800+160 截取、校验与续接测试
  training-records.test.mjs   # 训练记录 JSON 往返、旧数组兼容、版本拒绝与合并测试
  training-ui.test.mjs        # 训练多周期、成交量、记录管理、快捷键、续接与风险线交互测试
  training.test.mjs           # 训练交易状态、TP/SL 触发、结束约束及表现统计测试
  video-export.test.mjs       # 视频默认配置、交易窗口与逐阶段帧计划测试
  video-market.test.mjs       # 视频 K 线分页、去重、错误与取消测试
  video-open-interest.test.mjs # 视频 OI 分页、去重、错误与取消测试
  video-timeframes.test.mjs   # 固定槽位、5m/15m 多周期聚合、未来隔离与时间边界测试
  desktop-video-export.test.mjs # 桌面视频流式写盘、限制与半成品清理测试
  trade.test.mjs              # 领域规则回归测试
  trade-profiles.test.mjs     # 旧数据迁移、新建用户与记录隔离测试
  trade-profile-ui.test.mjs   # 用户切换、新建与跟单 OCR 界面测试
  smart-money-profile.test.mjs # 聪明钱 URL、关联档案、稳定用户与成交来源测试
  smart-money-profile-ui.test.mjs # 聪明钱本地代理与导入界面回归测试
```

## Windows / macOS 桌面端架构

1. `desktop/main.mjs` 等待 Electron 就绪，在 `app.getPath("userData")/data` 下创建数据库目录，然后启动 SQLite 仓库和仅监听回环地址的本地服务。
2. `desktop/local-server.mjs` 从随机本机端口提供 `dist/client` 静态资源，并把页面/API 请求交给 `dist/server/index.js` 中的 vinext Worker；应用窗口只加载这个本地来源。
3. Electron 窗口启用 `contextIsolation`、`sandbox`、`webSecurity`，关闭 `nodeIntegration`，禁止嵌入 `webview`，同时拦截非本地导航和新窗口；外部 HTTP(S) 链接交给系统浏览器。
4. `desktop/preload.cjs` 不暴露 Node.js 或通用 IPC，只开放存储接口、四个固定 Binance API 操作、四个固定 OKX API 操作，以及视频导出的开始、分块追加、完成、取消操作。敏感 IPC 还会校验调用页面必须来自本机应用地址。
5. `desktop/database.mjs` 使用 Electron 43 内置 Node.js 24 的 `node:sqlite`，分别保存原始订单、按交易所与账户隔离的当前仓位快照、完整复盘 JSON 和系统加密后的交易所凭证；Windows 默认位置为 `%APPDATA%/CryptoReview/data/cryptoreview.db`，macOS 通常位于 `~/Library/Application Support/CryptoReview/data/cryptoreview.db`，实际始终以 `app.getPath("userData")/data/cryptoreview.db` 为准。
6. 页面首次在桌面容器中运行时，会先读取已有浏览器 `localStorage`，再与 SQLite 内容稳定合并并保存到数据库，避免丢失此前网页版本的导入记录和笔记。若桌面数据库读取失败，则回退到浏览器本地存储并在界面提示。
7. `desktop/video-export-service.mjs` 通过系统保存对话框建立单个导出任务，接收渲染进程的 `MediaRecorder` 分块并按顺序直接写盘；完成前取消、写入失败或退出应用都会关闭句柄并删除半成品，避免长视频全部堆在渲染进程内存中。

## 数据流

1. 通用仓位 CSV/JSON 文件在浏览器内读取，由 `parseTrades` 转换为统一交易结构。
2. Binance U 本位订单历史 CSV 由专用解析器转换为标准订单；全部原始订单先与 `cryptoreview-binance-orders-v1` 中的记录稳定合并，再按成交方向和数量重建闭合交易。
3. 基础单截图由本地 Tesseract 中英文模型按表格列识别，校对确认后转换为标准订单。截图订单若与本机 CSV/API 官方订单唯一匹配，则保留官方订单号与更新时间，同时把 OCR 合成订单号保存为入场别名；重建合并时以该别名精确替换旧 OCR 复盘，避免委托时间与成交时间不同造成 HYPE、SNDK 等历史交易重复。其余订单使用稳定合成订单号保存。
4. 条件单截图走独立校对流程，按交易对、平仓方向和持仓时间匹配已有复盘，生成带 MARKET/LIMIT 标记的动态 TP/SL 风险线。
5. 跟单时间线截图先用本地中英文 OCR 提取日期时间、开多/平多/开空/平空、合约、成交均价、成交数量、总价值和截图已实现盈亏，再进入逐行校对。确认后的成交转换为带 `profileId` 和稳定事件 ID 的订单档案；多张截图重复导入会合并，同一用户补齐开平仓后自动生成复盘，不同用户即使成交内容相同也不会合并。
- 补充边界：无法在导入范围内形成完整开平仓的订单仍保存在原始订单库中。API 同步时，只有剩余数量和方向能与对应交易所当前仓位快照精确匹配的订单链才生成未平仓复盘；缺少开仓历史时只给出警告，不伪造入场时间。
6. 公开带单同步由 `/api/copy-trade/lead-portfolio` 固定代理 Binance 公开主页使用的详情、仓位和成交历史接口，客户端不能传任意上游 URL。首次手动同步以每页 200 条读取完整历史；页间节流并重试，后续页面仍不可用时保留已取得的前序页并明确标记截断，用户可稍后重试。公开成交转换为 `source=copy-trade-public` 的标准 U 本位订单，稳定 ID 同时包含 portfolioId、交易对、买卖方向、持仓方向、数量、均价和成交时间；每个用户的绑定、轮询频率、最后成功/尝试时间和精简非零仓位快照随 `user_profiles.payload` 保存。自动轮询只取最新 200 条并与本地完整档案合并，不会重复交易；公开接口不提供手续费，因此复盘标记手续费未知。
   - 聪明钱 URL 先由 `/api/smart-money/profile` 读取公开 `friendly/future/smart-money/profile` 资料并校验返回身份；仅采用其中的 `futuresCopyTradePortfolioId` 进入上述公开带单同步。对应订单使用 `source=smart-money-public` 和 `smart-money:{topTraderId}` 账户标识，复盘来源显示为“Binance 聪明钱”。预置聪明钱用户首次启动没有 `lastSyncedAt` 时自动执行一次完整历史同步，成功后按 1 分钟读取最近成交；新 URL 手动导入始终先完整同步。
7. 桌面版可选连接 Binance USER_DATA API。连接验证读取 `/fapi/v3/balance` 返回的唯一 `accountAlias`，经哈希后形成稳定本地账户标识，因此同一账户断开、换 Key 后重新同步也不会重复建档。签名和请求只在 Electron 主进程执行；先分页读取无需 `symbol` 的 `/fapi/v1/income`，并各调用一次全账户 `/fapi/v3/positionRisk`、`/fapi/v1/openOrders`、`/fapi/v1/openAlgoOrders`，与本机已有交易对取并集后，再自动逐交易对读取 `/fapi/v1/allOrders`、`/fapi/v1/allAlgoOrders` 和 `/fapi/v1/userTrades`，用户无需填写交易对。历史区间按不足 7 天分段；若某段达到接口 1000 条上限，会继续按时间二分，HTTP 429 则遵守 `Retry-After` 重试。逐笔成交按订单号挂接，计价资产手续费完整时写入入场与各次离场；每笔基础开仓和加仓的数量、价格、成交时间、手续费与来源订单号同时写入复盘 `entries`，供仓位条按时刻分段显示。标准化订单与当前仓位快照先按 `binance-usdm + accountId` 在同一 SQLite 事务中保存，再按 `positionSide` 分离 LONG/SHORT 重建并保存复盘；空仓快照只清空当前 Binance 账户，不影响 OKX 或其他账户。
8. 桌面版也可连接 OKX USDT 线性永续只读 API。连接验证使用账户 UID 建立 `okx-swap` 稳定本地账户标识；region 支持 `global`、`us`、`eea`，默认 `global`。API Key、Secret、Passphrase、UID 与 region 只在 Electron 主进程内使用并整体加密保存。同步请求按 `instType=SWAP` 查询账户订单、条件单、逐笔成交与当前仓位，可从响应自动发现全部相关交易对，无需手填 symbol；可用历史约为最近 3 个月。OKX 的 `sz` 是合约张数，标准化前必须读取合约规格，按 `ctVal` 与 `ctValCcy` 换算为标的币数量，不得直接把张数用于仓位和盈亏。标准化订单与当前仓位快照先按 `okx-swap + accountId` 在同一 SQLite 事务中保存，再重建并保存复盘；冷启动从快照恢复未平仓复盘，避免必须重新请求 API。
9. 页面根据交易对、市场类型、入场时间和时间框架请求 `/api/market/klines`。
10. 服务端代理校验参数后，现货请求 Binance Spot，永续请求 Binance USDⓈ-M Futures `/fapi/v1/klines`，并转换为统一 OHLCV 结构；U 本位合约另行请求 `/futures/data/openInterestHist`，OI 从图表入场前可见区间开始获取，失败不会影响 K 线和成交量。OKX 订单当前同样使用该 Binance 公共 U 本位行情，而不是把 Binance 行情冒充为 OKX 行情。
11. 行情额外读取入场前 280 根 K 线作为 EMA200 预热数据，图表仍只显示入场前约 80 根；EMA21/EMA200 使用完整历史收盘价与当前部分 K 线价格计算，不读取未来 K 线。
12. Binance K 线的总成交量与主动买入量用于计算 `Delta = 2 × takerBuyVolume - volume`，CVD 从图表可见起点累计 Delta。由于 K 线接口只提供整根最终主动买量，形成中的当前 K 线不会提前加入 Delta/CVD。
13. 图表初始只显示到入场 K 线；每根 K 线先按内部进度逐步形成，完成后才追加下一根。当前柱成交量按回放进度增长，量能染色也使用该部分成交量实时重新判定；RVOL 只取当前柱之前的完整 K 线作为均量基准，最高/最低量窗口只包含当前及此前 K 线，均不读取未来数据。OI 只显示回放时刻之前已经发布的数据。仓位条按同一回放时间合并已发生的 `entries` 与离场成交，以截至当前的持仓峰值为满格；旧记录没有逐笔 `entries` 时退化为一段初始仓，不反推不存在的加仓。
14. `buildReplayTradeSnapshot` 按成交时间顺序推进当前数量、加权成本、已实现/未实现盈亏及手续费，并输出已发生的逐笔 BUY/SELL 事件。部分平仓沿用当时成本，后续加仓只重新加权剩余持仓；旧记录没有 `entries` 时使用顶层入场数据兼容。
15. 黄色成本线使用成交快照中的当前加权成本，挂单线按 `[开始时间, 结束时间)` 动态出现或移除；每笔入场、加仓和离场标记只在回放时间到达后出现。最终统计仍由 `calculateTradePnl` 计算，实时回放则使用逐笔成交快照，避免未来数量与成本泄露。
16. 已闭合交易按最后一笔离场成交的 UTC+8 日期唯一归档；累计曲线、每日统计和手续费统计也以该最终平仓时刻排序和汇总，当前未平仓不计入表现指标。
17. 每笔复盘保存成交数据来源集合；条件单 OCR 作为补充来源单独标记。进度条操作节点由风险线起止时间与离场成交生成，五秒内同类“撤旧单 + 建新单”合并显示为一次改单，不额外创建时间线面板。
18. 训练模式生成随机历史结束时间，以最多 1,000 根为一页向更早时间分页，最终保留 3,040 根 BTCUSDT 15m 永续 K 线，其中前 2,880 根作为已揭示历史上下文，后 160 根作为待训练行情；主图可在 15m、1H、4H、1D 间切换显示，但“下一根”和成交触发仍统一推进一根 15m K 线。主图在每局或切换显示周期时设置最近约 80 根的默认范围，此后同周期的数据、成交标记和风险线更新不再重设时间轴；右侧 4H、1D 小图只从当前游标以前的 15m 切片按 UTC 自然周期聚合。下一根按钮和右方向键共用同一推进逻辑。买卖操作由独立训练领域层计算仓位、加权成本、已实现/未实现盈亏和可用资金；每条成交动作通过稳定 `actionId` 关联图表箭头，并把现实时间与模拟行情位置分开保存。行情位置包含周期、K 线开收盘时间、数组索引、相对训练起点位置和完整 OHLC；动作同时保存操作前后仓位与 TP/SL 快照。拖动或输入修改 TP/SL 会写入独立 `riskChanges` 历史。每次揭示新 K 线时用其高低价检查触发并按设定价自动全平，自动触发只记录到所在 K 线，不伪造柱内精确时间。走到已加载片段末尾仍有持仓时，从最后收盘时间之后续接 Binance 真实 K 线；只有空仓才能结束并把完整成绩与操作账本写入训练专用本地存储。
19. 视频导出先以 5 分钟 K 线定位入场与最终平仓窗口；当前回放行情不是 5 分钟或覆盖不足时，通过现有本地行情代理独立分页补齐约 31 天多周期上下文、EMA 预热、入场前和最终平仓后的真实 K 线，不扩大页面回放列表，也不生成演示价格。31 天历史只用于画面上下文，实际录制帧仍严格由用户设置的前后 K 线数量决定。主图使用固定 80 槽窗口，1H、4H、1D 只从当前游标以前已发生的 5 分钟行情聚合，形成中的高周期 K 线也随当前 5 分钟 K 线同步演进，不读取未来高低收。每根 5 分钟 K 线继续使用与页面相同的 12 个内部阶段和 `100ms / 倍速` 节奏。画面由 Canvas 固定渲染为 1920×1080，再由浏览器可用编码器优先输出 MP4、不可用时降级为 WebM；桌面 IPC 只接收二进制分块，不接收任意路径或通用文件操作。

## 运行与打包

```bash
npm run desktop:run
npm run desktop:package
npm run desktop:make:win
npm run desktop:make:mac:arm64
npm run desktop:make:mac:x64
npm run desktop:make:mac
```

`desktop:run` 会先构建网页资源再启动桌面应用。`desktop:package` 在 Windows x64 上生成可直接运行的目录，主程序位于 `out/CryptoReview-win32-x64/CryptoReview.exe`。`desktop:make:win` 生成支持自动更新的 Squirrel 安装包，产物位于 `out/make/squirrel.windows/x64/`。三个 `desktop:make:mac:*` 脚本分别生成 macOS arm64、x64 或两者的 ZIP，产物位于 `out/make/zip/darwin/` 的对应架构目录。

Windows 与 macOS 产物目前都未签名。macOS ZIP 尚未配置 Apple Developer ID 签名和公证；Windows 主机不能完成 Apple 公证，也不能代替真实 Mac 验证 Gatekeeper、Keychain、视频编码与应用权限。发布前必须在 Apple Silicon 和 Intel Mac 上分别实测。

## 关键边界

- 所有时间统一为 ISO 字符串或 Unix 毫秒输入，图表内部统一为 Unix 秒。
- 桌面版数据默认仅保存在当前系统用户的 `app.getPath("userData")` 目录；卸载、清理应用数据或手动删除数据库前应自行备份。网页模式与数据库不可用时的回退模式仍受浏览器存储容量限制。
- Binance CSV 不含 `positionSide`，因此 CSV 重建仍默认单向持仓并假设导入范围起点净仓位为 0；API 订单含 `LONG/SHORT` 时会按双向持仓分别重建。无论来源，若导入前已有仓位，仅靠范围内订单仍不能可靠补出缺失过程。
- Binance 订单历史不包含逐笔成交时间，系统使用订单“更新时间”近似表示成交时间。文件也不提供手续费、`positionSide` 和 `reduceOnly`，因此重建盈亏不含手续费，且不能据此确认双向仓位或平仓意图。
- 基础单截图只有委托时间，没有官方订单号和独立更新时间；若无法匹配本机 CSV，系统只能把委托时间同时作为近似成交时间，并在校对页与导入结果中明确提示。
- 重建出的 U 本位合约复盘统一读取 Binance USDⓈ-M Futures 行情；API 当前仓位只有在历史开仓证据完整匹配时才生成复盘，方向不明确或缺少入场历史的仓位只提示、不推测。
- Binance Smart Money 主页的公开资料可匿名读取，但网页展示的仓位、仓位历史和最新操作记录使用需要登录的私有接口。应用只在主页明确返回官方 `futuresCopyTradePortfolioId` 时读取该关联公开带单的真实成交；没有关联档案的主页无法仅凭 URL生成回放。
- 历史 OHLC 无法还原真实逐笔顺序；单根动画使用确定性的合成路径，并在界面中明确说明，不作为真实成交顺序依据。
- Binance U 本位合约是统一加权仓位，平仓成交无法可靠对应某个开仓批次。仓位条减仓时按所有存量色段同比例缩减，仅表达剩余仓位构成，不代表 FIFO/LIFO 会计归属；旧记录没有逐笔开仓证据时只显示单色基础仓。
- EMA 使用 K 线收盘价计算；当前未完成 K 线使用合成回放价格，因此回放中的末端 EMA 同样是确定性模拟值。
- Binance 单次最多返回 1000 根 K 线；跨度过长时，细周期可能暂时无法覆盖最终离场点。
- Binance Futures 历史 OI 单次最多 500 条且只提供最近一个月；超出范围或接口不可用时不补零、不模拟，只保留价格与成交量回放。
- 视频必须能取得用户指定播放范围内的真实 5 分钟 K 线；历史数据不足、交易尚未完全平仓或最终平仓时间无效时拒绝导出。新上线不足 31 天的合约会使用实际可取得的历史生成较短的 1D 上下文，不伪造更早行情。视频 OI 同样不补零，主图 80 槽上下文至结束范围无法完整覆盖时会在该次视频中关闭 OI，其余 K 线和指标仍可导出。MP4 是否可用取决于当前 Chromium/系统编码器，应用会在录制前实测并自动降级为 WebM。
- Delta/CVD 是按 K 线聚合主动买卖量计算的订单流指标，不是逐笔成交或价格档位 Footprint；演示行情和缺少主动买量的数据不会伪造这两项指标。
- Binance 个人订单接口要求 USER_DATA 权限和 HMAC-SHA256 签名。普通订单与 Algo 条件单历史单次区间必须小于 7 天，最多约 90 天；撤销/过期且零成交的订单超过 3 天后可能无法查询，所以同步结果必须保存在本机，不能把 Binance 当永久档案。
- Binance 公开带单主页使用的是网页公开数据接口，不是承诺长期兼容的正式开发者 API；无需也不会读取对方 API Key，但 Binance 改版、隐藏仓位、地区限制、接口繁忙或带单员关闭公开展示时可能中断。页间请求会节流并重试；仍失败时保留已取得页面并明确提示截断，不能把不完整快照当成完整交易过程。公开历史不含手续费，也不提供已取消条件单的完整生命周期，因此只重建实际公开成交，不推测 TP/SL 或手续费。
- API 复盘手续费使用 `/fapi/v1/userTrades` 返回的真实 `commission`，不套用固定 VIP 等级费率。若逐笔成交缺失或手续费资产不是该合约计价资产，原始资产金额仍保留，但该笔复盘会标记为手续费不完整，避免未经汇率换算就并入 USDT 盈亏。
- 普通历史单和 Algo 历史单接口仍强制要求 `symbol`，但应用会从收益流水、当前全账户挂单和本机档案自动发现交易对，不再要求手填。只有“从未成交、已经撤销、当前无挂单且本机从未保存”的币对无法通过同步接口自动发现；这类订单本身也不能形成交易复盘。当前版本不会调用任何 POST/DELETE 下单接口；建议使用关闭交易与提现权限、设置 IP 白名单的独立只读 Key。
- OKX 接入只读取 USDT 线性永续，不执行下单、改单或撤单。region 支持 `global`、`us`、`eea`，默认 `global`；API Key、Secret、Passphrase、账户 UID 和 region 全部位于同一系统密文中。OKX 与 Binance 凭据使用不同 provider 记录，可同时存在，删除其中一个不会影响另一个。
- OKX 同步无需手填交易对，会从账户订单、条件单、成交和仓位响应自动发现合约；私有历史通常只覆盖最近约 3 个月，因此交易所接口不能替代本地档案。应用会立即保存标准化结果，应定期同步并备份 SQLite。
- OKX 接口中的 `sz` 是合约张数。只有在合约规格的 `ctVal`、`ctValCcy` 能可靠换算为标的币数量时才可进入统一复盘计算；不得把张数直接当成 BTC、ETH 等币数量，也不得在规格缺失时猜测。
- OKX 订单、成交、手续费和仓位来自 OKX，但当前价格回放、EMA、成交量、OI、Delta、CVD 与视频上下文仍来自 Binance USDⓈ-M Futures 公共行情。界面必须分别显示订单来源和行情来源；两所价格可能有细微差异，OKX 独有且 Binance 没有对应 U 本位交易对的记录可能无法显示 K 线或导出视频。
- `safeStorage` 密文绑定当前操作系统及系统用户。Windows 和 macOS 之间迁移 SQLite 时，订单、复盘与训练记录可以迁移，但 API 密文不能跨系统解密，必须在新系统重新连接 Binance / OKX。
- Binance Futures 官方接口可能按网络位置返回地区限制；上游不可用时页面会明确切换为演示行情，不会冒充真实 Binance 数据。
- 训练模式不使用演示或伪造价格；Binance Futures 历史 K 线不可用或数据不足时会拒绝开始或续接。完整随机片段及续接数据虽已加载到本机内存，但主图和 4H/1D 聚合都只接收当前游标以前的 15m 数据；有持仓时不能结束，仅结束并保存的训练会进入训练表现统计。历史 OHLC 无法判断同一根 K 线内 TP 与 SL 的真实触发先后，二者同时被高低价覆盖时按保守规则优先执行 SL。
- `riskLevels` 存在时是权威挂单历史；不存在时才兼容旧记录的静态 `takeProfit` / `stopLoss`。截图没有给出止损触发价时不得从 K 线或盈亏反推。
- 跟单时间线截图只代表截图中实际可见的成交。若首尾被裁切、只有平仓没有对应开仓，或平仓数量超过当前截图可见开仓数量，事件只保存到当前复盘用户的订单档案并显示待补齐，不反推缺失仓位、不伪造入场；补充导入其它截图后再按完整数量链生成复盘。
- 本项目只用于交易复盘，不构成投资建议，也不执行任何下单操作。

## 修改约定

- 新功能应优先新增纯函数测试，避免回放与盈亏规则被界面改动破坏。
- 行情适配、领域计算和界面状态保持分层，接入其他交易所时不修改盈亏核心。
- 不在无关需求中重构或优化现有代码；任何额外优化先提出并获得确认。
