# Outcome

为已交付的「页面测试 agent」增加两项增量能力：
1. **多场景套件**：一个自然语言脚本可包含多个用 `## ` 分隔的独立测试场景，CLI 逐个运行、分别判定，并汇总整体结论与总退出码，使单次调用即可覆盖一组页面测试。
2. **CI 集成示例**：提供 GitHub Actions 工作流，演示如何将工具接入 CI（连接浏览器、构建、运行套件、上传报告、失败即非零退出）。

面向多页/多流程的回归测试场景，让非工程师用一份 Markdown 维护一组页面测试并直接接入流水线。

# Scope

- CLI 支持脚本内 `## 场景名` 分隔多场景；无 `##` 时退化为单场景（兼容现有行为）。
- 新增 `--suite` 选项强制套件模式。
- `runSuite` 逐个 `runAgent` 并汇总报告：整体 PASS 仅当所有场景 PASS；任一场景 FAIL 则整体 FAIL 且进程退出码非零。
- 场景拆分忽略一级标题（`#`）与开场说明文字，仅 `## ` 作为场景分隔。
- 提供 `.github/workflows/ci.yml` 作为接入样例（不实现 CI 平台深度集成，仅示例）。
- 报告渲染新增套件视图（场景列表 + 每场景断言 + 汇总）。

# Non-goals

- 场景间依赖/参数化/数据驱动（本期不做，后续可加）。
- 并发运行多场景（本期顺序执行）。
- CI 平台深度集成（仅提供 GitHub Actions 示例，不绑定特定平台逻辑）。
- 修改底层浏览器驱动（bsk）或 LLM 后端（CodeBuddy 反代）架构。

# Acceptance examples

- A1：脚本 `examples/smoke.md`（含 A1/A2/A3 三个 `## ` 场景）经 CLI 运行，输出「整体结论: FAIL」且进程退出码为 1（A3 为故意失败场景），并列出 3 个场景各自的 PASS/FAIL。
- A2：单个无 `## ` 的内联自然语言意图（如「打开 https://example.com 并断言标题包含 Example」）经 CLI 运行，行为等同单场景，退出码 0。
- A3：`--json` 套件输出结构稳定，包含 `status`/`assertions`/`summary`/`transcript`，可被 CI 解析。
- A4：原有端到端冒烟测试（`tests/smoke.test.mjs` 覆盖 A1-A4）仍全部通过，无回归。

# Constraints and invariants

- 多场景拆分仅以 `## ` 二级标题为界；`#` 一级标题与 `## ` 之前的开场说明不计入场景（避免被 LLM 误当作测试意图）。
- 任一场景失败必须使整体失败且退出码非零（与单场景不变量一致：失败必须可见、可接入 CI）。
- 兼容既有单场景调用与既有报告字段，不得破坏已交付 CLI 接口。
- 浏览器操作仍需 bsk 连接真实浏览器；LLM 仍需 CodeBuddy 反代可用。

# Decisions

- D1（Q1）：场景分隔符采用 Markdown 二级标题 `## `（用户已熟悉 Markdown，且与示例脚本风格一致），而非自定义分隔符。
- D2（Q2）：套件汇总策略为「全部通过才算整体 PASS」，任一失败即整体 FAIL（与 CI 预期一致）。
- D3（Q3）：CI 示例采用 GitHub Actions（最常用），以 Secrets 注入 CodeBuddy 反代凭据，不硬编码 Key。
- D4（Q4）：本次为增量增强，复用既有 `pi-agent-core` + `browserskill` + CodeBuddy 反代架构，不引入新依赖。

# Open questions

（无未决阻塞项。）

# Verification expectations

- 在 Windows 开发机通过 CLI 真实运行 `examples/smoke.md` 验证套件汇总与退出码（A1）。
- 单场景内联意图验证兼容（A2）。
- `--json` 套件输出结构校验（A3）。
- `npm test` 原有 A1-A4 冒烟测试全过，无回归（A4）。
- CI 工作流以示例形式提供，逻辑经审阅确认（不在此环境实跑 GitHub Actions）。
