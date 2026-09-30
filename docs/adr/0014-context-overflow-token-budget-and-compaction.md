# ADR-0014：上下文溢出按「精确 token 预算 + 分级规则裁剪 + 一次恢复」处理

- 状态：采纳（2026-09）——设计定稿，尚未实施
- 背景：执行长用例（尤其中文）时上下文会满。现有机制只有一层：`transformContext`（`src/agent.ts`）在每轮 LLM 请求前按**字符数**估算总量，超过 `CONTEXT_CHAR_LIMIT = 40_000` 才裁剪，把最近 `KEEP_RECENT_MESSAGES = 12` 条之外的旧 toolResult 截断到 1500 字符并打标。没有摘要、没有记忆、没有 token 预算。实践中两种失败都会发生：中文用例直接撞模型硬上限（请求被拒），英文长用例表现为模型中途失忆（忘记步骤进度、重复执行、断言数对不上而误判 fail）。
- 事实：
  1. **字符估算对中文系统性失准**：`estimateChars` 按字符数比较 40k 上限，而该上限的注释假定「默认模型窗口 32k token」。对英文 40k 字符 ≈ 10k token，绰绰有余；对中文 40k 字符 ≈ 40k+ token，**早已超出窗口**——裁剪阈值要么不触发、要么触发太晚，先撞上 provider 的 `context_length_exceeded`。
  2. **溢出错误不抛异常**：pi-ai 的补全层把 provider 错误编码为 `AssistantMessage` 上的 `stopReason: "error"` + `errorMessage` 字符串（`@earendil-works/pi-ai` `dist/api/openai-completions.js` 的 catch 块），经流事件传递；Agent 循环遇 error **硬退出**（发 turn_end + agent_end 后 return），不做任何重试。HTTP 400 不在 pi-ai 的重试白名单里（只重试 408/409/429/5xx）。
  3. **pi-ai 自带溢出判定器**：`isContextOverflow(message, contextWindow?)` 从包根导出，覆盖三种情况——错误消息模式匹配（含 `context_length_exceeded` 泛化模式与各家 provider 方言）、静默溢出（`usage.input > contextWindow`）、length-stop 溢出；配套 `isRecoverableLength`。不需要自己写模式匹配。
  4. **窗口大小是 provider 元数据标准字段**：`Agent.state.model.contextWindow` / `maxTokens`（pi-ai `dist/types.d.ts` 的 `Model` 接口）。内置 provider 可直接取到；自配端点（`PAGEQA_LLM_*`）拿不到，现有兜底 `FALLBACK_CONTEXT_WINDOW = 32_000`（`src/llm.ts`）。
  5. **`transformContext` 的硬约束**（pi-agent-core 无运行时校验，但破坏即炸）：toolCall/toolResult 配对必须完整（拆开会被 provider 拒绝）；leading system 消息承载 prompt 与工具声明，不可裁掉；必须**返回新数组**——循环在流式期间会原位改写 context 末尾的 partial 消息，缓存旧数组引用会踩脏数据。
  6. **续跑路径已被验证**：`executeWithContinuations`（`src/agent.ts`）在 `waitForIdle()` 后可继续 `agent.prompt()`，最多 `MAX_CONTINUATIONS = 5` 次；溢出恢复可以复用同一条路径。
  7. 真实 `usage.input` 每轮可得：`collectUsage` / `turnUsage`（`src/agent.ts`）已在汇总 provider 返回的 token 用量，TUI 已实时显示。这是免费的估算校准数据源。
  8. pi-agent-core 的 harness 层有现成 compaction 模块（`shouldCompact`/`generateSummary`/`findCutPoint`），但不属于 `Agent`，本 ADR 只作实现参考。

## 决策一：失败定性为「硬报错 + 软失忆」并存，根因是估算，不是窗口不够

中文下先撞硬上限（事实 1），英文长用例下表现为失忆。失忆的机理是：现有裁剪只保「最近 12 条消息」，步骤进度自报与断言结果若落在更早的 toolResult 里就被截掉，模型失去重入锚点。**两个症状同根**：预算算错 + 该保的没保。

## 决策二：修复全部落在 pageqa 自有层

