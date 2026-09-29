# bsk 能力复用评估（可优化项与缺口）

- 状态：调研结论（2026-09），**尚未落地任何一项**
- 目的：清点 browserskill（`bsk`）已提供、而 pageqa 尚未使用的能力，判断哪些可以直接接上提升测试覆盖面与执行效率，哪些需要向上游提需求。
- 参照对象：
  - pageqa 本体：本仓库（`src/`）
  - bsk：`D:\1project\BrowserSkill`（外部依赖，Tencent/BrowserSkill）。本文引用的 bsk 路径均相对该仓库根。
- 阅读方式：bsk 侧为 `crates/bsk-cli/src/cli/`（命令实现）、`crates/bsk-protocol/src/`（RPC 方法与参数）、`crates/bsk-cli/skill/references/`（面向 Agent 的用法说明）；pageqa 侧为 `src/bsk/`（bsk 接入层）与录制/回放链路。

> 文中的 bsk 行号为撰写时工作区的读取位置，随 bsk 版本升级可能漂移；**命令名、参数名与 `--json` 字段名才是稳定依据**。

---

## 一、结论速览

1. **bsk 有相当一批现成能力 pageqa 完全没接**，其中 `press`（键盘）、`console`/`network`（诊断读）、`screenshot`/`get-html`（证据读）属于明显缺口，接上即为纯收益。
2. **有一项是「数据已经拿到却被丢弃」**：bsk 每次交互的结果都带原生对话框信息（`dialogs[]`），pageqa 走 human 模式、成功路径只读 stdout，而 dialogs 打在 stderr，导致 `alert`/`confirm`/`prompt` 在报告里毫无痕迹（全仓搜索 `dialogs` 零匹配）。
3. **不建议**用 bsk 命令替换 pageqa 自建的 `picker.ts` / `condition.ts` / `settle.ts`。这三者不是「重复实现 bsk 已有能力」，而是「把多个 bsk 原子操作收敛成一次调用」，替换反而会丢掉性能与防错收益。
4. **值得向上游提的需求只有一条**：元素级条件等待（`wait-for-selector` / `wait-for-function`）。这是 pageqa 不得不在页面侧用 `evaluate` 轮询自建 `wait_for` / 页面稳定检测的根因，且 bsk 在扩展侧实现能绕开后台标签页定时器节流。
5. **结构性效率优化**集中在 `--json` 与 IPC 快路径两处：前者是透传 dialogs 的卡点，后者只覆盖 7 个命令，其余每条都要付 13–20ms 的子进程开销。

---

## 二、现状：bsk 命令全集 vs pageqa 已用

bsk 的命令枚举在 `crates/bsk-cli/src/cli/mod.rs`（`enum Command`，约 108–232 行）。

### 2.1 pageqa 已用

| 命令 | 在 pageqa 里的角色 |
| --- | --- |
| `navigate` | `navigate` 工具；失败时经 `navigate-diagnosis.ts` 翻译成可读原因 |
| `snapshot` | `snapshot` 工具 + 自研瘦身（`snapshot.ts`）+ 语义定位符解析（`locator.ts`） |
| `click` / `fill` / `hover` / `scroll-to` | 对应四个工具，动作前走「引用闸门」`checkRef` |
| `upload` / `download` | `upload` 工具；`download` 工具兼作一条断言（ADR-0012） |
| `wait-ms` | `wait` 工具 |
| `evaluate` | **内部载体**：`settle`（页面稳定）、`wait_for`（条件等待）、`select_option`、`pick_date` 全部靠注入 JS 实现 |
| `session start` / `stop` / `list` | 场景生命周期（ADR-0013：一场景一 session 一进程） |
| `status` | `ensureBskReady()` 的 daemon 探测与浏览器连接校验 |
| `daemon start` | 未运行时后台拉起（`detached` + 轮询） |

### 2.2 bsk 提供、pageqa 未用

按对**页面测试**的价值排序：

