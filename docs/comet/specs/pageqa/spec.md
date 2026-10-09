# Spec: pageqa

页面测试 agent 是一个基于 Node.js + TypeScript 的命令行工具，用自然语言描述测试意图，由 **pi-agent-core** 状态化 agent 把意图解析为浏览器操作步骤并自动编排，通过 **browserskill（`bsk`）** 连接真实浏览器执行，最终输出可读测试报告与机器可读结果。LLM 后端默认经 **CodeBuddy 本地反代**（混元）实现免官网 Key 的自然语言解析。

## 1. 总体架构

```text
pageqa/
  package.json          # 包元数据、bin 入口、依赖（pi-agent-core, pi-ai, pi-durable, chord, pi-tui）
  tsconfig.json         # TypeScript 编译配置
  src/
    index.ts            # CLI 入口：解析参数（含 sessions 子命令）、装配 agent、连 bsk session、返回退出码
    agent.ts            # 编排器：pi-agent-core Agent + bsk 工具 + 报告（含默认系统提示）
    llm.ts              # LLM 后端：pi-ai 自定义 provider -> CodeBuddy 反代（混元）
    free-providers.ts   # 免费网关目录（数据取自 pi-free）：内置快照 + 动态 /v1/models，只列免费条目
    proxy.ts            # 模型请求的代理路由：按域名规则 direct / proxy / fallback（~/.pageqa/proxy.json）
    bsk/tools.ts        # browserskill 操作层（BskOps）与工具层（13 个 AgentTool）
    bsk/picker.ts       # 选择类控件（下拉/日期）的页面侧探针：表达式构造与结果解析（纯逻辑）
    bsk/condition.ts    # wait_for 的页面侧探针与轮询框架
    bsk/settle.ts       # 「页面已稳定」探针
    record.ts           # 录制层：把成功操作与断言记成可回放步骤（含语义定位符、占位符还原）
    locator.ts          # 语义定位符：快照解析 + 回放时按 role/name/同名序号重定位
    replay.ts           # 回放脚本：格式定义、读写校验、零模型回放引擎
    snapshot.ts         # 快照瘦身：full（关键行 + 精简文本）/ refs（只留可交互元素清单）两档
    report.ts           # 报告解析、渲染与套件汇总（LLM 运行与回放共用）
    report-html.ts      # 自包含 HTML 报告渲染（旁路产物之一）
    session-archive.ts  # 运行存档：参数 + 每轮上下文 + 每次工具调用，落 SQLite 单容器
    session-server.ts   # session 查询服务：本地 HTTP + 服务端渲染的列表/详情页
  examples/smoke.md     # 示例自然语言测试脚本
  tests/smoke.test.mjs  # 端到端冒烟验证（覆盖 A1–A4）
  tests/*.test.mjs      # 单元测试（无浏览器/LLM 依赖）
```

## 2. LLM 后端（pi-agent-core + pi-ai）

- `src/llm.ts` 使用 `@earendil-works/pi-ai` 的 `createModels` / `createProvider` 构造一个自定义 `openai-completions` provider，指向 CodeBuddy 本地反代 `http://127.0.0.1:3000/v1`，模型 `hunyuan-2.0-instruct`。
- `auth` 采用静态解析的 `ApiKeyAuth`（`resolve` 返回 `{ apiKey, baseUrl }`），避免交互式 env 探测；默认 Key `codebuddy-proxy-key`。
- 模型定义需包含 pi-ai `Model` 必填字段：`api`、`provider`、`baseUrl`、`input`、`contextWindow`、`maxTokens`/`maxOutput`、`cost`（含 `tiers` 等价字段）、`compat`。
- 可通过环境变量 `PAGEQA_LLM_BASE_URL` / `PAGEQA_LLM_API_KEY` / `PAGEQA_LLM_MODEL` 覆盖；也可切换到 pi-ai 其他已配置 provider。
- `streamFn` 使用 `models.streamSimple.bind(models)`，供 `pi-agent-core` 的 Agent 驱动 LLM。

