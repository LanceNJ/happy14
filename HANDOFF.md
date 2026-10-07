# 欢乐十四分 · 交接说明（上下文续接用）

> 用途：上下文快满时，在新会话里粘下面这句即可无缝接续：
>
> **「继续做 happy14 项目（`happy14/`）。先读 `happy14/HANDOFF.md`，然后按交接文档的『待办』继续。」**

---

## 一、项目是什么

扑克凑 14 的双人（人类 vs NPC）单机游戏，卡通 UI，**三端同源**：

| 端 | 目录 | 说明 |
|---|---|---|
| 浏览器试玩 | `play.html` | **双击即玩，零安装**；加载 `electron/src/*` 的同一套 UI |
| Windows 安装版 | `electron/` | Electron + electron-builder（`npm run dist` 出 nsis exe） |
| 微信小程序 | `miniprogram/` | 微信开发者工具导入即编译 |

**游戏逻辑零网络/零模型依赖**（核心与三端界面全无 fetch/XHR/socket/API key；NPC 决策=难度档位，胜率=本地蒙特卡洛，台词=情境查表，断网可玩）。**唯一例外**是手机版页脚的访问计数（云服务 RPC，失败静默、不参与任何玩法）。

## 二、规则基线（已与用户逐条确认，勿擅改）

- 2 副标准牌含大小王 = **108 张**；A=1、2~10 面值、J=11、Q=12、K=13；**大王计 1 分、小王 0.75 分，但配 14 时王算 0（随便配）**
- 花色计分：黑桃 1 / 红桃 0.75 / 草花 0.5 / 方片 0.25
- 布局：桌面 6 张（上下两行）、双方各 4 张手牌、其余为补牌堆；**先手随机（双方各 50%，`createGame({firstRandom:true})`；不传则玩家先手，兼容老脚本/测试）**
- 一次匹配 = 手牌任意子集（1~4 张）+ 桌面**恰好 1 张** = 14 → 全进战利品
  → 玩家从手牌挑 1 张补到桌面 → 再从补牌堆把手牌**补满 4 张**
- 凑不出：挑 1 张手牌作罚牌（隐藏），**罚牌后同样补满 4 张**（补牌堆不足才不补）
- 残局：补牌堆抓完后手牌只减不增，直到双方都无法匹配且手牌耗尽
- 结算：得分 = 战利品合计 − 罚牌合计，高者胜

## 三、项目结构

```
happy14/
├── game-core.js        # 内核：牌堆/规则/匹配/补牌/罚牌/计分/贪心NPC/unknownPool
├── advisor.js          # 决策顾问：最优判断 / 胜率蒙特卡洛 / NPC 台词表 / 补牌风险模型
├── sfx.js              # 音效（振荡器实时合成，零素材）+ 静音开关持久化
├── style-check.js      # 共享样式检查（两版色板对齐），ui-test/mini-test 都调它
├── sync-core.js        # 三端内核副本同步 + MD5 校验（--write 同步，不加只校验）
├── play.html           # 浏览器试玩入口（双击即玩）
├── sim-test.js         # 引擎测试：2000 局，无异常 + 牌数守恒 + 均衡性
├── ui-test.js          # Web/Electron 界面冒烟测试（DOM 桩 + 浏览器模式 vm 双跑）
├── mini-test.js        # 小程序界面冒烟测试（Page/wx 桩）
├── mobile-test.js      # 【真实浏览器】手机版构建产物真跑（Playwright）：四档/学习系统/整局真打
├── difficulty-lab.js   # 【难度校准台】正确轮流的沙盒，配对发牌横向比对各档强度
├── tools-diag.js       # 【真实浏览器】布局诊断：逐块量高，抓"谁超出视口"
├── tools-shot.js       # 【真实浏览器】多尺寸截图（无头 Chrome）
├── site-mobile/                # 手机版在线链接部署目录（index.html=手机版构建 + share.png=转发分享卡）
├── tools-standalone.js # 打单文件分享版：内联 style.css+4 个共享 JS → 欢乐十四分-单机版.html / 欢乐十四分-手机版.html
├── 欢乐十四分.html              # 「手机版构建」的干净名字副本（发人用这个，不带"手机版/html"的文件感）
├── tools-assets.js             # 一次性生成：favicon(SVG)/主屏图标(PNG)/share.png 分享卡 → tools-assets.json
├── tools-head.js               # 把图标+theme-color+og 注入两个源 HTML 的 H14-BROWSER-IDENTITY 标记之间（可重跑）
├── tools-verify.js     # 【真实浏览器】遮牌/重叠验证（浮层 vs 桌面牌是否压住）
├── tools-verify-ui.js  # 【真实浏览器·观感改完必跑】无头加载构建出的单文件，走完 标题页→开始→选难度→玩法→对局，逐态截图 + 抓 pageerror
├── tools-bubble.js     # 【真实浏览器】气泡遮挡验证（大娃娃/小气泡 vs 玩家手牌，多分辨率）
├── README.md           # 玩法 + 运行 + 测试 + 设计说明（面向用户）
├── HANDOFF.md          # 本文件（面向 AI 续接）
├── electron/           # Windows 版（package.json / main.js / src/{index.html,style.css,app.js,共享模块副本}）
└── miniprogram/        # 小程序版（app.* / project.config.json / utils/{共享模块副本} / pages/game/*）
```