| 优先级 | 命令 | 用途 | 关键参数 | `--json` 关键字段 | bsk 证据位置 |
| --- | --- | --- | --- | --- | --- |
| **P0** | `press <key>` | 键盘按键/组合键/长按。回车触发搜索与提交、`Esc` 关弹窗、`Tab` 走焦点顺序、`Ctrl+A` 全选 | `--modifiers --ref --selector --hold-ms --session` | `tab_id,key,code,modifiers[],dialogs` | `cli/interaction.rs`（约 491–577） |
| **P0** | ——（无独立命令） | **原生对话框回传**：每个交互类 tool 的结果都带 `dialogs[]`（`alert`/`confirm`/`prompt`/`beforeunload` 的 `type`/`message`/`handled`/`default_prompt`/`sequence`）；human 模式打到 **stderr** | 随结果返回 | 随各结果返回 `dialogs` | `crates/bsk-protocol/src/tools/dialog.rs`；`cli/dialogs.rs` |
| **P0** | `console` | 读控制台/日志/异常缓冲，含异常栈。可断言「页面无 JS 异常」 | `--since --limit --max-text-chars --include-stack` | `entries[{sequence,kind,level,text,url,line,column,stack_trace[]}],next_since,truncated` | `cli/console.rs`（约 14–131） |
| **P1** | `network` | 读网络响应/失败缓冲。可断言接口 `status`、抓 `net::ERR_*` | `--since --limit --max-text-chars` | `entries[{sequence,kind,method,url,status,error_text,...}],next_since` | `cli/network.rs`（约 14–106） |
| **P1** | `screenshot` | 视口/元素/整页 PNG。失败现场的可视化证据 | `--ref --full-page --scope{follow\|current} --out --timeout` | `tab_id,width,height,format,path,byte_size[,capture_unavailable]` | `cli/screenshot.rs`（约 25–176） |
| **P1** | `get-html` | 导出原始 DOM（可 `--ref` 限定子树）。精确 DOM 断言的权威来源 | `--ref --max-bytes(默认 512KiB) --out` | `html,truncated,byte_size,tab_id` | `cli/get_html.rs`（约 19–96） |
| **P1** | `wheel` | 真实滚轮增量（有符号）。触发无限滚动加载、横向滚动 | `--ref --selector --delta-x --delta-y --modifiers` | `tab_id,x,y,delta_x,delta_y` | `cli/wheel.rs`（约 16–93） |
| **P2** | `select` | 设置原生 `<select>`（支持多选，按 `value` 属性） | `--value`（可重复）`--ref --selector` | `multiple,selected_values[],selected_labels[]` | `cli/interaction.rs`（约 583–652） |
| **P2** | `emulate` | 设备/视口/UA/触摸模拟，7 个内置预设（`iphone-14`、`pixel-7`、`ipad-mini` 等），`--off` 还原 | `--device --width --height --dpr --mobile --ua --touch --off` | `cleared,applied{width,height,device_scale_factor,mobile,user_agent,touch,...}` | `cli/emulate.rs`（约 118–413） |
| **P2** | `focus` / `blur` | 聚焦 / 移除焦点。断言 `:focus` 样式、触发 blur 校验 | `--ref --selector` | `focused` / `was_focused,focused` | `cli/interaction.rs`（约 295–407） |
| **P2** | `tab list/create/close/select/borrow/return` | 多标签页：断言「点链接开了新标签」、跨标签流程、借用用户已有标签页 | list `--scope{user\|agent\|all}`；create `--url --no-active --index` | list `tabs[{tab_id,title,url,window_id,active,scope}]` | `cli/tab.rs`（约 21–370） |
| **P2** | `wait-for-navigation` | 等页面生命周期事件（`load`/`domcontentloaded`/`networkidle`/`commit`） | `--wait-until --timeout` | `tab_id,reached,error_text` | `cli/waits.rs`（约 25–93） |
| **P2** | `navigate-back` / `navigate-forward` / `reload` | 浏览器历史与刷新 | `--session --tab-id` | 同 `navigate` | `cli/mod.rs`（约 171–179） |
| **P3** | `observe` | 语义 VOM 结构化观察，带 `next_cursor` 续读与 `--probe-hover`（主动悬停揭示 hover-only 菜单） | `--cursor --max-depth --max-tokens --probe-hover` | `next_cursor,text,ref_count,truncated,hover_probe` | `cli/observe.rs`（约 15–95） |
| **P3** | `request-help` | 请人工完成登录/验证码/OTP/支付确认，带 `completion_criteria`（正则） | `--prompt --title --target --timeout(默认 5m) --completion-criteria` | `outcome{continued\|cancelled\|timed_out\|completed},resolved_targets[]` | `cli/human_loop.rs`（约 29–144） |
| **P3** | `record start/stop` | 把人工操作录成 `trace.json` 教材，可反向生成用例初稿 | `--url --purpose --output --redact-values` | `output,trace_json,trace_version,states_dir` | `cli/record.rs`（约 49–376） |
| **P3** | `window resize` | 调整 Agent Window 尺寸 | `--width --height` | `window_id,width,height` | `cli/window.rs`（约 26–84） |
| **P3** | `debug <action>` | 站点调试：请求/响应正文、规则 mock、重放、性能指标（FCP/LCP/CLS）、疑似重复请求 | 见 `debug.rs` 的 action 列表 | `DebugResult{...}`（始终 JSON） | `cli/debug.rs`（约 12–311） |
| **P3** | `browsers` / `logs` / `doctor` | 运维排查：列已连接实例、读 daemon 日志、诊断与修复提示 | —— | `browsers` 返回实例数组 | `cli/browsers.rs`、`cli/logs.rs`、`cli/doctor.rs` |