- **出口（`src/proxy.ts`）**：模型端点直连不通时要能改走代理，但 `127.0.0.1` 上的本地端点与 bsk daemon 必须直连——一刀切设 `HTTP_PROXY` 会把它们也塞进代理（症状是「连上了但不回话」）。因此按域名逐条决定：`direct` / `proxy` / `fallback`（先直连、遇网络层错误再走代理），规则自上而下第一条命中者胜，都不命中按全局 `mode`。装配点是替换 `globalThis.fetch`（pi-ai 每次请求才构造 SDK 客户端，取的是当时的全局 fetch），走代理时用 undici 自带的 fetch + `ProxyAgent`（外部 undici 的 dispatcher 与 Node 内置 fetch 跨大版本不兼容）。配置在 `~/.pageqa/proxy.json`（`--init-config` 生成模板），环境变量 `PAGEQA_PROXY_URL` / `_ENABLED` / `_MODE` 优先，交互模式 `/proxy` 面板可开关并查看统计与规则。详见 `docs/adr/0016`。

- **免费网关（`src/free-providers.ts`）**：`/model` 除自定义端点与 pi-ai 内置 provider 外，还自带一批免费 OpenAI 兼容网关（cline / llm7 / fastrouter / orcarouter / xkiro），目录数据取自 pi-free 的 `docs/providers.md` 与 `docs/free_models.md`（2026-08-26 审计）。每个网关的模型目录是「内置快照（基线）+ 动态 `fetchModels` 打公开 `/v1/models`」，只保留免费条目（快照命中或该网关自己声明的命名规律，llm7 只认快照）；刷新失败静默回落快照，因此断网也总有模型可选。允许匿名的三个（cline / llm7 / fastrouter）无凭据也 resolve，因此照常出现在 `/model`，其余两个需 key。详见 `docs/adr/0017`。

## 3. 浏览器驱动（browserskill / bsk）

