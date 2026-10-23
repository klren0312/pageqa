# ADR-0020：接入真正的微信小程序测试——新增 `miniprogram` 驱动后端

- 状态：采纳（2026-10）
- 背景：`pageqa` 当前是**纯 Web（桌面浏览器）测试 Agent**，执行链硬绑定到 `bsk`（BrowserSkill）驱动的桌面浏览器：全部动作走 bsk 的 daemon RPC，底层是 CDP（Chrome DevTools Protocol）；核心的 `snapshot()` 读 DOM/aria 树，`locator.ts` / `snapshot.ts` 与这套 `role "name"` + `@eN` 文本格式**逐字节强耦合**（见 `docs/bsk-capability-review.md` 第六节）。真正的微信小程序**不跑在标准浏览器里**——它在微信客户端的私有运行时，没有标准 DOM/aria 树，也不暴露 CDP，因此开箱即用无法测试。本 ADR 给出"在保持现有 agent / replay / locator 层不动的前提下，接入小程序"的设计。

## 决策

### 1. 新增 parallel 后端，复用 `BskOps` 形状，不重构接口

- 在 `src/miniprogram/` 新建后端，实现与 `BskOps`（`src/bsk/tools.ts`）**同形状的操作层**：`navigate` / `snapshot` / `click` / `fill` / `assertText` / `screenshot` / `getHtml` / `assertNoConsoleError` / `assertNetwork` 等方法签名与 bsk 一致。
- `agent.ts` / `replay.ts` **不按方法分支**，只新增一个顶层开关「按 `--driver` 选 bsk 还是 miniprogram 后端」：
  - `createBskTools(...)` 对应新增 `createMiniprogramTools(...)`，只暴露小程序里**有对应物**的那 7 个工具（见决策 5），暴露给模型的工具集本就由各自 `createXxxTools` 决定，agent 装配处自动纳入；
  - `replay.ts` 的 `executeReplaySteps` 接收的 `ops: BskOps` 改为「任一驱动后端实例」——因为 `ReplayStep` union 与 `runStep` 的 switch **完全不依赖具体后端**，同一条 `navigate` / `click` / `fill` 步骤由 miniprogram 后端执行即可。
- 小程序里**无对应物**的方法（`upload` / `download` / `wheel` / `hover` / `select_option` / `pick_date` / `press` / `focus` / `blur`）不在 `createMiniprogramTools` 里注册——模型根本看不到它们，也就不会去调，避免了「调了却不支持」的假失败。

> 为什么不复用 `BskOps` 这一个对象、而是 parallel：bsk 后端把 21 个工具全注册了；小程序若硬塞同一个接口，那 9 个无对应物的方法要么留空抛「不支持」、要么从工具集里拿掉——既然要拿掉，parallel 一个干净的 `createMiniprogramTools` 比在 bsk 里加 `if (driver==='mp')` 更清晰，且不污染现有 Web 路径。

### 2. 平台先行微信小程序，驱动用官方 `miniprogram-automator`

- 目标平台：**微信小程序先行**（生态最大、官方 Node SDK `miniprogram-automator` 最成熟）。支付宝 / 抖音等留作二期，不在本 ADR 范围。
- 驱动后端：微信官方 `miniprogram-automator`（`automator.launch` 拉起微信开发者工具并载入项目）。
- 不进**无显示环境 CI**（纯 headless Linux 容器跑开发者工具很勉强）。定位成**本地 / 带 GUI 的集成测试机**用途——这与 pageqa「零模型回放、每日回归」的核心卖点在小程序场景下的取舍是：**放弃无显示 CI 门禁，保留本地可回放**。

### 3. 快照契约保持不变——关键前提

`locator.ts` 的定位逻辑是**每次重新取快照、按 `role "name"` + 同名序号在最新快照里重解析**（`resolveLocator`），**不依赖 `@eN` 跨快照永久稳定**（bsk 的 `@eN` 也只在单次快照内有效）。因此：