> **`observe` 不建议用来替换 `snapshot`**：`snapshot`（aria 树）与 `observe`（语义 VOM）输出不同，而 pageqa 的 `locator.ts` / `snapshot.ts` 与 snapshot 文本格式深度耦合（`@eN` 行正则、`role "name"` 引号结构、缩进层级、折叠加标记）。替换会静默破坏录制/回放的整条定位链。`observe` 的价值只在 `--probe-hover` 这一项（见 3.3）。

---

## 三、可优化项

### 3.1 P0 — 直接接上即有收益

**（1）`press` 键盘工具**

pageqa 目前**没有任何键盘能力**。真实用例里高频出现：回车触发搜索或提交、`Esc` 关闭弹窗/抽屉、`Tab` 走焦点顺序验证校验、`Ctrl+A` 后重填。现在只能靠 `evaluate` 注入合成 `KeyboardEvent`，而合成事件在多数前端框架（Element Plus / React 受控组件）里与真实按键行为不一致——这是「用例明明该通过却报失败」的一个常见来源。

**（2）原生对话框（`dialogs[]`）透传**

bsk 每一次交互的返回都带 `dialogs[]`，但：

- pageqa 走 CLI human 模式，dialogs 被 bsk 打到 **stderr**；
- `runBsk()` 只在**失败**分支读 stderr（`src/bsk/tools.ts`）；
- 成功路径只取 stdout。

结果：页面弹了 `confirm`，报告里没有任何记录。搜索结果证实 `src/` 下 `dialogs` **零匹配**。修复方向有两条：在 IPC 路径上直接读 daemon result 的 `dialogs` 字段（本就在返回值里，零额外成本），或让交互命令走 `--json`。

**（3）`console` → 断言「无 JS 异常」**

页面测试最有价值的检查之一。bsk 直接给出 `kind=exception` 与 `stack_trace[]`，做成与 `download` 同形的断言工具（产出 `AssertOutcome`）即可进 `assertions`、进三种报告、影响退出码。

### 3.2 P1 — 补齐证据链

**（4）`network` → 断言接口状态**

断言 `status=200`、抓失败原因（`net::ERR_*`）。与 `console` 同一形态，建议一并实现。

**（5）`screenshot` → 失败现场可视化**

目前报告（文本 / JSON / HTML）全是文字。给失败场景附一张截图（`--full-page` 或失败当时的视口），能省掉大半排查时间。改动含 `report-html.ts` 的嵌图。

**（6）`get-html` → 精确断言兜底**

`snapshot.ts` 的瘦身会**截断长文本行、整行省略非关键文本**，`assert_text` 已经因此专门绕开瘦身文本（`ensureRawSnapshot`）。当断言对象落在被截断区间、或需要断言属性/结构而非可见文本时，`get-html --ref` 是权威来源。

**（7）`wheel` → 真实的滚动事件**

pageqa 只有 `scroll-to`，它把元素滚进视口但**不产生滚动事件**。无限滚动加载（滚到底部触发加载下一页）必须用真实滚轮增量才能触发。

### 3.3 P2/P3 — 覆盖面扩展