只改 `src/agent.ts`（`transformContext`、裁剪函数、续跑循环）与 `src/llm.ts` / `src/config.ts`（窗口兜底与配置），不动 `pi-agent-core` / `pi-ai`。理由：这两个依赖现在改不了也发不了；而 pageqa 拥有上下文组装的全部入口（事实 2、6），依赖层只负责发请求。依赖层能力（如原生 compaction 钩子）作为长期方向另议，不阻塞本 ADR。

## 决策三：token 预算 = 比例近似起步 + 服务端 usage 自校准

退役全部字符常量（`CONTEXT_CHAR_LIMIT` 等），预算按 token 计：

- 估算系数 v1 取保守值：**CJK 1.0 token/字符、ASCII 0.25 token/字符**。零新依赖。
- 每轮拿到真实 `usage.input` 后，用「上轮估算 ÷ 实际 input」修正系数，**校准系数夹在 [0.5, 2.0]**——防止单轮异常值（provider 少计、计数口径差异）把估算带偏。
- 总预算 = `contextWindow − maxTokens（输出预留）− 安全边际`。

理由：真 tokenizer（tiktoken 等）对非 OpenAI 系模型（hunyuan/deepseek）没有对应词表，依赖重且不准；纯比例不校准则越长的会话偏差越放大。usage 校准是闭环，数据现成（事实 7），成本为零。

## 决策四：窗口来源三级回落，未知端点由用户声明

`Agent.state.model.contextWindow` → `~/.pageqa/config.json` 的 `contextWindow` 键 → `FALLBACK_CONTEXT_WINDOW`（32k）。配置优先于内置元数据——用户显式声明的窗口比生成目录里的假设更可信；没声明就保守兜底。压缩触发阈值同时暴露为配置（见决策六），配置面**只有这两个键**，不摊大饼。

## 决策五：压缩是纯规则裁剪，LLM 摘要只留接口不实现

v1 不做 LLM 摘要 compaction。理由：失忆的根因是「该永生的信息被截掉了」，把它保住比摘要更对症（决策七）；摘要有延迟、成本与不确定性，CI 批处理对三者都敏感。在裁剪函数签名里预留分级钩子，等真实场景证明规则不够再做——那是一个新 ADR，不是本条的默认分支。

## 决策六：两级阈值——75% 触发规则裁剪，85% 触发激进裁剪

预算占用达 **75%**：常规规则裁剪生效（旧 toolResult 截断/打标，永生清单全额保留）。达 **85%**：激进模式——只留永生清单 + 最近 **2** 轮，其余全弃。两个阈值可经 `compactThresholds` 配置键覆盖（默认 75/85）。

理由：单级裁剪在「窗口极小（32k）+ 页面快照巨大」的组合下会追不上增长，激进模式保证**任何一轮请求都不会超窗**——这是预防层的硬承诺。两个阈值都是百分比，随窗口缩放，不随模型换而失效。

## 决策七：永生清单——任何模式下不可裁剪

1. leading system 消息（prompt + 工具声明）——依赖硬约束（事实 5）。
2. **用例原文 + 步骤编号 + 自报进度**（`步骤完成：k/n`）——模型不失忆的锚点，也是报告完整性校验的依据。
3. **全部断言结果**（`AssertionResult`，含失败明细）——报告以工具产出为准，丢了就是误判。
4. 最近 6 轮完整消息（`KEEP_RECENT_MESSAGES` 从 12 **下调**，给上面三项腾预算）。
5. 当前页面锚点（URL/标题）——并入合成状态消息，不单独占位。

配套硬规则：裁剪永远保持 toolCall/toolResult 配对完整、返回新数组（事实 5）。

## 决策八：触发压缩时注入合成 user 消息（状态快照）

格式：

```text
[系统提示：较早期上下文已被压缩，以下为当前执行状态快照]
用例：<场景标题>
进度：已完成 k/n 步；下一步为第 k+1 步：<该步原文>
断言：已产出 m 条（通过 x / 失败 y），失败明细：<expectation + evidence 摘要>
当前页面：<URL> — <标题>
请从第 k+1 步继续执行。
```

理由：压缩后模型面对的是被截断的历史，与其指望它从残片里重建状态，不如直接给一份权威快照；「请从第 k+1 步继续」是明确的重入锚点。断言明细即使失败也全量保留（报告判定依据）。