- 小程序后端只要让 `snapshot()` 产出**同一种 `role "name"` + `@eN` 文本格式**，现有 `locator.ts` / `record.ts`（把 `@eN` 翻成语义定位符）/ `replay.ts`（`resolveLocator` 重解析）**原样复用，零漂移**。
- `@eN` 由小程序后端在**每次生成快照时**按遍历顺序自由编号，不要求跨快照一致。
- 这是整个方案风险最低的根基：**改动面被锁死在 `src/miniprogram/` 一个目录内**，agent / replay / locator / report 全部免改。

### 4. 快照枚举整页视图树，复用现有瘦身与复用窗口

- automator **没有「整棵视图树导出」API**，只能按选择器 `page.$` / `page.$$` 查询，且**不支持 `*` 通配**（见「实现期核实项」）。因此快照靠**递归遍历已知组件标签**（`view` / `text` / `button` / `input` / `image` / `navigator` / `scroll-view` …）合成类 aria 全量文本，每个节点给一个 `@eN`。
- 合成规则：`role` = 组件类型（小写标签名，自定义组件用其标签名）；`name` = 文本优先（`element.text()`），无文本时回退 `placeholder` 属性、`id`、`data-*`；自定义组件若无文本则只给 `role`。
- 产出后**直接复用现有 `slimSnapshot`（`src/shared/snapshot.ts`）** 做瘦身（长文本截断、非关键文本省略），与 bsk 快照同一套瘦身口径——这是决策 3 能成立的另一半：瘦身与定位格式耦合，复用它就保证格式一致。
- 性能：照搬 bsk 的 `SNAPSHOT_DEDUP_MS` 复用窗口（短时间内不重抓），递归枚举成本靠窗口摊薄。

> 为什么不是「只列可交互元素」的精简快照：`assert_text` 要搜全页可见文本、模型也要看全页才能决定步骤；精简列表会让「断言某段文案」「点一个没被列出来的元素」失能。整页树是正确性的前提，成本靠复用窗口与瘦身吸收。

### 5. 首期动作集（MVP）——保留 7，砍 9，2 个待核实

| 分类 | 工具 | 小程序后端映射 |
| --- | --- | --- |
| 保留 | `navigate` | 打开页面路由（`miniProgram.reLaunch` / `navigateTo`，参数形态见核实项） |
| 保留 | `snapshot` | 递归枚举视图树 → 合成类 aria 文本 → `slimSnapshot` |
| 保留 | `click` | `element.tap()` |
| 保留 | `fill` | `element.setValue(value)`（仅 `<input>` / `<textarea>`；方法名见核实项） |
| 保留 | `assert_text` | 在最新快照（或页面文本）里搜匹配，产出 `AssertOutcome`，不录结果只录条件 |
| 保留 | `screenshot` | `miniProgram.screenshot()` → 落盘路径（只读、不产断言，同 bsk） |
| 保留 | `get_html` | `element.wxml()`（只读、不录回放，同 bsk 的 get_html 处理） |
| 砍 | `upload` / `download` | 小程序文件交互走 `wx.chooseImage` / `wx.downloadFile` 等系统层，element API 无法驱动；MVP 不覆盖 |
| 砍 | `wheel` / `hover` | 连续手势 / 悬停揭示菜单在小程序里无稳定 API；MVP 不覆盖 |
| 砍 | `select_option` / `pick_date` | 小程序 picker 是原生组件，非 DOM 浮层；MVP 不覆盖（二期可借 `callWxMethod` 模拟） |
| 砍 | `press`(键盘) / `focus` / `blur` | 小程序无真实键盘事件 / 焦点模型；MVP 不覆盖 |
| **待核实** | `assert_no_console_error` | automator 能否捕获小程序 console / JS 异常**尚不确定**（见核实项）；可行就落地，不可行 MVP 暂不加 |
| **待核实** | `assert_network` | `wx.request` 是否可被 automator 监听**尚不确定**；可行就落地，不可行 MVP 暂不加 |

录制 / 回放对「保留」的 7 个工具**完全复用现有 `record.ts` / `replay.ts`**：它们本就不区分后端，只是把动作记成 `ReplayStep`、回放时调 `ops.xxx`。

### 6. 用例导航语义：`mp://` 伪协议 + `--driver` 开关 + lint 豁免