**⚠️ 三端副本纪律（最重要的坑）**：`game-core.js` / `advisor.js` / `sfx.js` 有 **3 份副本**（根目录、`electron/src/`、`miniprogram/utils/`）。**改根目录后必须同步**，否则测试跑的是旧副本：

```bash
N="node"
$N sync-core.js --write   # 同步三端 + 打印 MD5（必须三行一致）
$N sync-core.js           # 只校验，不一致时退出码 1
```

## 四、怎么跑 / 怎么测

```bash
N="node"   # 任意 Node 18+ 均可

$N sim-test.js    # 引擎：2000 局
$N ui-test.js     # Web 界面：273 项
$N mini-test.js   # 小程序界面：223 项
$N style-check.js # 两版色板对齐（ui/mini 各自也调）

# 手机版构建产物真跑（Playwright，需 NODE_PATH 指向已装 playwright 的隔离目录）
#   NODE_PATH=<本机已装 Playwright 的 node_modules> node mobile-test.js
$N mobile-test.js # 手机版：四档 / 学习系统 / 面板可开 / 整局真打 / 零报错

# 真实浏览器验证（改 CSS/布局必跑，桩测试测不出布局问题）
$N tools-diag.js      # 逐块量高，输出"谁超出视口"
$N tools-shot.js      # 多尺寸截图 → _shot-<W>x<H>.png
$N tools-verify.js    # 浮层是否遮住桌面牌
$N tools-bubble.js    # 气泡是否遮住玩家手牌（手牌盖住 0 张才算过）

# 难度强度校准（改了 game-core 的难度逻辑就重跑，看 gcEasy/gcMedium/gcHard/gcHell 四行）
$N difficulty-lab.js 200 gcEasy,gcMedium,gcHard,gcHell
```

**改界面后必跑对应测试**：Web 改 `electron/src/{app.js,style.css,index.html}`、`play.html` → `ui-test.js`；小程序改 `pages/game/*` → `mini-test.js`。
原因：Electron 在本机弹不出窗、小程序要开开发者工具，两边界面**过去都出现过"从没真正执行过"的致命 bug**。

## 补记（2026-09-19 晚）手机版 H5 在线链接：同源降一档
- 用户实测手机版界面不对头、很多叠在一起：复现后发现是竖屏适配只做了顶栏。已彻底重写 ≤560px 覆盖块。
  - 弹窗遮罩从 rgba(0,0,0,0.45) 加深到 0.96，解决半透明遮罩下牌桌/面板透出来叠的问题。
  - 难度按钮（询问层 + 侧栏）从一行 4 个改成 2×2 网格，地狱不再被切。
  - :root 变量手机下重置：--card-h 按 vmin、上限 46px，让手牌/桌面牌不再挤。
  - 桌面 6 张从 3 列改 2 列 3 行；侧栏隐藏 log/tips/odds-note/score-lead/罚牌等次要行；整体字号/内边距收紧。
  - 截图留档 ui-mobile-initial-20260919.png、ui-mobile-game-20260919.png（390×844 iframe 探针）。


