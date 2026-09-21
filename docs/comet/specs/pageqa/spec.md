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
    bsk/tools.ts        # browserskill 操作层（BskOps）与工具层（navigate/snapshot/click/fill/upload/hover/scroll/wait/assert_text）
    record.ts           # 录制层：把成功操作与断言记成可回放步骤（含语义定位符、占位符还原）
    locator.ts          # 语义定位符：快照解析 + 回放时按 role/name/同名序号重定位
    replay.ts           # 回放脚本：格式定义、读写校验、零模型回放引擎
    snapshot.ts         # 快照瘦身：保留可交互节点与祖先链、截断长文本，降低上下文压力
    report.ts           # 报告解析、渲染与套件汇总（LLM 运行与回放共用）
  examples/smoke.md     # 示例自然语言测试脚本
  tests/smoke.test.mjs  # 端到端冒烟验证（覆盖 A1–A4）
  tests/report.test.mjs / tests/replay.test.mjs / tests/snapshot.test.mjs  # 单元测试（无浏览器/LLM 依赖）
```

## 2. LLM 后端（pi-agent-core + pi-ai）

- `src/llm.ts` 使用 `@earendil-works/pi-ai` 的 `createModels` / `createProvider` 构造一个自定义 `openai-completions` provider，指向 CodeBuddy 本地反代 `http://127.0.0.1:3000/v1`，模型 `hunyuan-2.0-instruct`。
- `auth` 采用静态解析的 `ApiKeyAuth`（`resolve` 返回 `{ apiKey, baseUrl }`），避免交互式 env 探测；默认 Key `codebuddy-proxy-key`。
- 模型定义需包含 pi-ai `Model` 必填字段：`api`、`provider`、`baseUrl`、`input`、`contextWindow`、`maxTokens`/`maxOutput`、`cost`（含 `tiers` 等价字段）、`compat`。
- 可通过环境变量 `PAGEQA_LLM_BASE_URL` / `PAGEQA_LLM_API_KEY` / `PAGEQA_LLM_MODEL` 覆盖；也可切换到 pi-ai 其他已配置 provider。
- `streamFn` 使用 `models.streamSimple.bind(models)`，供 `pi-agent-core` 的 Agent 驱动 LLM。

## 3. 浏览器驱动（browserskill / bsk）

- `src/bsk/tools.ts` 分两层：`createBskOps`（操作层，一次浏览器操作 = 一条 bsk 命令）与 `createBskTools`（工具层，包装成 `pi-agent-core` 的 `AgentTool`）；每个命令带 `--session <id> --quiet`。回放引擎直接用操作层，保证「录制时怎么操作」与「回放时怎么操作」是同一条命令路径。
- `ensureSession(existing?)`：若给定 session 在 `bsk session list` 中活跃则复用，否则 `bsk session start --json` 新建。
- `closeSession(session)`：调用 `bsk session stop <id>` 收尾，关闭该 session 的 Agent Window（自动化操作的浏览器窗口）并归还借用标签页；由 `runAgent` 的 `finally` 保证在成功、失败、抛错三种路径都会执行，失败仅提示、不影响测试结论。
- 可用工具：
  - `navigate(url)`：打开 URL（`--wait-until domcontentloaded`）。
  - `snapshot()`：读取页面 aria 语义树与可见文本（标题、段落、链接、按钮等），用于读取内容与定位元素。返回前经 `snapshot.ts` 瘦身（超 8000 字符才启用：保留全部 `@eN` 行与其祖先链、截断超长文本行、超预算时省略最长的非关键行），并在期间无页面改动且间隔很短时复用上一份快照，省掉一次 bsk 往返。
  - `click(target)` / `fill(target, value)` / `hover(target)`：元素交互；`target` 用 `@eN` 引用或 CSS 选择器。
  - `upload(target, file)`：经 `bsk upload <target> --file <path>` 上传本地文件；`target` 为触发文件选择器的元素（或省略，由 bsk 自动查找文件输入框）。
  - `scroll(target)`：经 `evaluate` 滚动到元素。
  - `wait(ms)`：经 `wait-ms` 等待。
  - `assert_text(expectation)`：读取快照先做**字面包含匹配**（命中即成立，不调用 Jev；字面匹配基于瘦身前的完整快照，长文本被截断不会造成假未命中）；字面未命中且已启用 Jev 时，再请 Jev 做一次语义复核（`prob >= threshold` 即成立），返回「成立/不成立」与证据。
