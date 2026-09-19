# Spec: pageqa

页面测试 agent 是一个基于 Node.js + TypeScript 的命令行工具，用自然语言描述测试意图，由 **pi-agent-core** 状态化 agent 把意图解析为浏览器操作步骤并自动编排，通过 **browserskill（`bsk`）** 连接真实浏览器执行，最终输出可读测试报告与机器可读结果。LLM 后端默认经 **CodeBuddy 本地反代**（混元）实现免官网 Key 的自然语言解析。

## 1. 总体架构

```text
pageqa/
  package.json          # 包元数据、bin 入口、依赖（pi-agent-core, pi-ai）
  tsconfig.json         # TypeScript 编译配置
  src/
    index.ts            # CLI 入口：解析参数、装配 agent、连 bsk session、返回退出码
    agent.ts            # 编排器：pi-agent-core Agent + bsk 工具 + 报告
    llm.ts             # LLM 后端：pi-ai 自定义 provider -> CodeBuddy 反代（混元）
    bsk/tools.ts        # browserskill 工具层（navigate/snapshot/click/fill/upload/hover/scroll/wait/assert_text）
    report.ts           # 报告解析与渲染（文本/JSON）
  examples/smoke.md     # 示例自然语言测试脚本
  tests/smoke.test.mjs  # 端到端冒烟验证（覆盖 A1–A4）
```

## 2. LLM 后端（pi-agent-core + pi-ai）

- `src/llm.ts` 使用 `@earendil-works/pi-ai` 的 `createModels` / `createProvider` 构造一个自定义 `openai-completions` provider，指向 CodeBuddy 本地反代 `http://127.0.0.1:3000/v1`，模型 `hunyuan-2.0-instruct`。
- `auth` 采用静态解析的 `ApiKeyAuth`（`resolve` 返回 `{ apiKey, baseUrl }`），避免交互式 env 探测；默认 Key `codebuddy-proxy-key`。
- 模型定义需包含 pi-ai `Model` 必填字段：`api`、`provider`、`baseUrl`、`input`、`contextWindow`、`maxTokens`/`maxOutput`、`cost`（含 `tiers` 等价字段）、`compat`。
- 可通过环境变量 `PAGEQA_LLM_BASE_URL` / `PAGEQA_LLM_API_KEY` / `PAGEQA_LLM_MODEL` 覆盖；也可切换到 pi-ai 其他已配置 provider。
- `streamFn` 使用 `models.streamSimple.bind(models)`，供 `pi-agent-core` 的 Agent 驱动 LLM。

## 3. 浏览器驱动（browserskill / bsk）

- `src/bsk/tools.ts` 把 `bsk` CLI 命令包装成 `pi-agent-core` 的 `AgentTool`；每个命令带 `--session <id> --quiet`。
- `ensureSession(existing?)`：若给定 session 在 `bsk session list` 中活跃则复用，否则 `bsk session start --json` 新建。
- 可用工具：
  - `navigate(url)`：打开 URL（`--wait-until domcontentloaded`）。
  - `snapshot()`：读取页面 aria 语义树与可见文本（标题、段落、链接、按钮等），用于读取内容与定位元素。
  - `click(target)` / `fill(target, value)` / `hover(target)`：元素交互；`target` 用 `@eN` 引用或 CSS 选择器。
  - `upload(target, file)`：经 `bsk upload <target> --file <path>` 上传本地文件；`target` 为触发文件选择器的元素（或省略，由 bsk 自动查找文件输入框）。
  - `scroll(target)`：经 `evaluate` 滚动到元素。
  - `wait(ms)`：经 `wait-ms` 等待。
  - `assert_text(expectation)`：读取 snapshot 并判断是否包含文本，返回「成立/不成立」与证据。
- bsk 连接一个已运行的真实浏览器（Chrome/Edge），支持公开页与登录态页面；无需自下载浏览器。

## 4. Agent 编排（pi-agent-core）