- 用户问"朋友手机上玩"→ 选定 H5 在线链接路线；再确认"手机版减一档"= 强度整体降一档（地狱→难、难→中等、中等→容易、容易不降）。
- 实现：app.js 档位咽喉 effectiveDifficulty() 加守卫式 H14_SHIFT（window.H14_EASY_SHIFT=1 才生效，桌面/小程序零变化）；说明文案标注"实际按「X」打"（只有真降档才标，easy→easy 不标）。
- 打包：tools-standalone.js 重写为「每变体独立源 HTML + 各自内联文件清单」结构，一次生成两个单文件变体——桌面单机版（源 `play.html` + `electron/src/*`）和手机版（源 `mobile/index.html` + `mobile/*` + 内核 3 件套）。差异全部收敛到各自源文件，`--check` 校验无外部引用残留。`site-mobile/` 是手机版部署目录（最终只含 `index.html`）。
- 手机适配：实测（390×844 iframe 探针）唯一溢出者是顶栏（标题+副标题+3 按钮撑到 591px）；style.css 尾部加 ≤560px 块：隐藏副标题、收紧按钮。牌桌/弹窗实测本来就装得下。无头 Chrome 直接 --window-size=390 会给 512px 视口（伪影），必须 iframe 法。
- 线上（**重要·链接已变**）：旧 `https://h14-mobile.app.workbuddy.host/` 已取消发布失效；2026-09-19 晚因「彻底分两套界面」重做手机前端后重部署，新链接 **https://h14-mobile-98661.app.workbuddy.host/**（根路径直接服务 `site-mobile/index.html`，无跳转桩）。
  - **部署坑（必读）**：`workbuddy_sites_deploy` 的 `updateExistingApp` 复用旧沙箱、**无法原地替换内容**（连根路径跳转桩都不更新，旧文件仍在服务器）。要更新已发布内容必须 `unpublish` + `createNewApp`（子域会追加随机后缀如 `-98661`），或换文件名用 `index.html` 全新部署。
  - ⚠️ **上一条结论 2026-09-20 已推翻，以 §五·二 为准**：真正的原因是当时**没带 `appId`**；带上 appId + `updateExistingApp:true` 即可**原地覆盖、链接不变**。
  - 更新流程：改共享代码 → 三套测试 → `node tools-standalone.js` → 生成物拷入 `site-mobile/`（只留 `index.html`）→ `unpublish` 旧 app + `createNewApp` 全新部署（复用 `domainPrefix:h14-mobile`）。
- 测试：ui-test 新增 §13 手机变体 10 项（注意：桩环境询问层静态子按钮不存在，用 localStorage.h14_diff 预置档位驱动）；ui 294 / mini 228 / sim 2000 局全绿。

## 五、本轮（用户 3 条）状态

用户原话：「1、确定谁先手以后要显示一下，不然一下就开始太突兀了；2、还有罚牌的时候有时候应该尽量留小牌，比如方片4和红桃K，我有时候会选择罚红桃K…；3、点了再来一局以后进行不下去」

| # | 需求 | 状态 |
|---|---|---|
| 1 | 开局宣告先手 | ✅ **已完成并截图验证**。`announceFirst()`：开局金色大字横幅「你先手 / NPC 先手」居中弹出 1.6 秒自动淡出（`#firstBanner`，CSS `firstPop` 动画，绑局次中途重开自动作废）；小程序端 `firstBanner` data + `announceFirst()` 同款。ui-test/mini-test 各 3 项断言（弹出/文字与实际先手一致/自动淡出），浏览器模式 2 项 |
| 2 | 罚牌留小牌 | ✅ **用户洞见经校准台实测成立**。NPC 罚牌从"罚最便宜"改为**总代价 = 价格 − 0.06×点数**（`game-core.js: PENALTY_RANK_W`，王百搭永不罚）：大点数凑14伙伴少（K 只能配 3），留着不如小牌值钱。实测：medium 基座 N=1000 **51.7% → 56.4%（k=0.06 峰值）**；hard 基座 N=1500 持平略升（76.8%→77.1%）；k=0.30 过头反而 48.5%（只罚大牌变菜）。k=0.06 起正好复现用户例子：方片4(0.25) vs 红桃K(0.75) 二选一 → 罚 K 留 4。**只改 NPC 分支，玩家基线不动**（校准基线一致性）。回归锁：ui-test §11⑨ 两项（含"王不拿去罚"） |
| 3 | 再来一局卡死 | ✅ **真凶已定位并修复**。结算层与难度询问层同为 `.modal`（z-index 99），而 `diffModal` 在 DOM 里排在 `overModal` **前面** → 同层级后者画在上者之上：点「再来一局」其实弹了询问层，但被结算层整个盖住，看起来"没反应"。修法：① 两版 `openDiffAsk` 先关掉结算/帮助层（web `classList.add('hidden')`、mini `showOver:false`）；② `#diffModal { z-index: 120 }` 兜底。回归锁：ui-test §11⑦、mini-test §5c②b |