- `src/bsk/tools.ts` 分两层：`createBskOps`（操作层，一次浏览器操作 = 一条 bsk 命令）与 `createBskTools`（工具层，包装成 `pi-agent-core` 的 `AgentTool`）；每个命令带 `--session <id> --quiet`。回放引擎直接用操作层，保证「录制时怎么操作」与「回放时怎么操作」是同一条命令路径。
- `ensureSession(existing?)`：若给定 session 在 `bsk session list` 中活跃则复用，否则 `bsk session start --json` 新建。
- `closeSession(session)`：调用 `bsk session stop <id>` 收尾，关闭该 session 的 Agent Window（自动化操作的浏览器窗口）并归还借用标签页；由 `runAgent` 的 `finally` 保证在成功、失败、抛错三种路径都会执行，失败仅提示、不影响测试结论。
- 可用工具：
  - `navigate(url)`：打开 URL（`--wait-until domcontentloaded`）。
  - `snapshot()`：读取页面 aria 语义树与可见文本（标题、段落、链接、按钮等），用于读取内容与定位元素。返回前经 `snapshot.ts` 瘦身，两个档位：`full`（超 8000 字符才启用：保留全部 `@eN` 行与其祖先链、截断超长文本行、超预算时省略最长的非关键行；仍超预算则把同名叶子折进行尾的 `[xN: @eA @eB …]`）与 `refs`（只保留可交互元素、它们的祖先链与元信息行，丢掉全部纯文本，**总是**裁剪——动作后的清单走这一档）。并在期间无页面改动且间隔很短时复用上一份快照，省掉一次 bsk 往返。
  - `click(target, showPage?)` / `fill(target, value, showPage?)` / `hover(target, showPage?)`：元素交互；`target` 用 `@eN` 引用或 CSS 选择器。`showPage: true` 时在结果里附一份 `refs` 档位的「动作后的可交互元素」清单，省掉紧接着的那次 `snapshot`（**默认关闭**：清单本身不小，每步都带会把上下文撑大）。
  - `select_option(target, option)`：下拉框/级联选择器**一次调用**完成「点开控件 → 等浮层可见 → 按可见文本匹配选项 → 真实点击」。匹配先全等再包含，禁用项（`is-disabled` / `aria-disabled`）一律跳过；找不到浮层或选项时报错，并把当前可选项列出来，交由模型退回通用路径。
  - `pick_date(target, date, endDate?)`：日期选择器**一次调用**完成「点开面板 → 翻到目标年月 → 点中那一天 →（有「确定」则点它）」。`date` 支持 `2026-09-29` / `2026/9/29` / `2026年9月29日` 与相对写法 `today` / `今天` / `+3` / `-7`；解析不出即报错，**不退回「今天」猜一个**。
    - **日期范围**（range 类型，「开始~结束」两个输入框）：把结束日期传进 `endDate`，工具按「选开始 → 选结束 → 确定」走。探针读面板里**每张日历表**的年月，据此决定「目标日点在哪张表里」——左右两表可能出现同一个日号（左边 9 月 5 日、右边 10 月 5 日），不区分表就会点到相邻月的同一天。
    - **类型必须与参数一致**：范围面板只给一个日期、或单日期面板给了 `endDate`，都**当场报错**。「只选了一端的范围 + 点掉确定」会在页面上留下一个半截筛选条件，而工具还会报成功——那种假成功比报错难查得多。结束早于开始同样当场拒绝（那是用例写反了，不是页面问题）。
    - 面板已可见时不再点输入框（再点会把刚打开的面板关掉）；翻月份最多 12 次（范围窗口宽两个月，仍覆盖约一年），超过说明目标日期算错了；面板里读不出年月时不导航，按当前显示直接点，点不到再如实报错。
  - **选择类控件的混合策略（`src/bsk/picker.ts`）**：分三层。
    - **关联定位（优先）**：Element Plus 的 el-select 输入框带 `aria-controls`，顺着它精确拿到**这个控件自己的**浮层；`target` 是 `@eN`（页面侧解析不了）时退回 `document.activeElement`（点开后焦点会落到该控件的输入框上）。这一层顺带回答「target 到底打开了没有」——浮层节点常驻 DOM，关着时尺寸为 0，据此排除。
    - **可见性探测（回退）**：按「组件库专用选择器（`.el-select-dropdown`、`.el-picker-panel` 等）→ 通用 ARIA（`[role=listbox]`、`[role=option]`）」逐候选找**可见**的那个，供没有 `aria-controls` 的组件库使用。
    - **根标记**：探针命中时给那个元素打 `data-pageqa-root`，「在浮层里找选项」「在哪张表里点日子」「点哪个箭头/确定」一律以它为范围（后者经 `scopedToRoot`）。**只传选择器字符串是不够的**——`querySelector('.el-select-dropdown')` 拿到的永远是 DOM 里第一个，而页面上有几个下拉就有几个常驻 DOM 的 popper，第一个往往属于别人；「点开消息类型却读到机器人、WEBHOOK」就是这么来的。
    - **真实点击路径**：命中后先给目标元素打 `data-pageqa-pick`，再用 `bsk click '[data-pageqa-pick="1"]'` 点击（而不是在 evaluate 里调 `element.click()`），因此与其它动作共用同一条命令路径、录制回放也照此。
    - **过滤**：禁用项（`is-disabled` / `aria-disabled`）、不可见项（别的下拉留下的隐藏节点）、日期表格里 `.prev-month` / `.next-month` 的相邻月份格子、以及日期文本非全等的格子（找「1」不能命中「11」）都不算命中。
    - **操作后等浮层收起**：浮层收起前一直盖在下面的控件上，不等它消失就去点下一个控件，那一下会落在浮层上（A 的下拉没关、B 的下拉没开）。最多等 1.5s，等不到也不影响后续——多选下拉本就不关闭。
    - 都命中不了就如实报错，让模型退回「看快照自己点」的通用路径——**绝不猜元素**；每次操作前先清掉上一轮残留的两个标记（点击标记与根标记）。
  - **引用闸门**：`@eN` 只对产生它的那次快照成立，而编号会随页面变化（展开侧边栏/折叠菜单、悬停弹出菜单、切换路由、提交表单）整体位移——沿用旧编号不会报错，而是静默点到同编号的另一个元素。因此 click/fill/hover/scroll/upload/download/select_option/pick_date 在动作前都用最近一次快照核对引用：快照之后有过任何改页面动作（navigate/click/fill/hover/scroll/wait）→ 拒绝并提示重新 snapshot；编号不在最近一次快照里 → 拒绝；通过时把解析出的 role/name 作为「（落点：…）」回显在操作结果里，供模型与日志核对。CSS 选择器不经过该判定（与快照编号无关）。判定逻辑在 `src/locator.ts` 的 `inspectRefTarget`（纯函数，有单测）。
  - `upload(target, file)`：经 `bsk upload <target> --file <path>` 上传本地文件；`target` 为触发文件选择器的元素（或省略，由 bsk 自动查找文件输入框）。
  - `scroll(target)`：经 `evaluate` 滚动到元素。
  - `wait(ms)`：经 `wait-ms` 等待。只该用于**页面之外**的事情（等服务端生成导出文件、后台排队）。
  - `wait_for(text | selector | gone, timeoutMs?)`：等到条件成立——页面**可见文本**出现、某元素出现、某元素消失；三者只能给一个。轮询用 `textContent` 粗筛（便宜、不触发布局），命中后用一次 `innerText` 复核可见性；超时则取一段页面当前可见文本作为证据，并劝阻「再等一遍」。与 `settle` 同一条实现路线：同步探针 + 外层轮询，不依赖页面内定时器（后台标签页的定时器会被节流到 1s 以上）。见 `src/bsk/condition.ts`。
  - `assert_text(expectation, absent?)`：读取快照先做**字面包含匹配**（命中即成立，不调用 Jev；字面匹配基于瘦身前的完整快照，长文本被截断不会造成假未命中）；字面未命中且已启用 Jev 时，再请 Jev 做一次语义复核（`prob >= threshold` 即成立），返回「成立/不成立」与证据。
    - **`absent: true` = 反向断言**（断言页面**不包含**该文本，字面命中即不成立），用例里的「断言页面不包含 X / X 不应出现」用它表达；`expectation` 只放 X 本身，否定不写进文本。
    - 反向断言**不做语义复核**：「页面上有没有和 X 意思相近的文字」不是可校验的命题，把它当证据只会把一条本该成立的断言按匹配度判掉（A3 现场：3% 匹配度 → FAIL）。
    - **快照过短（页面还没打开）时两个方向都判「不成立」**：空页面上确实「什么都不存在」，但那是「还没导航」而不是「页面确认没有这段文字」——反向断言在这里判成立会制造最危险的假通过。判定规则在 `literalAssertion`（纯函数，有单测）。