- `src/agent.ts` 构造 `Agent`（`@earendil-works/pi-agent-core`），注入 `systemPrompt`（定义测试协议）与 bsk 工具集，使用 `llm.ts` 的 `model` 与 `streamFn`。
- Agent 订阅事件：记录工具调用与文本增量，结束（`waitForIdle`）后生成报告。
- `runAgent(input, { session?, systemPrompt? })`：返回 `{ report, text, json, transcript }`。
- 续跑保护：`waitForIdle` 后若 agent 自报进度未满（`步骤完成：k/n` 且 `k < n`），或用例中的断言尚未全部解析出来（`countAssertions` vs `parseAssertions`），则自动以「继续执行剩余步骤」再 prompt 一次，最多 5 轮；若续跑后进度与断言数都没推进则停止，避免无谓循环（长流程最常见的失败是模型做完一两步就自行收尾）。

## 5. 报告与退出码

- `src/report.ts` 从 agent 结论文本解析断言（`断言「X」：成立/不成立` 句式），无法解析时按关键字（不成立/未找到/失败/不存在）降级判定。
- 文本报告含结论（PASS/FAIL）、断言列表与证据、摘要、transcript；JSON 报告结构稳定：`{ status, assertions[], summary?, transcript, usage? }`。
- token 消耗：`runAgent` 汇总本次运行全部 assistant 消息的 `usage`（含续跑轮次）为 `TokenUsage { input, output, cacheRead, cacheWrite, reasoning, total, calls }`；`runSuite` 用 `mergeUsage` 合并各场景用量。
- 文本报告**末尾**输出一行 token 消耗（`formatUsage`），套件模式下每个场景块内也各有一行，末尾为合计；JSON 报告经 `usage` 字段输出。端点未返回 usage（`calls>0` 且 `total=0`）时须如实标注，不得把 0 当作真实消耗。
- 全部断言通过 → 退出码 `0`；任一失败/错误 → 退出码 `1`。可直接接入 CI。

## 6. CLI 接口

```text
pageqa [options] <input>

<input>            自然语言脚本文件（.md/.txt）或内联文本（按行解析多句）

选项:
  --session <id>   指定已存在的 bsk session（默认自动创建）
  --json           输出 JSON 报告
  --out <file>     将报告写入文件
  -h, --help       帮助
```

- 文件输入：仅当 input 确为已存在文件路径（含 `.md`/`.txt` 且无内换行）时读取；否则视为内联文本。
- 脚本占位符：读取脚本（文件或内联文本）时按本机当前时间展开 `${timestamp}`（`yyyyMMddHHmm`）、`${date}`、`${time}`、`${datetime}`，以及自定义格式 `${timestamp:<格式>}`（`yyyy`/`yy`/`MM`/`dd`/`HH`/`mm`/`ss`/`SSS`）；同一次运行共用同一时刻，未识别的占位符原样保留。用于「名称 + 时间戳」这类要求每次运行不重名、又不写死时间戳的用例。
- 无参数时打印帮助并以非零退出。

## 7. 验收映射

- A1：自然语言「打开 https://example.com 并断言标题包含 Example」→ agent 驱动浏览器打开页面、读取标题、通过报告（exit 0）。
- A2：含交互意图「点击链接并断言页面出现某文本」→ 完成导航、点击、等待、断言。
- A3：断言不存在文本 → 失败报告 + 可读原因 + 退出码非零（1）。
- A4：`--json` 与文本报告均可输出，结构稳定、CI 可解析。

## 8. 约束（与不变量一致）

- 浏览器操作通过 bsk 连接真实浏览器；需先有可用 session（CLI 自动创建/复用）。
- 自然语言解析依赖 LLM（pi-agent-core + pi-ai）；默认后端为 CodeBuddy 反代（混元），无反代时不可用。
- 失败必须给出可读原因（期望值、实际值、页面证据），不得静默通过。
- 报告与退出码使工具可被 CI 直接消费。