**顺带记录**：改完后出厂四档重校准（N=400）：**容易 39.5% / 中等 52.0% / 难 80.3% / 地狱 92.3%**，单调性与间距保持。三端内核 `99b4cb5c` 一致。

**上一轮（3 条）已完成**：开局询问难度、补牌"给自己留机会"（净威胁 w=2）、五档+自适应。

**难度实现要点（改之前先读 `game-core.js` 里那段注释）**：
- 真正的杠杆有两个：**补到桌面那一张**（防守 53%→70%，加"给自己留机会" w=2 →76%）和**罚哪一张**（罚牌点数倾斜 51.7%→56.4%）。"出哪一手"的 λ 偏好实测毫无提升。
- **绝对不许读玩家真实手牌来决定补哪张**（那是上帝视角 AI，表现为"永远不喂你好牌"，玩家能察觉被针对）。只用未见池（玩家手牌∪玩家罚牌∪补牌堆，三者对 NPC 不可区分）抽样估计。
- 地狱级 = 前 4 高分手牌候选各 rollout（双方贪心走到底）取终局净分差最大者，全程不偷看。
- 每步决策约 0.2ms，胜率分片模拟按 hell 打 300 局也不卡（分片 16ms 间隔）。

**残留小事（可做可不做）**：
- `tools-verify.js` 的探测输出偶尔取不到（`--dump-dom` 时机），结论已用 `tools-diag.js` / `tools-bubble.js` 交叉确认
- root 下的 `ui-firstbanner-20260919.png` 是本轮宣告横幅截图留档

## 五·二、2026-09-20 手机端观感 3 条（已改已部署）

用户原话：「1、查一查随机NPC开始是不是很突兀就开始了；2、NPC走牌时显示的背景是全黑的；3、照顾老年人字略大一些、形象更卡哇伊」

| # | 问题 | 根因 | 修法 | 状态 |
|---|---|---|---|---|
| 1 | NPC 随机先手太突兀 | `newGame()` 里 `announceFirst()`（先手横幅）与 `beginTurn()`→`npcTurn()` **同步触发**，横幅还挂着 NPC 已经出牌 | `newGame()` 中 NPC 先手时 `after(1300)` 再加 `beginTurn()`，先亮横幅 + 提示「🤖 NPC 先手，请观战…」再出牌；玩家先手不变 | ✅ 已部署 |
| 2 | NPC 走牌背景全黑 | `.npc-show`（亮牌浮层）背景 `rgba(0,0,0,0.96)` 近纯黑、盖屏约 2.8s | 改为游戏主题墨绿 `rgba(10,30,18,0.82)` + `backdrop-filter: blur(3px)`，棋盘仍隐约可见；难度/结算/帮助弹层（本就 `.modal`）保持近黑 | ✅ 已部署 |
| 3 | 字小、形象不萌 | 全局字号 11–15px、卡牌 `clamp(48,13vmin,76)`；NPC 是「歪帽小痞机器人」 | 全局字号放大（顶栏/按钮/弹层/说明 14–18px、卡牌 `clamp(52,14vmin,80)`、头像 40→48px）；NPC 重绘为圆滚滚大眼粉脸蛋爱心天线小可爱，6 表情全重画（`mobile.js` 的 `npcFaceSvg`/`NPC_FACES`），说明文案同步「圆滚滚小可爱」 | ✅ 已部署 |

- 验证：本地 `node tools-standalone.js --check` 通过；`node --check mobile/mobile.js` 通过；线上 fetch 确认新构建（含 `bdeacb` 光晕 / `rgba(10,30,18,0.82)` / `NPC 先手，请观战` / `clamp(52px,14vmin,80px)`）已生效、无外部引用、非跳转桩。
- 部署：带 `.genie` 的 `appId` + `updateExistingApp` 原地覆盖，链接 `https://h14-mobile-98661.app.workbuddy.host/` 不变（否定了 2026-09-19 晚"updateExistingApp 无法原地替换"的误判）。

## 五·三、2026-09-21 游戏化外壳（用户："转给朋友用浏览器打开，文件看上去不知道是什么东西，能更像个游戏、简单且上档次么"）

