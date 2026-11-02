# ADR-0023：首帧预算——开屏只加载「画界面必需」的模块

- 状态：已采纳 · 日期：2026-11-02
- 相关：ADR-0002（交互模式与 stdout 契约）、ADR-0005（无源会话）、ADR-0013（场景进程隔离）

## 背景

「打开 TUI 要十几秒」被当成一个笼统的体感问题讨论过几轮，每次都靠猜：node 自身启动？模块图？模型目录？首帧渲染？网络请求？为此先加了启动打点（`PAGEQA_STARTUP_TRACE=1`，见 `src/shared/startup-trace.ts`），拿到的两条真实时间线说明了问题：

| 阶段 | 开发机（热缓存 SSD） | 一台反馈「十几秒」的机器 |
| --- | --- | --- |
| `index-module`（node + 入口模块图） | 163ms | 1749ms |
| `tui-module`（拉起 UI 模块图） | +372ms | **+7360ms** |
| `pi-tui`（UI 库本体） | +85ms | +604ms |
| `model-check`（内置 provider 目录 + 模型校正） | +83ms | +1230ms |
| 首帧（用户真正看到界面） | 917ms | **10955ms** |

两件事被这份数据钉死了：

1. **时间几乎全在模块加载上**，不在渲染、不在网络。两台机器的**模块数完全一样**，差别是「每个模块文件的加载成本」：开发机约 0.5ms/模块，那台机器约 6.4ms/模块（杀软实时扫描 / 慢盘），于是同一份 1153 个模块的图，一个 0.6s、一个 7.4s。
2. **首帧之前加载了 1153 个模块，其中 976 个与「画出界面」无关**：`typebox` 668（pi-ai 的 schema 依赖）、`openai` SDK 199、`undici` 109——全部来自 `config/models.js`（pi-ai）与 `agent/*`（pi-agent-core / pi-durable）。此外入口模块图里 149 个模块中有 109 个是 `undici`（`config/proxy.ts` 静态 import），连 `--version` 都要付。

## 决策

1. **首帧预算：`tui/app.ts` 的静态 import 只允许「画界面必需」**——pi-tui（`await import`）、本项目自己的 UI 模块、以及纯文本/格式化的轻模块。pi-ai / pi-agent-core / pi-durable **一律改成用到时 `await import()`**：模型目录（`getCatalog()`）、场景执行器（`loadAgentRuntime()`）、登录/登出/选择器、格式化与挑文件。
2. **模型目录按需构建**：`createModelCatalog()` 本身几毫秒，但加载 pi-ai 要 900+ 个模块，所以连「建目录」也推迟到首个使用者。启动时的 `currentChoice` 直接读 `config.json`（同步、不碰 pi-ai），首帧状态栏因此照样显示模型。
3. **模型校正移到首帧之后**：`resolveInitialChoice()` 会加载全部内置 provider（+ 免费网关可能一次网络刷新），原来是首帧前的 `await`。现在它是首帧之后的后台 Promise（`startupReady`），**跑场景前必须 `await` 它**——拿一个「已知不可用」的配置去跑，报出来的错与真相差很远。校正若真的换了模型，日志补一行（没换不重复打）。
4. **纯文本工具搬出重模块**：`splitScenarios` 从 `agent/agent.ts` 挪到 `shared/scenario-split.ts`（`agent.ts` 原样 re-export），`tui/writeback.ts` 因此不再为了切分场景拉起整棵 agent。
5. **`undici` 按需加载**（`config/proxy.ts`）：直连路径一个 undici API 都不用，而它值 109 个模块。只有真要走代理时才 `import("undici")`。
6. **打点保留**：`PAGEQA_STARTUP_TRACE` 默认关闭（空调用），但阶段划分与 `first-frame`（一次性包 `process.stdout.write`，命中「第一帧真的写到终端」）长期保留——这条预算线以后要被反复核对。

## 后果

- **好处**：同一台机器上首帧从 **10955ms → 约 1.5s**（开发机 917ms → 352ms）。首帧前模块数 1153 → 47，入口模块图 149 → 40。`--version` / `--help` / `lint` 这些不碰 TUI 的路径也一起变快（少 109 个 undici 模块）。
- **代价**：那 ~1000 个模块并没有消失，只是**推迟到第一次真的要用模型时**（`/model`、`/login`、提交场景、`/run`）。在慢盘机器上，那一次仍要等几秒——第一次提交时日志会显示「加载模型目录…」；界面此时已经可用，纯界面命令（`/help`、`/status`、`/setting`）不受影响。
- **代价**：`app.ts` 里出现了一批 `await loadModels()` / `await getCatalog()`。这是刻意的：把「这段代码要不要付加载开销」写成调用点上的显式选择，而不是模块头的隐式副作用。
- **不改的**：真要让这 1000 个模块也不再慢，只有两条路——打包成单文件（把「每文件成本 × 模块数」压成一次读盘），或者让机器不再对 `node_modules` 做逐文件扫描。前者是构建形态的改动，后者是环境问题；本 ADR 只负责把**首帧**从这条成本线上摘出来。