- bsk 连接一个已运行的真实浏览器（Chrome/Edge），支持公开页与登录态页面；无需自下载浏览器。

## 4. Agent 编排（pi-agent-core）

- `src/agent.ts` 构造 `Agent`（`@earendil-works/pi-agent-core`），注入 `systemPrompt`（定义测试协议）与 bsk 工具集，使用 `llm.ts` 的 `model` 与 `streamFn`。
- Agent 订阅事件：记录工具调用与文本增量，结束（`waitForIdle`）后生成报告。
- `runAgent(input, { session?, systemPrompt? })`：返回 `{ report, text, json, transcript }`。
- 续跑保护：`waitForIdle` 后若 agent 自报进度未满（`步骤完成：k/n` 且 `k < n`），或用例中的断言尚未全部解析出来（`countAssertions` vs `parseAssertions`），则自动以「继续执行剩余步骤」再 prompt 一次，最多 5 轮；若续跑后进度与断言数都没推进则停止，避免无谓循环（长流程最常见的失败是模型做完一两步就自行收尾）。

## 5. 报告与退出码

- `src/report.ts` 组装报告。断言**优先取 `assert_text` 工具返回的结构化结果**（期望值 + 成立/不成立 + 证据，由工具层经 `onExec` 逐条上报）：工具结论是确定性的，而模型自述的措辞不可靠（常写成「…，断言成立。」，既没有期望值也无法解析，据此外推会把全部通过的用例报成「用例中的断言全部执行（实际 0/N）」的假失败）。只有在拿不到工具结果时（回放、纯文本输入）才解析结论文本（`断言「X」：成立/不成立` 句式），并沿用按关键字（不成立/未找到/失败/不存在）的降级判定。
- 文本报告含结论（PASS/FAIL）、断言列表与证据、摘要、transcript；JSON 报告结构稳定：`{ status, assertions[], summary?, transcript, usage? }`。
- token 消耗：`runAgent` 汇总本次运行全部 assistant 消息的 `usage`（含续跑轮次）为 `TokenUsage { input, output, cacheRead, cacheWrite, reasoning, total, calls }`；`runSuite` 用 `mergeUsage` 合并各场景用量。
- 文本报告**末尾**输出一行 token 消耗（`formatUsage`），套件模式下每个场景块内也各有一行，末尾为合计；JSON 报告经 `usage` 字段输出。端点未返回 usage（`calls>0` 且 `total=0`）时须如实标注，不得把 0 当作真实消耗。
- 全部断言通过 → 退出码 `0`；任一失败/错误 → 退出码 `1`。可直接接入 CI。

## 6. 录制与回放（零模型重跑）

- **录制**：`createBskTools` 的 `onExec` 回调把每次工具执行（含入参、成败、操作前的最后一份快照）交给 `Record`（`src/record.ts`）。只记录**成功**的操作（失败的尝试是模型的探索过程）；`snapshot` 不记录（它只服务于模型的观察）。每条记录附：
  - `step`：尽力映射的用例步骤号——取「上一个『第 k 步完成』自述 + 1」，映射不到为 null；
  - `locator`：由操作前快照解析出的语义定位符（`{role, name, nth, target}`），见下；
  - 字符串里已展开的 `${...}` 取值会被还原回占位符写法（`restorePlaceholders`，仅还原长度 ≥ 8 的取值，避免误伤页面里的无关数字），另存录制当次的字面量以便人工核对。**定位符里的可访问名同样要还原**（列表里点的常是「刚创建的那条」，名字带时间戳），否则回放必然定位失败；用例原文（`caseSteps`）也按占位符形式写进脚本，与用户的用例文件保持一致。