用户选定：**风格 A 经典牌桌**（墨绿绒布 + 香槟金 + 衬线品牌字）／朋友**主要在手机**打开／**链接与文件两条路都要**。

### 1. 加了"标题画面"（手机版）
- `mobile/index.html`：`#app` 内新增 `#startScreen`（**fixed 覆盖层，z-index 400**）——衬线品牌「欢乐十四分」+ 香槟金细线 + 「凑够十四，把牌收走」+ `9 + 5 = 14` 三张小牌（**顺手把规则画出来**）+ 金按钮「开始游戏」+「玩法说明」+ 访问计数 + 底行「一副牌 · 两个人 · 一局三分钟」。
- `mobile.js`：新增 `enterStartScreen()` / `beginFromStart()`；**DOMContentLoaded 末尾由 `requestNewGame()` 改为 `enterStartScreen()`**，点「开始游戏」才走 `requestNewGame()` → 难度询问/首次玩法说明**流程完全不变**。`hideHelp()` 追加 `firstRunPending = false`（从标题页主动看过玩法，开局不再自动弹第二次）。`firstRunPending` 原本是**隐式全局**，本次补上 `let` 声明。
- 计数改双写：`initVisitStat()` 同时写 `#visitStat`（对局页）与 `#visitStatStart`（标题页，充当"有人玩过"的招牌）。
- `mobile.css`：body 改绒布径向渐变；新增 `.ss-*` 一组样式；`#helpModal { z-index: 500 }`（**必须**——否则 `.modal` 的 300 会被标题页 400 盖住）；顶栏品牌改衬线；`@media (min-width:700px)` 给 `#app`/`#startScreen` 收金边+投影，宽屏变成居中"机台"。

### 2. 补了"浏览器身份"（治"看上去不知道是什么东西"）
- 两个源 HTML 的 head 都有 `<!--H14-BROWSER-IDENTITY-START/END-->` 标记，由 `tools-head.js` 注入（**可重跑**）：
  - `favicon`（SVG data URI，510B）+ `apple-touch-icon`（180×180 PNG data URI，5.3KB）→ 标签页/收藏/加桌面都有牌面图标
  - `theme-color #16361f` → 手机地址栏染成牌桌绿
  - `apple-mobile-web-app-capable/status-bar-style/title` → 加主屏后全屏像 App
  - **仅手机版**带 og：`og:title/description/url/image` + `twitter:card`，`og:image` 指向 `https://h14-mobile-98661.app.workbuddy.host/share.png`
- 两版 `<title>` 都改成**光秃秃的「欢乐十四分」**（原来桌面版叫"浏览器试玩版"，转发出去像半成品）。
- 资源生成：`tools-assets.js`（Playwright）→ `tools-assets.json`（图标 base64）+ `site-mobile/share.png`（1200×630，239KB）。
  - ⚠️ **踩坑**：模板里把字体栈 `"Songti SC",...` 插进了**双引号包的 style 属性**，属性被第一个 `"` 截断 → `font-size:74px` 整段失效（标题缩成小字）。**style 属性内的字体名一律用单引号**。

### 3. 分享两条路
- **发链接**（首选）：转发即带标题/描述/图的正经卡片，点开就玩、不下载。链接不变。
- **发文件**：产出干净名字的 `欢乐十四分.html`；另存一份到桌面文件夹（内含 `欢乐十四分.html` 手机版式 + `欢乐十四分-电脑版（大屏）.html` + `说明-怎么发给朋友.txt`）。

### 4. 验证（本轮全套跑过）
`node --check mobile/mobile.js` ✓；`tools-standalone.js --check` ✓（手机版 110.9KB / 单机版 158.9KB，除云服务 CDN 外零外链）；**无头真跑**（Playwright，file://）走完 标题页→开始→选难度→玩法→对局，六张截图逐张肉眼验收；**线上无头真跑**确认标题页渲染、计数自增（累计 27 · 今日 13）、对局正常。线上 fetch 14 项字符串校验全 ✓，`GET /share.png` = 200 image/png 239KB。

## 六、历史需求（都已完成，供参考别重做）