- bsk 连接一个已运行的真实浏览器（Chrome/Edge），支持公开页与登录态页面；无需自下载浏览器。

## 4. Agent 编排（pi-agent-core）

- `src/agent.ts` 构造 `Agent`（`@earendil-works/pi-agent-core`），注入 `systemPrompt`（定义测试协议）与 bsk 工具集，使用 `llm.ts` 的 `model` 与 `streamFn`。
- Agent 订阅事件：记录工具调用与文本增量，结束（`waitForIdle`）后生成报告。
- `runAgent(input, opts)`：`opts` 含 `session?`（复用已有 bsk session）、`systemPrompt?`（覆盖默认测试协议）、`scenarioName?`、`vars?`、`scriptPath?`（仅在报告里标注落盘位置）、`model?` / `catalog?`（交互模式注入，使 `/login` 的凭据与 `/model` 的切换对本场景立即生效）、`abortSignal?`（Esc 中止）、`debug?`、`onUsage?`（每轮 LLM 调用后回调**累计**用量，供界面实时显示）。返回 `{ report, text, json, transcript, usage, recordings }`——`recordings` 是本次录制到的可回放步骤，失败运行同样有，便于排查「模型这次到底做了什么」。
- 上下文压力控制：`transformContext` 钩子在字符数超过 40000 时裁掉较早的工具结果（最近 12 条保持完整，更早的截到 1500 字符），避免长流程把早期的步骤说明挤出上下文、导致模型提前收尾。
- 开跑前先探活模型：不通则抛 `ModelUnreachableError`，**一条用例都不执行**（探活在 bsk 就绪检查与建 session 之前，因此连浏览器窗口都不会开）。
- 续跑保护：`waitForIdle` 后若 agent 自报进度未满（`步骤完成：k/n` 且 `k < n`），或用例中的断言尚未全部解析出来（`countAssertions` vs `parseAssertions`），则自动以「继续执行剩余步骤」再 prompt 一次，最多 5 轮；若续跑后进度与断言数都没推进则停止，避免无谓循环（长流程最常见的失败是模型做完一两步就自行收尾）。