- **定位符（`src/locator.ts`）**：bsk 的 `@eN` 只在产生它的那次快照内有效，因此**不存 `@eN`**。改为从快照行 `@e1 link "Learn more"` 解析出「角色 + 可访问名 + 祖先路径」，并记下同名候选中的序号 `nth`。回放时用当次快照重新解析：全等 → role 相同且 name 包含 → 只看 name；命中多个时先用**祖先路径**消歧（快照缩进即层级，`pathScore` 从最深一层往上数连续相同的层数，唯一最高分即命中），路径无法区分才退回 `nth`。解析不到时退回录制时的 target（是 CSS 仍可用），都失败即报错，绝不猜元素。
  - 祖先路径是为「同名元素很多」设计的：详情页同时存在页面级与区域级的「操作」下拉，只按 `nth` 会随元素数量变化指错，而「在哪个 `menu`/`tabpanel`/`dialog` 之下」更抗漂移。路径条目名字超过 60 字符会截断（`main` 的可访问名可能是整页文本）、只保留最深 3 层，且截断在录制/回放两侧同规则执行，比较依旧有效。
  - 定位失败时用 `locatorHint` 区分三类线索：**similar-name**（名字相近的元素存在，多半是改名）、**role-only**（该角色元素存在但名字都不同，多半点错了另一个同名菜单）、**no-role**（该角色元素一个都没有，菜单/弹窗并未打开），写进跳过/失败原因。
- **悬停触发的下拉菜单**：系统提示要求「先 hover 触发按钮、确认菜单项出现在快照里，再 click 菜单项」，并提醒同名下拉要按当前区域选择；`hover` 属正常录制的步骤，回放照做。
- **回放脚本（`src/replay.ts`）**：`{ format: "pageqa-replay", version, recordedAt, source: {path, hash}, scenarios: [{name, caseSteps, steps}] }`；`loadReplayScript` 校验格式/版本，并**拒绝空步骤脚本**（否则会伪装成「0 步全通过」）。`source.hash` 用于回放时提示源用例已变更（只警告不失败）。加载时还会用脚本自带的 `recorded*` 字段反推「录制当次取值 → 占位符」，把旧脚本里写死的动态取值就地还原（改写范围限于用例原文、定位符名、填入值、断言期望；不动 `file`/`target`/`url`），免去为一个字段重跑一次十几分钟的 LLM 用例。
- **回放引擎**：逐场景执行，各自 `ensureSession` / `closeSession`（独立浏览器窗口）。单场景输出单份报告；多场景用 `summarizeSuite` 汇总，语义与 `--suite` 一致（任一场景失败即整体失败、退出码非零）。每步最多**重试 3 次**（间隔 500ms、每次重新取快照），对齐 bsk 时序抖动与弹窗/动画延迟。失败语义三分（`executeReplaySteps`，结论判定 `replayScenarioStatus`）：
  - **元素未找到（`LocatorMissError`）** → 记为**跳过**并继续，**不算失败**。这表达的是「当前页面状态下这一步不需要」，最典型是录制期模型补点的「取 消」类清理动作；实测中它曾让 65 步用例在第 12 步整条报废。跳过必须显式呈现（报告 `skipped` 字段 + `[replay-skip]` 轨迹行 + 摘要里的跳过数），不得悄悄略过。
  - **其它失败**（元素找到但操作报错、断言不成立）→ 记为失败并**继续跑完**剩余步骤，一次给出完整健康报告；报告指出「回放第 n 步（kind）／对应用例第 k 步：<用例原文>」。
  - **navigate 失败** → 后续步骤无意义，中止。
  - `--fail-fast` 恢复「任一失败即停」。
  - **结论判定必须同时看断言**：`failed > 0 || aborted || 任一断言不成立` → fail；只统计抛出的步骤失败会漏掉「断言返回不成立」，导致带 FAIL 断言的用例报 PASS（已用单测钉死）。
