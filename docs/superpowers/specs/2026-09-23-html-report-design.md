# HTML 测试报告设计

日期：2026-09-23
状态：已批准（用户确认方案 A 与设计要点）

## 背景与目标

pageqa 运行结束后目前只有 stdout 纯文本报告与 `--json`/`--out` JSON 两种形态。目标：每次运行结束自动生成一份可直接用浏览器打开、便于分享归档的**自包含 HTML 报告**。

非目标：

- 不改 stdout 契约（ADR-0002：批处理 stdout 只放最终报告，日志走 stderr）
- 不做截图（项目尚无截图能力）
- 不做 HTML 专属语言切换逻辑（沿用进程现有 locale；共享标签复用 `report.*`，HTML 专属标签新增 `reportHtml.*`，zh/en 双份）
- 不做报告服务器/多报告索引页

## 需求（用户已确认）

1. **形态**：HTML 报告文件
2. **时机**：每次运行自动生成，无需额外参数
3. **位置**：`./pageqa-report/report-YYYYMMDD-HHmmss.html`，时间戳防覆盖；`pageqa-report/` 进 `.gitignore`
4. **内容**：汇总 + 逐场景明细 + 可折叠 trace（不附全量 transcript）

## 方案选择

- **A（采用）**：自研单文件渲染器 `src/report-html.ts`，从现有 `TestReport` 渲染自包含 HTML（内联 CSS/JS，零新依赖）。
- B：模板文件 + 占位符替换 — 多一层加载/转义，收益有限。
- C：第三方模板库 — 加依赖且需适配层，过重。

## 架构

### 新模块 `src/report-html.ts`

- `renderHtml(report: TestReport): string` — 纯函数，输入 `TestReport`（含套件 `scenarios[]`），输出完整 HTML 文档。
- `writeHtmlReport(report, baseDir?): { path: string }` — 生成时间戳文件名并写盘（复用 `writeReplayScript` 同款的建目录逻辑），失败时抛错由调用方决定降级策略。
- 所有动态文本经 HTML 转义（`& < > " '`）；trace/JSON 片段用 `textContent` 或转义后放入 `<pre>`。

### 数据变化：把耗时写进报告

- `TestReport` 增加可选字段 `durationMs?: number`（单场景：`finishedAt - startedAt`；套件汇总：整体跨度或各场景之和，取**整体墙钟跨度**与终态时间一致）。
- `ScenarioDetail` 增加 `durationMs?: number`、`startedAt?`/`finishedAt?` 不必外露，仅入 `durationMs`。
- 来源：TUI 已有 `QueuedScenario.startedAt/finishedAt`（`src/tui/queue.ts`）；批处理路径需在 `runAgent`/`runSuite` 执行处记录时间并传入 `buildReport`/`summarizeSuite`。
- JSON 报告（`--json`/`--out`）随之多出可选 `durationMs` — 属新增字段，向后兼容，README 字段说明补一行。

### 触发点（写盘位置）

| 路径 | 位置 |
|---|---|
| 批处理单场景 | `runAgent` 结果装配后（`src/index.ts` 打印 stdout 处附近） |
| 批处理套件 | `runSuite` 结果装配后 |
| 回放 | `replayMode()` 输出报告后 |
| 交互退出 | `interactiveMode()` 拿到 `combineBatches` 汇总报告、打印 stdout 之后 |

统一原则：**stdout 打印之后**再写 HTML；文件路径只经 `log.info`（stderr / TUI 日志）告知，绝不进 stdout。写盘失败不改变退出码，stderr 报 warning。

### 报告页面结构（单文件）

1. **头部汇总**：标题、生成时间、总场景数 / pass / fail / cancelled、整体耗时、token usage（有则显示）、整体结论徽章（PASS/FAIL/CANCELLED，沿用 `statusTag` 语义）。
2. **场景明细**（单场景则只有一节；套件逐场景）：
   - 场景名、状态徽章、耗时、origin（有则显示）
   - 用例步骤列表（`report.steps`）
   - 断言表：期望 / 结论 / 证据
   - `summary` 段
   - `skipped`（回放）与脚本路径（有则显示）
   - **折叠 trace**：`<details><summary>` 原生折叠，内为转义后的 trace 文本；无需 JS 也可工作（内联少量 JS 仅用于「全部展开/收起」可选增强）
3. **脚注**：mode（llm/replay）、生成路径说明。

样式：内联 `<style>`，浅色为主、状态色（绿/红/灰），等宽字体展示 trace；无外部字体/CDN。

### 样式与 i18n

- 共享标签（标题、断言、状态等）复用 `src/i18n.ts` 现有 `report.*`；HTML 专属标签（汇总列名、生成时间、折叠提示等）新增 `reportHtml.*`（zh/en 双份）。
- 渲染时用与当前进程一致的 locale。
- 徽章文案复用现有 `statusTag`（PASS/FAIL）与 cancelled 中文口径。

## 错误处理

- HTML 写盘失败：stderr warning + 路径信息，不影响退出码与 stdout 报告。
- 报告数据缺字段（无 durationMs 等）：渲染为空/不显示该行，不抛错。
- 场景名等含特殊字符：全部转义，防注入破版。

## 测试

- 新增 `tests/report-html.test.mjs`：
  - 单场景 pass/fail/cancelled 三种报告含状态徽章与标题
  - 套件多场景：汇总数字正确（cancelled 不计入 fail）
  - 断言证据、summary、trace 折叠片段存在
  - HTML 转义：场景名含 `<script>` 时不产生可执行标签
  - `durationMs` 在有值时出现在 HTML 与 JSON 序列化中
  - `writeHtmlReport` 生成文件路径匹配 `pageqa-report/report-*.html`，目录自动创建
- 既有 `tests/report.test.mjs` 补 durationMs 装配断言。
- 不破坏现有 stdout 契约测试（smoke）。

## 文档同步

- README / README.zh-CN：报告章节补 HTML 报告说明与示例路径。
- `CONTEXT.md` 批处理模式条目补一句：HTML 报告落盘不算 stdout 输出。
- ADR-0002 不改结论；如需可加一行交叉引用「HTML 报告为旁路落盘」。
- JSON 新增 `durationMs` 字段说明（README 字段表）。