1. 双版本（Electron + 小程序），卡通 UI ✅
2. 罚牌后补满 4 张（规则修正）✅
3. 零安装浏览器试玩版 `play.html` ✅
4. 修「手牌区完全不渲染」致命 bug（`cardEl(null,true)` 先读 `card.red`）✅
5. 补牌动作可见（滑入动画 / 补牌堆跳数 / 浮动提示）✅
6. NPC 每轮出牌可见 → 逐步升级为**五拍演出**（指牌+箭头 → 抬起 → 逐张翻牌 → 读等式 → 合牌）✅
7. 匹配动作线性化（圈选 → 飞合 → 收牌）✅
8. 罚牌交互简化：**选牌阶段永远两个按钮**，选中恰好 1 张才能罚，无"罚牌模式"无返回 ✅
9. 结算摊开算分过程（按花色/王列 张数×单价=得分）✅
10. 音效（振荡器合成 + 静音开关）✅
11. 胜率估计（蒙特卡洛）+ 每步最优判断 + 决策正确率 ✅
12. NPC 卡通形象（歪戴棒球帽的小痞机器人，6 种表情）+ 关键情境"大娃娃"说话 ✅
13. **语音 TTS 已按用户要求彻底砍掉**（机械音不如没有）——勿重新引入 ✅
14. 布局自适应（矮窗下手牌不再被挤到屏幕外：`#app` 锁视口高 + 侧栏内部滚动）✅
15. 整体色板（深木外框 / 绿呢桌面 / 奶油面板）两版对齐 ✅
16. NPC 亮牌浮层遮住桌面牌 → `.npc-show` 改底部停靠 + `.masked` 压暗降到 `.2` ✅
17. 补牌要考虑"给自己留后路" → `advisor.js` 的 `replaceCandidates/judgeReplace` 升级为 **净成本 = 期望送分 − 留后路收益**（新增 `path`/`net` 字段，两版文案同步）✅
18. 开局 + 结束音效（`deal()`/`start()`，`win()` 上行庆祝 / `lose()` 下行沮丧 / `drawEnd()`）✅

## 七、踩过的坑（复用，别再犯）

**测试/工具层**
- **⚠️ 校准沙盒必须先验证"它真的在轮流出牌"**：写过的 `_diffcheck.js` 主循环**从不翻转 `state.turn`**，而 `capture`/`penalty`/`replaceAndRefill` 都不改 turn、`createGame` 默认 `turn='player'` → **永远只走玩家分支，NPC 分支一次都没执行**。四个难度跑出的胜率差（12/22/15/13%）全是发牌噪声，据此得出的"hard 比 medium 弱"是假结论，还白改了一轮代码。**正确做法**见 `difficulty-lab.js`：① 每步动作后显式 `s.turn = who==='player'?'npc':'player'`；② 玩家侧调 `chooseAction(state,'player')` 而不是拿 NPC 的动作去操作玩家状态；③ 加 `guard` 上限。**并且**：任何"策略 A 比 B 强"的结论，先看两策略是否真的走到了不同代码路径。
- **横向比对要配对发牌，否则噪声吞掉信号**：`difficulty-lab.js` 用 `mulberry32` 接管 `Math.random`，同一局号 = 同一副牌，所有策略跑同一批牌 + 先后手奇偶交替，噪声≈0（这也是它只需 N=200 就能稳定区分 53% / 69% / 94% 的原因）。
- **桩不忠实造成假阴性**：测试桩 `className` 读不到 `classList.add()` 加的类 → `outerHTML` 里看不到动画类，断言永远 false，差点去改本来正确的代码。
- **逐张揭示必须分拍重建**，不能靠 CSS `animation-delay`（桩没有 `querySelector`，时序测不了）。
- **别让测试靠概率过关**：① "领先时胜率高"要造**结果已锁定**的局面（胜率必须正好 100%），不要用 60 局蒙特卡洛 + 80% 阈值；② 不要对**单次随机发牌**断言窄区间（实测 25 副牌跨度就是 30.5%~59.8%），改成"固定同一副牌重复估计要收敛"。③ 随机先手这类**随机性本身**要用独立循环断言（两种结果都出现 + 比例约 50%），别塞进主流程当硬断言。
- **改断言时两个测试里的重复条目要一起改**（Web 改完漏了小程序那条一模一样的，白跑一轮）。
- **别凭记忆猜标识符名做核对**（搜 `T_NPC_FLIP_GAP`/`card-lift` 报一堆 MISS，真实名是 `T_NPC_FLIP`/`lifted`，全是假阴性）。
- **真实浏览器探针要"先出快照再轮询覆盖"**：只挂 `load` 事件 + `setTimeout` 的探针在这个无头环境里可能完全不执行（`tools-bubble.js` 首版四次全"探测输出未找到"）。改成：注入时**先同步落一份 t0 快照**写进 `<pre id="probe-out">`，再轮询到手牌渲染出 4 张后覆盖它；取不到时打印 `domLength/hasProbeOut` 等诊断。`tools-verify.js` 是靠"注入时同步调一次 `__probe()`"才拿到输出的，同一道理。
- **连跑 20 次**才算稳（牌局随机，3 次全绿仍可能偶发）。
- **统计类断言先采分布再定阈值**。