- **零模型边界**：回放默认断言走字符串包含，不触碰任何远端服务；`--semantic` 才启用 Jev。录制时**靠 Jev 语义复核才成立**的断言（字面不含期望文本）会带 `semantic: true` 标记，回放开始前提示有几条、失败时提示「可加 `--semantic` 重试」；字面命中的断言不标记（回放同样能通过）。
- **报告与用量**：回放报告 `mode: "replay"`、`script: <path>`，`usage` 全 0；文本报告标注「模式: 回放（未调用大模型）」，token 行显示「未调用大模型（回放模式）」而不是「合计 0」。

## 7. CLI 接口

```text
pageqa [options] <input>

<input>            自然语言脚本文件（.md/.txt）或内联文本（按行解析多句）

选项:
  --session <id>   指定已存在的 bsk session（默认自动创建）
  --json           输出 JSON 报告
  --emit-script [path]
                   运行结束后把成功操作固化为回放脚本；不给 path 时写到源用例同目录
                   <用例名>.replay.json（内联文本写 ./pageqa.replay.json）
  --replay <file>  零模型回放已有脚本（与用例输入互斥，且与 --emit-script 互斥）
  --semantic       回放时断言改用 Jev 语义判断（默认字符串包含）
  --out <file>     将报告写入文件
  -h, --help       帮助
```

- `--emit-script` 的路径是可选值：紧随其后的 token 仅在「像路径」时（非 `-` 开头、非 `.md`/`.txt` 结尾、无空白与中文）才被当作输出路径消费，否则留给用例输入位。PASS/FAIL 都会生成（失败轨迹也能导出排查）。
- 位置参数只接受一个：多给一个直接报错。此前是后者覆盖前者，`--emit-script ./replay` 这类写法一旦没被识别成路径，就会静默把用例换成 `./replay` 去跑，看起来正常启动却测了完全无关的文本。

- 文件输入：仅当 input 确为已存在文件路径（含 `.md`/`.txt` 且无内换行）时读取；否则视为内联文本。
- 脚本占位符：读取脚本（文件或内联文本）时按本机当前时间展开 `${timestamp}`（`yyyyMMddHHmm`）、`${date}`、`${time}`、`${datetime}`，以及自定义格式 `${timestamp:<格式>}`（`yyyy`/`yy`/`MM`/`dd`/`HH`/`mm`/`ss`/`SSS`）；同一次运行共用同一时刻，未识别的占位符原样保留。用于「名称 + 时间戳」这类要求每次运行不重名、又不写死时间戳的用例。
- 无参数时打印帮助并以非零退出。

## 8. 验收映射

- A1：自然语言「打开 https://example.com 并断言标题包含 Example」→ agent 驱动浏览器打开页面、读取标题、通过报告（exit 0）。
- A2：含交互意图「点击链接并断言页面出现某文本」→ 完成导航、点击、等待、断言。
- A3：断言不存在文本 → 失败报告 + 可读原因 + 退出码非零（1）。
- A4：`--json` 与文本报告均可输出，结构稳定、CI 可解析。
- A5：`--emit-script` 生成的脚本可被 `--replay` 零模型重跑；脚本不含 `@eN`、含语义定位符；回放报告 `mode: "replay"`、token 行为「未调用大模型」；失败时报告指出「回放第 n 步 / 对应用例第 k 步」。

## 9. 约束（与不变量一致）

- 浏览器操作通过 bsk 连接真实浏览器；需先有可用 session（CLI 自动创建/复用）。
- 自然语言解析依赖 LLM（pi-agent-core + pi-ai）；默认后端为 CodeBuddy 反代（混元），无反代时不可用。
- 失败必须给出可读原因（期望值、实际值、页面证据），不得静默通过。
- 报告与退出码使工具可被 CI 直接消费。
- 回放必须零模型：`--replay` 不得调用 LLM；断言默认字符串匹配，`--semantic` 是显式例外。
- 回放不得猜元素：语义定位与 target 兜底都失败时如实报错，避免点错元素造成假通过。