- **`select`**：原生 `<select>` 用 bsk 的「按 `value` 设置 + 支持多选」比 pageqa 的 `select_option`（为 Element Plus 浮层设计）更直接。
- **`emulate --device`**：移动端响应式测试，7 个内置预设。
- **`focus` / `blur`**：表单必填校验常在 blur 触发；`:focus` 样式断言。
- **`tab` 管理**：断言「点链接开了新标签页」。
- **`observe --probe-hover`**：现在「hover → snapshot」要两轮，一轮可出结果（但仅此一项值得用，见 2.2 的说明）。
- **`request-help`**：pageqa 自称能跑十几分钟的长流程，但卡在登录/验证码就整条报废。
- **`record`**：人工操作录成 `trace.json`，可反向喂出用例初稿。
- **`navigate-back` / `forward` / `reload`**：浏览器历史按钮测试。
- **`wait-for-navigation`**：比 `evaluate` 轮询更权威的导航完成等待。

---

## 四、结构性效率优化

### 4.1 IPC 快路径覆盖面太窄

`planIpcCall`（`src/bsk/ipc-commands.ts`）目前只翻译 **7 个命令**：`snapshot` / `click` / `hover` / `scroll-to` / `fill` / `evaluate` / `wait-ms`。其余全部退回 CLI 子进程。

代价（见该文件头部注释与 `tools.ts` 的 `bsk()` 说明）：

- 子进程：起进程 + 连管道 + daemon 探测，实测 **13–20ms/条**；
- 常驻 IPC 连接往返：**0–1ms**。

一条 30 步的用例按每条多付 15ms 计，约多花 0.5s；轮询类命令（回放的定位轮询、`wait_for`）放大得更明显。**上面每个新增工具都应顺手加进 `planIpcCall`**，其中 `press` / `focus` / `blur` / `select` 的结果形状极简（`tab_id` + `used_ref` + 一个字段），翻译成本最低。

### 4.2 `--json` 被硬拒绝，是透传 dialogs 的卡点

`REJECTED_FLAGS` 显式拒绝 `json`（`src/bsk/ipc-commands.ts`），一旦出现 `--json` 就整条退回 CLI。而 dialogs 的权威来源正是结构化结果。

建议：**不要**为透传 dialogs 开放整条 `--json` 通道（那会同时失去 IPC 快路径与逐字节一致性保证）；而是在 IPC 路径上按需读取 daemon result 的 `dialogs` 字段并在 `render` 里补一行人类可读文本。

### 4.3 两个小项

- `session stop --all`：收尾兜底，避免硬杀场景留下孤儿窗口。
- `snapshot --max-tokens`：作为自研瘦身之外的二次保险——瘦身失效的长页面上，让 bsk 自己截断比让模型吃下整页更安全。

---

## 五、建议向上游（bsk）新增的能力

只有第一条值得提 PR，其余两条优先级低。

### 5.1 元素级条件等待（推荐）

bsk 的等待能力只有：

- `wait-for-navigation`：页面生命周期（`load`/`domcontentloaded`/`networkidle`/`commit`）；
- `wait-ms`：daemon 侧睡眠。

**没有**「等到某选择器出现 / 可见 / 消失」这类条件等待。这正是 pageqa 不得不自建 `condition.ts`（`wait_for`）与 `settle.ts`（页面稳定检测）的根因，且 pageqa 的实现有明确记录的代价——`settle.ts` 文件头写明：**后台标签页的定时器被节流到 1s 以上**，所以刻意采用「同步探针 + 外层轮询 `evaluate`」而不是页面内 `await Promise`。

若 bsk 在**扩展侧**实现条件等待，扩展不受页面定时器节流影响，且能复用 bsk 自己的可见性/可点性判定（比注入 JS 更权威）。届时 pageqa 可以直接删掉两个模块的轮询逻辑。这是双方都受益的改动。

### 5.2 按可见文本选择 / 日期选择原生命令（低优先级）

bsk 的 `select` 按 `value` 属性工作，而 Element Plus 这类组件需要按**可见文本**匹配、还要翻月选日，于是 pageqa 用 `picker.ts` 注入 JS 实现 `select_option` / `pick_date`。若 bsk 在扩展侧提供等价命令（能复用 bsk 的可见性检查），会比注入 JS 更稳。

### 5.3 对话框处理策略（低优先级）

现在 bsk 自动 accept/dismiss，Agent 没有「先不处理、等我看清内容再决定」的选项。加一个 `--on-dialog {accept|dismiss|leave}` 才能真正测试对话框本身。

---

## 六、不要动的部分（风险清单）

pageqa 与 bsk 存在多处**逐字节 / 强格式**耦合，扩展 bsk 能力时务必绕开：