**操作层**
- **同一文件不要并行发多个 Edit** —— 只生效一处、另一处静默丢失且工具还报"成功"（累计踩 5+ 次：`play.html`、`style.css`、`mini-test.js` 各一次；2026-09-19 晚间又在 `difficulty-lab.js`、`electron/src/app.js` 各踩一次，其中 app.js 那次直接 `announceFirst is not defined` 崩掉整个 ui-test 才暴露）。**铁律：对同一个文件的多次编辑，一条一条串行发。**
- **凡"恢复持久化状态"必须赶在任何渲染之前**：electron 版曾在 `newGame` 里才读 `h14_diff`，而 `renderDiff()` 在 `DOMContentLoaded` 先跑过 → 日志说"地狱"、侧栏高亮停在"中等"。测试桩测不出（桩对任意 id 返回对象、没有真实高亮概念），**是无头 Chrome 截图肉眼对比抓出来的**——UI 改动除了跑桩测试，必须再截一张真图。
- **同 z-index 弹层互相遮挡由 DOM 顺序决定**：`.modal` 全是 z-index 99，`diffModal` 排在 `overModal` 前面 → 询问层被结算层整个盖住（用户看到"点再来一局没反应"）。修法双保险：开新弹层前先关旧弹层（逻辑层，桩测试可锁）+ 关键弹层独立 z-index（视觉层，桩测不了只能靠纪律）。新增弹层时两件都做。
- **Edit 的 old_string 必须现读现取**：凭 summary/记忆写的 old_string 会因为注释措辞不同而匹配失败（本轮 `chooseAction` 就撞了一次），报错后先 Read 再改。
- **批量替换 `setTimeout` 要保参数顺序**（我写成 `(ms, fn)` 但调用点是 `(fn, ms)`，直接 `fn is not a function`）。
- **`<script>` 共享全局词法环境**：`advisor.js` 和 `app.js` 都写顶层 `const G` → 浏览器 `Identifier 'G' has already been declared` → `play.html` 白屏（Node 里每个文件独立作用域，测试全绿测不出）。所有被 `<script>` 引入的共享模块必须包 IIFE。
- **收工前清临时文件**：`_*.log` / 被取代的诊断脚本一律删（尤其**坏的沙盒**，留着下次会被误用）。本轮新增的 `difficulty-lab.js`、`sync-core.js`、`tools-bubble.js` 是长期工具，别删。

**AI 行为层（本轮真踩）**
- **改布局前先量，别猜**。用户两次说"还是挡"，第一次按"浮层贴底"改了 `.npc-show`，但真凶其实是大娃娃 `.npc-speak`（同样是贴底居中）。写个探针量出 `top/bottom` 与手牌矩形重叠张数，一次定位，比读 CSS 猜三轮快。
- **UI 文案要与实现同步改**。难度语义从"预判反手/蒙特卡洛"换成"防守补牌/rollout"后，`DIFF_DESC`（两版）+ 帮助文案（`index.html`/`play.html`/`game.wxml`）五处都得改，否则用户看到的是假的说明。

**环境层（本机特有）**
- **bash 工具链是坏的**：`ls`/`head`/`tail`/`grep`/`dirname` 全部 command not found，管道会断。**一律用 Node 脚本代替**（`fs`/`child_process`），别用 `|`。
- **Chrome 无头截图**要用 `child_process.execFileSync` 直接调（`/c/Program Files/Google/Chrome/Application/chrome.exe`），PowerShell 的 `Start-Process` 拿不到退出码（疑被沙箱拦）。用 `--dump-dom` + 页面里塞 `<pre id="...">` 把探测结果带出来。

## 八、可选的下一步

- 联机对战（当前单机）
- ~~自适应难度~~ ❌ **已于 2026-09-23 整体退役**（第五档拆掉，内核回到四档；位置让给 🧠 学习系统，见 §九）
- 战绩统计 / 自定义副数
- 若继续调难度：`difficulty-lab.js` 里还留着若干候选策略（`defHonHard`/`defRoll`/`many30def`/`net*` 系列等）可直接跑比对
- 把 `tools-verify.js` 的取数逻辑按 `tools-bubble.js` 的写法修稳