- 新增 CLI 开关 `--driver <bsk|miniprogram>`，**默认 `bsk`**（完全向后兼容）；`lint` / `agent` / `replay` 都按 driver 分支选后端与校验规则。环境变量 `PAGEQA_DRIVER` 同义。
- 小程序 case 的导航用 **`mp://页面路由` 伪协议**，例如 `mp://pages/index/index`、`mp://pages/detail/detail?id=1`。`navigate` 工具在小程序模式下接收 `mp://` 并剥掉前缀、把路由交给 `reLaunch` / `navigateTo`。
- `lint`（见 `src/agent/lint.ts`）的导航动词校验——当前要求「`打开`/`访问`/`前往` 等动词后必须是 http/https」——**在小程序模式下豁免**：允许 `mp://` 路由。回放时 `navigate` 的 `step.url` 同样是 `mp://...`，lint 与 replay 都不强制 http（replay 本就只透传 url，校验只在 lint 一处）。

### 7. 连接 / 启动模型：`automator.launch` 自动拉起 + `ensureMiniprogramReady`

- 配置新增 `miniprogram: { cliPath, projectPath, platform }`（`cliPath` 为微信开发者工具 CLI 路径，Windows 下如 `.../cli.bat`；`projectPath` 为小程序项目根；`platform` 为 `android` / `ios` 模拟器）。
- 类比 bsk 的 `ensureBskReady()`，新增 `ensureMiniprogramReady()`：调用 `automator.launch` 拉起开发者工具并载入项目；检测能否连上。**连不上时明确报错并提示「请先打开微信开发者工具、导入并编译项目」**，而不是卡死——与 bsk「你必须自己连浏览器」的体验一致。

### 8. 已知限制（MVP 不覆盖，记在此处避免被误当成 bug）

- **原生弹窗**：`wx.showModal` / `showToast` / `authorize` / `getUserProfile` 等是原生 UI，**不在 WXML 视图树内**，element API 读不到文本也点不了「确定」。二期方案：用 `miniProgram.callWxMethod` 覆写 `wx.showModal` 注入 mock，或主动 `callWxMethod('showModal', {...})` 拿 Promise 结果（但点击原生按钮本身无法用 element 操作）。MVP 用例需主动避开这类原生交互，或把它们标为「人工确认」。
- **无显示 CI**：开发者工具需要 GUI；纯 headless 容器跑不起来。若未来必须进 CI，单独评估 xvfb / 真机远程调试（`automator.connect`），不在本 ADR。

## 实现期核实项（事实待定，设计阶段不假装已定）

以下条目由子代理盘点时标注为「官方文档未明确 / 不确定」，需在实现期**装 SDK 读其 `.d.ts` 或官方文档逐条核实**，核实结果回写本文：

1. `setValue` 还是 `input` —— 输入框赋值的确切方法名；
2. `reLaunch` / `navigateTo` / `redirectTo` / `switchTab` 的参数形态（直接传路由字符串 `/pages/x` 还是对象 `{ url }`）；
3. automator 能否捕获小程序 **console / JS 异常**（`miniProgram.on(...)` 的事件名、`callWxMethod('console', ...)` 是否可行）——直接决定 `assert_no_console_error` 能否落地；
4. automator 能否监听 **`wx.request`**（决定 `assert_network` 能否落地）；
5. 整树递归枚举需要的**组件标签全集**，以及**自定义组件**如何处理（递归深度、性能、是否进入其 `data` 字段）；
6. `element.wxml()` 的返回形态（模板源码 vs 实时节点快照）；
7. 真机连接 `automator.connect({ wsEndpoint })` 的参数与可行性（本后端 MVP 只连开发者工具模拟器，真机留作二期）。

## 后果