## 5. 报告与退出码

- `src/report.ts` 组装报告。断言**优先取 `assert_text` 工具返回的结构化结果**（期望值 + 成立/不成立 + 证据，由工具层经 `onExec` 逐条上报）：工具结论是确定性的，而模型自述的措辞不可靠（常写成「…，断言成立。」，既没有期望值也无法解析，据此外推会把全部通过的用例报成「用例中的断言全部执行（实际 0/N）」的假失败）。只有在拿不到工具结果时（回放、纯文本输入）才解析结论文本（`断言「X」：成立/不成立` 句式），并沿用按关键字（不成立/未找到/失败/不存在）的降级判定。
- 文本报告含结论（PASS/FAIL）、断言列表与证据、摘要、transcript；JSON 报告结构稳定：`{ status, mode?, assertions[], summary?, transcript, usage?, trace?, steps?, skipped?, durationMs? }`（`mode: "replay"` 标记回放；`skipped` 是回放中因元素未找到而跳过的步骤，不算失败但必须让人看见）。
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
- **选择类控件记成「一个」步骤**：`select_option` / `pick_date` 各记成一步（`ReplayStep` 的 `select_option` / `pick_date`），而不是展开成「click 展开 + click 选项」——展开后的选项是浮层，它的 `@eN` 只在那一次快照里有效，展开成两条 click 等于把录制当次的编号写进脚本。回放时控件本身仍走语义定位（与 click 同一条路径），「展开 → 匹配 → 点击」的中间态由操作层内部完成：录制与回放调用的是同一个 `BskOps` 方法，不存在两套实现漂移。选项文本与日期同样按占位符写法保存，并参与加载时的 `recorded*` 反查还原。
- **新增步骤类型不升 `REPLAY_VERSION`**：闸门是加载时的逐步类型校验（`REPLAY_STEP_KINDS`），读到不认识的类型会当场报「不支持的步骤类型」并指出是哪个步骤、哪个文件；升版本号会把「只含 click/fill 的新脚本」也一起拒掉，代价更大而精度更低。`wait_for` / `select_option` / `pick_date` 都按这条处理，且有单测钉住「全部类型都在白名单里」。
- **回放脚本（`src/replay.ts`）**：`{ format: "pageqa-replay", version, recordedAt, source: {path, hash}, scenarios: [{name, caseSteps, steps}] }`；`loadReplayScript` 校验格式/版本，并**拒绝空步骤脚本**（否则会伪装成「0 步全通过」）。`source.hash` 用于回放时提示源用例已变更（只警告不失败）。加载时还会用脚本自带的 `recorded*` 字段反推「录制当次取值 → 占位符」，把旧脚本里写死的动态取值就地还原（改写范围限于用例原文、定位符名、填入值、断言期望；不动 `file`/`target`/`url`），免去为一个字段重跑一次十几分钟的 LLM 用例。
- **回放引擎**：逐场景执行，各自 `ensureSession` / `closeSession`（独立浏览器窗口）。单场景输出单份报告；多场景用 `summarizeSuite` 汇总，语义与 `--suite` 一致（任一场景失败即整体失败、退出码非零）。每步最多**重试 3 次**，两次尝试之间用 `ops.settle()`（页面已稳定就立刻重试，真在加载/播动画时才等、上限 800ms，取代了原先固定的 500ms；每次重试都重新取快照），对齐 bsk 时序抖动与弹窗/动画延迟。`navigate` 不重试（目标不可达不会因为等一下再试就变得可达）。失败语义三分（`executeReplaySteps`，结论判定 `replayScenarioStatus`）：
  - **元素未找到（`LocatorMissError`）** → 记为**跳过**并继续，**不算失败**。这表达的是「当前页面状态下这一步不需要」，最典型是录制期模型补点的「取 消」类清理动作；实测中它曾让 65 步用例在第 12 步整条报废。跳过必须显式呈现（报告 `skipped` 字段 + `[replay-skip]` 轨迹行 + 摘要里的跳过数），不得悄悄略过。
  - **其它失败**（元素找到但操作报错、断言不成立）→ 记为失败并**继续跑完**剩余步骤，一次给出完整健康报告；报告指出「回放第 n 步（kind）／对应用例第 k 步：<用例原文>」。
  - **navigate 失败** → 后续步骤无意义，中止。
  - `--fail-fast` 恢复「任一失败即停」。
  - **结论判定必须同时看断言**：`failed > 0 || aborted || 任一断言不成立` → fail；只统计抛出的步骤失败会漏掉「断言返回不成立」，导致带 FAIL 断言的用例报 PASS（已用单测钉死）。