## 九、NPC 学习系统 + 四档（2026-09-23 上线，替换"自适应"）

**一句话**：NPC 不再靠"升降档"把你卡在五五开，改成**只学你赢的局**、用**引擎自己的推演当裁判**，把每次你打得比引擎好的地方记下来，微调两个权重。

### 规则（全部在手机版 `mobile/mobile.js`）
- **只学你赢的局**：输局只记战绩、不动权重。
- **引擎当裁判**：拿你实际出的那一手 vs `rankMoves` 首选，在同一起点上比 `evalMoveRollout`（配对补牌，两臂都传 `null` 交给自动补牌）。
- **按轴投票**：出牌轴 `holes.play` **只记录不调参**；补牌轴 `holes.rep` 动 `keepW`；罚牌轴 `holes.pen` 动 `playW`。每局最多调一步。
- **常量**：`LEARN_STEP{hard:0.03,hell:0.06}`、`LEARN_CLAMP{keepW:[0,3],playW:[0.2,1.6]}`、`LEARN_MARGIN 0.5`、`LEARN_MAX_DEC 120`。
- **强度**：容易/中等 = 0（**永不学**，保持出厂手感）；难 = 0.5（吃出厂与学习值的中点）；地狱 = 1（全量）。`applyLearnWeights` 按 `d+(v-d)*t` 插值后 `G.setNpcWeights`。
- **存储**：`localStorage.h14_learn_v1`；头部 🧠 面板可看/导出/重置。**不联网、不上报**。
- **回流（人工单源蒸馏）**：打赢难/地狱 → 🧠 面板点「导出权重」→ JSON 发给 AI → AI 写进 `game-core.js` 的 `DEFAULT_WEIGHTS` → 重新构建部署（链接不变）。

### 四条"改前必读"的坑
1. **`page.click` 不能用来驱动游戏**（`mobile-test.js` 首版踩）：碰到 `disabled` 按钮会**静默等 30s**，90 拍循环一局拖 12 分钟。改成在 `page.evaluate` 里直调控制器自己的 `confirmMatch/doPenalty/onHandClick`，配 `page.setDefaultTimeout(20000)` + stall 检测。
2. **`after()` 是顶层函数声明 ⇒ 就是 `window.after`，可覆写**：`window.after=(ms,fn)=>setTimeout(fn,Math.min(ms,8))` 把 NPC 五拍演出（4.2s/回合）压到近 0；`T_*` 是 `const` 覆盖不了（玩家合牌那 1.1s 仍真等）。
3. **删 CSS 也要重建**：本轮残留过 `.diff-seg .diff-btn[data-diff="adaptive"]` 一条死规则（扫 HTML 查不出来，得搜 CSS）。
4. **`navigator.clipboard.writeText` 会返回 Promise**，未接 `.catch` 会变成未捕获异常（file:// / http 下必现）→ 导出按钮已加 `.catch(()=>{})`。

### 构建产物与分发（改完必须一起刷）
构建只产出 `欢乐十四分-单机版.html`（源 `play.html`）和 `欢乐十四分-手机版.html`（源 `mobile/index.html`）；`欢乐十四分.html` 是**手机版构建的干净名字副本**（发人用）。共 5 处：
`happy14/site-mobile/index.html`｜`happy14/欢乐十四分.html`｜桌面 `欢乐十四分-单机版.html`｜桌面 `欢乐十四分-小游戏-2026-09-21/{欢乐十四分.html, 欢乐十四分-电脑版（大屏）.html}`。

### 验证结论（2026-09-23）
`sync-core` 三端一致 ✓｜`tools-standalone` 单机 164.1KB / 手机 142.9KB ✓｜`sim-test` ✓｜`style-check` ✓｜`ui-test` 全绿（9 项红已收口）｜`mini-test` 全绿（7 项红已收口）｜`mobile-test` A 3/3 · B 11/11 · C 6/6 ✓（整局真打：合牌 13 手 / 罚牌 16 手 / 结算层出来 / 落盘 / 零报错）｜线上 `https://h14-mobile-98661.app.workbuddy.host/` 逐字节等于本地 `site-mobile/index.html`（127828 字符），`data-diff` 恰 4 值、无 `adaptive`。