## 决策九：恢复层——撞限后激进续跑一次，再撞即 fail

判定：回合结束后检查最后一条 assistant 消息，`stopReason === "error"` 且 pi-ai 的 `isContextOverflow()` 为真（事实 2、3）。处置：

- 入口在 `executeWithContinuations` 的外层循环：给共享状态打 aggressive 标记（`transformContext` 读它切换激进模式）→ `agent.prompt(继续)`。不碰 `prepareNextTurnWithContext` 等 error 回合下行为未验证的依赖层钩子。
- `MAX_OVERFLOW_RECOVERIES = 1`，独立于 5 次 continuation 预算；恢复续跑的 prompt 与普通 continuation 区分措辞，明确告知模型「上下文经历了紧急压缩，从状态快照继续」。
- 第二次撞限：直接 fail，报告写明 `context overflow` 与发生时的步骤位置，并建议「换大窗口模型或拆用例」。

理由：预防做好了恢复理论上不应触发；触发说明估算失准，给一次自救机会。第二次还撞说明窗口实在不够，果断失败并给出路，好过无限恢复循环烧钱。

## 决策十：验证策略——单测 + 假 streamFn 压力测试进 CI，真模型只做发布前抽检

- 单元测试（纯函数）：估算器（含 CJK 比例与校准夹取）、分级裁剪（配对保持、system 保留、返回新数组）、状态快照生成。
- 假 `streamFn` 压力测试：mock 模型按脚本回放工具调用，灌超长中文用例，断言「每轮请求估算 token < 预算」「撞限后恢复路径触发且最终报告完整」。零真实调用、确定性。
- 真模型长中文用例：仅发布前手动抽检，不进 CI。

理由：CI 里不该有真模型依赖——慢、花钱、结果抖动。

## 未采纳的方案

- **LLM 摘要 compaction（v1 就做）**：延迟/成本/不确定性，且不解决「该保的没保」这个根因；只留接口。
- **推到 pi-agent-core / pi-ai 层**：改不动也发不了；harness 层的 compaction 模块只作参考。
- **引入真 tokenizer**：非 OpenAI 系模型无对应词表，依赖重；usage 校准更准且免费。
- **撞限即 fail、不做恢复**：确定性最强，但一条长用例就此报废，与「预防为主」的初衷不配。
- **无限自动恢复**：恢复循环烧钱无底；一次封顶。
- **`prepareNextTurnWithContext` 钩子做恢复**：error 回合后是否触发未经事实确认，踩依赖层未定义行为有风险。
- **要求用户预拆长用例 / 依赖回放脚本规避**：用户手里就是一条长自然语言用例，工具不能把责任推回去；拆分建议只在最终 fail 报告里出现。
- **字符估算阈值调大（比如 40k → 20k）**：治标。中文下任何固定字符数都不可靠，问题在度量衡不在数值。

## 影响

- `src/agent.ts`：`transformContext` 重写为 token 预算驱动的两级裁剪（常规/激进），读共享的 aggressive 标记；`estimateChars` 由 token 估算器（含校准）取代；`trimOldToolResults` 改为「永生清单 + 配对保持 + 新数组」语义；`executeWithContinuations` 增加溢出判定与一次恢复分支；新增合成状态消息构造；新增 `[compact]` / `[overflow-recover]` 事件标记并接 `collector.noteTurnContext`。
- `src/llm.ts` / `src/config.ts`：新增 `contextWindow` 与 `compactThresholds` 两键，沿用既有「env > config > 默认」优先级；`FALLBACK_CONTEXT_WINDOW` 降为末级兜底。
- `tests/`：估算器/裁剪/快照单测 + 假 streamFn 压力测试。
- `CONTEXT.md`：补充「上下文预算与压缩」一条（执行语义变化，人需要知道）。
- README（双语）：配置键说明与「长用例」一节的相应更新。

## 落地进度

- 设计定稿（2026-09-30，经逐轮评审确认），**实施未开始**。实施顺序建议：估算器与单测 → 裁剪重写 → 合成消息 → 恢复分支 → 配置键 → 压力测试。