- **断言的方向是脚本的一部分**：反向断言（`assert_text(..., absent=true)`）录成 `ReplayStep.absent: true`，回放按脚本原样执行、不重新判断用例语义——方向丢了以后「断言页面不包含 X」会被照着正向跑，一条本该通过的断言必然失败。正向断言不写这个字段（历史脚本形状不变）。
- **零模型边界**：回放默认断言走字符串包含，不触碰任何远端服务；`--semantic` 才启用 Jev。录制时**靠 Jev 语义复核才成立**的断言（字面不含期望文本）会带 `semantic: true` 标记，回放开始前提示有几条、失败时提示「可加 `--semantic` 重试」；字面命中的断言不标记（回放同样能通过）。反向断言永远是字面判断，不带 `semantic` 标记。
- **报告与用量**：回放报告 `mode: "replay"`、`script: <path>`，`usage` 全 0；文本报告标注「模式: 回放（未调用大模型）」，token 行显示「未调用大模型（回放模式）」而不是「合计 0」。

## 7. CLI 接口

```text
pageqa [options] <input>
pageqa sessions [选项]        # 子命令：起运行存档查询服务（见第 8 节）

<input>            自然语言脚本文件（.md/.txt）或内联文本（按行解析多句）

选项:
  --session <id>   指定已存在的 bsk session（默认自动创建）
  --json           输出 JSON 报告
  --suite          强制按多场景套件运行
  --only <序号|标题>
                   只跑其中一个场景（序号 1 起，或标题精确匹配）
  --concurrency <n>
                   同时跑最多 n 个场景（上限 8；默认 1 = 逐个跑）
  --tui / --no-tui 强制开/关交互模式
  --emit-script [path]
                   运行结束后把成功操作固化为回放脚本；不给 path 时写到源用例同目录
                   <用例名>.replay.json（内联文本写 ./pageqa.replay.json）
  --no-side-outputs
                   不写旁路产物（HTML 报告、默认回放脚本）
  --usage-stream   把 LLM 用量逐次打到 stderr
  --replay <file>  零模型回放已有脚本（与用例输入互斥，且与 --emit-script 互斥）
  --semantic       回放时断言改用 Jev 语义判断（默认字符串包含）
  --fail-fast      回放时任一失败即停该场景
  --settle-waits   回放时把 wait 当作「等页面稳定，上限为记下的毫秒数」
  --locate-timeout <ms>
                   回放时定位符所在区域整体缺失的等待上限（默认 8000；0 = 不等）
  --out <file>     将报告写入文件
  --debug          输出调试日志（bsk 命令与耗时、快照瘦身、Jev 请求等）
  --locale <zh|en> 界面/日志/报告的显示语种（默认 zh）
  --init-config    创建/重置配置文件
  -v, --version    版本
  -h, --help       帮助
```