1. `ipc-commands.ts` 的 `render` **逐字复刻 CLI human 输出**，并依赖 daemon result 字段名（`text` / `used_ref` / `used_selector` / `tab_id` / `value_length` / `waited_ms` / `x,y,width,height`）。字段改名会让 `badShape()` 抛**传输**错误，而**改动型命令因此不回退**（`tools.ts` 的 `runBskCommand`）。
2. `ERROR_COPY` 复刻 bsk `cli/render_error.rs` 的文案表；判定依据是 `code`，文案漂移只影响措辞。
3. 协议漂移只认 `unknown_method`（`isProtocolDrift`）；若 bsk 换码表示「不认识的方法」，会漏判成真实错误。
4. `locator.ts` / `snapshot.ts` 与 snapshot 文本格式强耦合（`@eN` 行、`role "name"`、缩进层级、meta 行前缀、折叠加标记）。两者必须用同一套判定，bsk 改快照格式会**静默**破坏定位与瘦身。
5. 瘦身与定位的常量耦合：`ANCESTOR_NAME_MAX`(120) 必须大于 `PATH_NAME_MAX`(60)，路径比较才一致（`snapshot.ts`）。
6. `evaluate` 的退出码假设：`ok=false` 时 stdout 空、退出码仍为 0（照抄 bsk `cli/evaluate.rs` 的策略）。
7. daemon 单连接严格串行假设（`ipc.ts` 文件头）——若 bsk 改为并行处理，按-session 的连接复用模型需重审。

---

## 七、落地路线与改动面

### 7.1 新增一个 bsk 工具需要改的位置

| 档位 | 文件 | 位置 |
| --- | --- | --- |
| 工具本体（必改） | `src/bsk/tools.ts` | `interface BskOps`（操作层接口）、`createBskOps()` 内新增方法并暴露、新增 `AgentTool` 常量、加入 `createBskTools()` 的返回数组 |
| 系统提示 | `src/agent.ts` | `DEFAULT_SYSTEM_PROMPT` 的工具清单（只写「何时用谁」，完整规则放工具 schema 描述，避免两处重复付费）；工具装配处**会自动纳入，无需改** |
| 录制 | `src/record.ts` | `Recorder.noteTool()` 加 `case` |
| 回放 | `src/replay.ts` | `ReplayStep` union、`REPLAY_STEP_KINDS`、`runStep` switch（按需升 `REPLAY_VERSION`） |
| IPC 快路径（可选） | `src/bsk/ipc-commands.ts` | `planIpcCall()` 加 `case`；新参数需放入 `VALUE_FLAGS` / `BOOL_FLAGS` 白名单；`render` 必须与 CLI 输出逐字一致 |
| 文案 | `src/i18n.ts` | `bsk.*` 文案（zh/en 各一份） |
| 页面侧注入（仅当需要） | `src/bsk/picker.ts` / `condition.ts` / `settle.ts` | —— |

### 7.2 建议顺序

| 阶段 | 内容 | 说明 |
| --- | --- | --- |
| 1 | `press` 工具 + `dialogs` 透传 | 工程量最小、收益最直接，且能立刻被录制/回放覆盖 |
| 2 | `assert_no_console_error` / `assert_network` | 需按 `download` 的模式产出 `AssertOutcome` 才会进报告 |
| 3 | `screenshot` + HTML 报告嵌图 | 失败现场证据 |
| 4 | `wheel` / `focus` / `blur` / `select` / `get-html` + 扩展 IPC 快路径 | 覆盖面扩展 |
| 5 | 向上游提 `wait-for` 条件等待 PR | 落地后可回收 `condition.ts` / `settle.ts` 的轮询逻辑 |

---

## 附：查证记录

- pageqa 侧全仓搜索 `dialogs`：**0 匹配**（`src/`）。
- `planIpcCall` 覆盖范围：`src/bsk/ipc-commands.ts` 的 `switch (command)` 共 7 个 case。
- `REJECTED_FLAGS` 含 `json`：`src/bsk/ipc-commands.ts`。
- bsk 命令枚举：`crates/bsk-cli/src/cli/mod.rs` 的 `enum Command`。
- bsk 错误码常量（13 个）与 `data.reason` 细分码：`crates/bsk-protocol/src/error.rs`、`crates/bsk-cli/src/cli/render_error.rs`。
- bsk RPC 方法全集与副作用分类：`crates/bsk-protocol/src/method.rs`。