- pageqa 从「纯 Web 测试 Agent」扩展为「多驱动测试 Agent」，但**核心层（agent / replay / locator / report）零改动**——代价被锁死在 `src/miniprogram/` 一个目录；
- 现有 Web 路径（`--driver bsk`，默认）行为完全不变；
- 小程序 MVP 能跑通「打开页面路由 → 看快照 → tap / 输入 → 断言文本 / 截图」这条最小链路，并能零模型回放（复用现有 replay 引擎）；
- `upload` / `download` / `wheel` / `hover` / `select_option` / `pick_date` / `press` / `focus` / `blur` 以及原生弹窗在 MVP 不可测；`assert_no_console_error` / `assert_network` 取决于核实项 3 / 4 的结果；
- 不进无显示 CI：小程序测试定位为本地 / 带 GUI 集成测试机的手动 + 回放用途。

## 实现备注（落地时订正）

实现 `src/miniprogram/` 时，对原设计做了三处务实订正，与决策不冲突：

1. **快照按扁平实现，非完整树**：`automator` 不支持通配选择器，只能逐已知标签 `page.$$(tag)` 取全页元素再按句柄去重，得到一份**扁平**清单（无层级缩进）。`locator.ts` 按 `role + name + 同名序号` 定位本就不依赖层级，扁平快照仍可用；代价是祖先路径消歧退化为序号（命中同名元素时靠序号区分）。如需层级，二期可改用 `element.$$` 递归 + 已知标签重建树。
2. **`assert_text` 仅做字面匹配**：小程序驱动暂未接 Jev 语义复核（避免引入额外依赖与误判），未命中即判不成立。这不影响回放（回放本就用固定期望值做字面比对）。
3. **`assert_network` 维持「不支持」**：`wx.request` 无法被 `automator` 稳定监听，落地时确认不可行，mp 工具集与 ops 均不提供，调用即抛 `UnsupportedInDriverError`。

## 落地踩坑与 SDK 补丁

真机联调（Node 24 + 微信开发者工具 + `miniprogram-automator@0.13.0`）暴露两个上游缺陷，已用 `patch-package` 固化为 `patches/miniprogram-automator+0.13.0.patch`，`postinstall` 自动应用：

1. **`spawn` `cli.bat` 缺 `shell:true`**：CVE-2024-27980 修复后，Windows 上 `spawn` 目标是 `.bat`/`.cmd` 且传了 `args`、未开 `shell` 时 Node 直接抛 `EINVAL`。该行为覆盖 18.20.2 / 20.12.2 / 22.x / 24.x **全部版本**——降级 Node 无法规避（已实测 20.20.2 同样 EINVAL）。补丁给 `Launcher.launch` 的 spawn 补上 `shell:true`。
2. **`checkVersion` 版本号解析不兼容**：新版开发者工具返回的版本号格式让 SDK 的 `cmpVersion` 崩在 `undefined.split`；此时连接与自动化通道其实已建立，补丁把该校验降级为「失败仅告警」。

另有三处属我们自己的实现细节（不改上游）：连接成功后**轮询预热** `currentPage()`（automator 首次取页面 meta 时才建立 `webviewId` 缓存，冷启动下会拿到 `null`）；`navigate` 补前导 `/` 的页面路由（微信路由 API 要求）；页面切换与取快照**重试到就绪**为止。

4. **自动化通道只有一条，父子进程必须共享**：微信开发者工具对同一项目只保留一条自动化通道，而 `automator.launch` 会自选一个*空闲*端口去 `cli auto --auto-port`——两者对不上时 IDE 不会在新端口开通道，表现为 launch 一直等到超时（且 `automator` 把 cli 输出吞了，现场看不到任何线索）。落地做法三条：
   - 父进程先建立连接，并把 ws 端点写进 `PAGEQA_MINIPROGRAM_WS_ENDPOINT`；场景子进程继承后用 `automator.connect` **复用同一条通道**，而不是各自 launch 去抢端口；
   - 只有「自己 launch 出来的」连接才在结束时关闭——复用来的通道是共享资源，子进程擅自关掉会把后续场景一起带死；
   - 小程序驱动固定**串行**（`effectiveConcurrency` 钳到 1，`/setting` 面板隐藏并发项）：多个开发者工具实例连同一项目会互相抢占。

> 补丁与 SDK 版本强绑定：升级 `miniprogram-automator` 需重新生成（`npx patch-package miniprogram-automator`）。本仓库把该依赖锁到精确版本 `0.13.0`。