- `--emit-script` 的路径是可选值：紧随其后的 token 仅在「像路径」时（非 `-` 开头、非 `.md`/`.txt` 结尾、无空白与中文）才被当作输出路径消费，否则留给用例输入位。PASS/FAIL 都会生成（失败轨迹也能导出排查）。
- 位置参数只接受一个：多给一个直接报错。此前是后者覆盖前者，`--emit-script ./replay` 这类写法一旦没被识别成路径，就会静默把用例换成 `./replay` 去跑，看起来正常启动却测了完全无关的文本。

- 文件输入：仅当 input 确为已存在文件路径（含 `.md`/`.txt` 且无内换行）时读取；否则视为内联文本。
- 脚本占位符：读取脚本（文件或内联文本）时按本机当前时间展开 `${timestamp}`（`yyyyMMddHHmm`）、`${date}`、`${time}`、`${datetime}`，以及自定义格式 `${timestamp:<格式>}`（`yyyy`/`yy`/`MM`/`dd`/`HH`/`mm`/`ss`/`SSS`）；同一次运行共用同一时刻，未识别的占位符原样保留。用于「名称 + 时间戳」这类要求每次运行不重名、又不写死时间戳的用例。
- 无参数时打印帮助并以非零退出。
- `sessions` 子命令起一个**只监听 `127.0.0.1`** 的本地服务，用于回看运行存档（见第 8 节）：`--port <n>`（默认 7331，被占用时自动向上顺延）、`--dir <path>`（默认 `~/.pageqa/sessions`）、`--no-open`（不自动打开浏览器）、`-h/--help`。它此前会被当作一条名为 `sessions` 的用例去跑，因此单列为子命令；选项解析与主解析同一条口径（缺参、坏值、未知选项、多余位置参数一律当场报错）。

## 8. session 存档与查询服务

出问题时能看到多少现场，决定了能不能查下去：默认日志（stderr）只留工具名与一行失败原因，`--debug` 也只够眼看它滚过去、事后无从翻查。因此每次运行把「交给 agent 的参数」与「运行中的完整交互」持久化下来，由 `pageqa sessions` 起服务回看。

- **存储（`src/session-archive.ts`）**：走 pi 官方的 `@earendil-works/pi-durable`（底层是 `node:sqlite`），全部运行落在**一个容器** `~/.pageqa/sessions/sessions.sqlite`。只用它的 **Session + 文档**这一层，不牵进 Harness / 模型 / 工具运行时：
  - 一次运行 = 文档族 `pageqa.archive` 的一个成员，**键就是运行 id**（按 id 取存档是一次直接查表）；
  - 列表页要的摘要 = 单例文档 `pageqa.index`（一次读就能列全，不必把每份档案的轮次与工具调用都读出来）。
  写入是**一次提交**（`session.commit(...)` 里档案与索引一起写）：一次运行的档案要么整条可读、要么一条都不存在，不会留下「看着有、实际缺」的半截记录。刻意**不用**它的 Conversation / Entry / Task 语义——档案是只写一次、之后只读的运行记录，不是可续跑的对话。
- **采集（`src/agent.ts`）**：`initializeAgent` 记录参数（系统提示词、模型、工具声明含 schema、编号后的 prompt、用例原文、步骤清单、占位符取值、bsk session、debug 开关）；`transformContext` 钩子记录**每轮实际发出**的上下文（裁剪后的版本 + 裁剪前字符数，因此「模型是不是把前面的步骤挤掉了」有据可查）；`subscribeProgress` 从 agent 事件里记录每轮耗时/用量，以及每次工具调用的入参、结果、耗时、成败。单段文本按 4000 字符截断并标注原始长度。
- **落盘时机**：正常路径在 `finalizeResult` 之后写入（带结论与总用量）；编排中途抛错时由 `runAgent` 的 `finally` 兜底写一次——那正是最需要现场的时刻。落盘**绝不影响测试结论**：写失败只提示一句、不改退出码（与旁路产物同一条口径）。
- **查询服务（`src/session-server.ts`）**：零依赖的 `node:http` 服务，服务端渲染列表页（`/`）与详情页（`/s/<id>`），另提供 JSON（`/api/sessions`、`/api/sessions/<id>`）。动态文本一律经 `escapeHtml`；`id` 走 `assertSafeId` 校验（`[A-Za-z0-9._-]`），URL 编码过的目录穿越撞在校验上返回 404。只监听回环地址——存档含系统提示词、用例文本与页面快照。
- **清理**：默认只保留最近 200 次运行（按容器里的创建时间倒序），清理失败静默（它只是维护动作，不该冒泡成「这次运行出错了」）。容器文件不存在时 `list` / `read` / `prune` 一律直接返回，不会为「看一眼列表」在磁盘上建出一个空数据库。
- **旧格式不迁移**：早期版本按「一次运行两个 JSON 文件」写在 `~/.pageqa/sessions/*.json`；再早一版把存档放在 pi 自带 session 后端的 SQLite 容器里（文件名同样是 `sessions.sqlite`，但表结构不同）。换存储格式时都不做迁移，旧数据不再被读取（列表页会显示为空，可手动删除容器文件）。

## 9. 验收映射

- A1：自然语言「打开 https://example.com 并断言标题包含 Example」→ agent 驱动浏览器打开页面、读取标题、通过报告（exit 0）。
- A2：含交互意图「点击链接并断言页面出现某文本」→ 完成导航、点击、等待、断言。
- A3：反向断言「断言页面**不包含** X」→ 页面里确实没有 X 时通过（exit 0），断言以 `absent: true` 表达，报告里的断言带上「页面不包含」；页面上真有 X 时判 FAIL（exit 1）。快照过短（页面未打开）一律不通过。
- A4：`--json` 与文本报告均可输出，结构稳定、CI 可解析。
- A5：`--emit-script` 生成的脚本可被 `--replay` 零模型重跑；脚本不含 `@eN`、含语义定位符；回放报告 `mode: "replay"`、token 行为「未调用大模型」；失败时报告指出「回放第 n 步 / 对应用例第 k 步」。
- A6：下拉框与日期选择各由**一次**工具调用完成（`select_option` / `pick_date`），并各记成**一个**可回放步骤；日期范围控件由 `date` + `endDate` 一次完成「选开始 → 选结束 → 确定」。找不到浮层/面板/选项时报错并列出当前可选项，模型可退回通用路径；面板类型与参数不一致时明确报错，不产出「半截范围」这种假成功。这类控件依赖组件库类名契约（Element Plus 等），命不中时退回通用 ARIA 选择器——**不猜元素**；页面上同时存在多个同类控件时不得串位（必须命中该控件自己的浮层，且选完等浮层收起再交还控制权）。
- A7：`pageqa sessions` 起服务后，列表页列出历史运行，详情页展示传给 agent 的参数（系统提示词、模型、工具 schema、编号后的 prompt）、每轮上下文与每次工具调用的入参/结果；JSON 接口同样可用。
- A8：一次运行结束后，`~/.pageqa/sessions/sessions.sqlite` 里留下该运行的完整档案；`--no-side-outputs` 不影响它。

## 10. 约束（与不变量一致）

- 浏览器操作通过 bsk 连接真实浏览器；需先有可用 session（CLI 自动创建/复用）。
- 自然语言解析依赖 LLM（pi-agent-core + pi-ai）；默认后端为 CodeBuddy 反代（混元），无反代时不可用。
- 失败必须给出可读原因（期望值、实际值、页面证据），不得静默通过。
- 报告与退出码使工具可被 CI 直接消费。
- 回放必须零模型：`--replay` 不得调用 LLM；断言默认字符串匹配，`--semantic` 是显式例外。
- 回放不得猜元素：语义定位与 target 兜底都失败时如实报错，避免点错元素造成假通过。
- 选择类控件同样不得猜元素：候选选择器全部命不中时如实报错（并列出当前可选项），由模型退回「看快照自己点」的通用路径。
- 存档与查询服务是**旁路能力**：存档写失败不改测试结论、不计入退出码；查询服务只监听回环地址。
- 可交互元素清单（`refs` 档位）不得丢引用：任何裁剪之后，快照里解析出的 `@eN` 集合必须与原文一致（有单测钉住）。
