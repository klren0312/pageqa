# ADR-0018：元素类条件等待交给 `bsk wait-for-element`，文本条件仍走页面侧探针

- 状态：采纳（2026-10）
- 背景：`wait_for` 一直是「注入 `evaluate` 探针 + pageqa 外层轮询」实现的（见 `src/bsk/condition.ts` 文件头）。这条路线的代价写在同一处：**后台标签页的定时器会被节流到 1s 以上**，所以刻意不写「页面内 `await Promise`」，改成每次问一个同步问题、由 pageqa 自己轮询。代价换来的是「每个轮询间隔一次 IPC 往返」——10 秒等待就是几十次往返。

上游 bsk 已随 0.3.3 发布 `bsk wait-for-element`（`tool.wait_for_element`）：一次 RPC 等满整个上限，轮询在扩展内部完成，不受页面定时器节流影响；状态语义是 `visible` / `hidden` / `attached` / `detached`，超时不是错误（退出码 0，结果里带 `satisfied` 与 `attached`/`visible` 证据）。

## 决策

### 1. 元素类条件走原生，文本条件仍走探针

- `selector` / `gone` 交给 `bsk wait-for-element`；
- `text`（等页面出现某段可见文本）bsk 表达不了（它只认 ref / CSS 选择器），继续走页面侧探针。

这不是「过渡状态」而是终态：把文本条件翻译成选择器需要猜 DOM 结构，正是本仓库一贯拒绝的「猜元素」。

### 2. `gone` 归一成 `hidden`，不是 `detached`

`gone` 原来的实现只看 `querySelector` 是否命中，也就是「不在 DOM」。换成 bsk 后按 `hidden` 等：**元素被移除、或被 `v-show` / `display:none` 隐藏都算满足**。

理由是实测痛点：Element UI 的 loading 遮罩用 `v-show` 隐藏（`Loading.service` 才移除），按「不在 DOM」等会一直等到超时——而这正是 `gone` 这个条件被发明出来的那个场景。要严格等「离开 DOM」的调用方可以显式写 `state: "detached"`（本次新增参数）。

### 3. 顺带把 `attached` / `visible` 暴露给模型（新增可选参数 `state`）

超时报告的价值全在「为什么没等到」：「还在树里但没显形」和「压根没出现过」是两种不同的 bug。因此 `wait_for` 新增可选 `state`（只配合 `selector`），并在超时文案里给出**末次探测**的证据（`末次探测：还在 DOM=true，可见=false`）。

`state` 只接受四个值，且只能配 `selector`：配在 `text` 上无意义，配在 `gone` 上重复（`gone` 就是 `hidden`）。这两种误用都在**本地**报错，不消耗一次浏览器往返，也不进回放脚本。

### 4. 两套实现，一套语义（降级路径必须同结论）

旧版 bsk 没有这条命令，pageqa 必须能继续跑：

- 触发降级的形状**只认两种**：IPC 的 `unknown_method`、以及 clap 那句 `unexpected argument '--state'` / `unrecognized subcommand`。其余失败（CDP 断了、ref 失效）一律上抛——把真故障当成「旧版本」静默退回探针，会把一次失败拖成一次慢；
- 降级只在**本进程内**记一次（`nativeWaitUsable`），旧版本不会在进程跑着的时候变新；
- 降级后**结论必须与原生一致**。为此 `probeSaysMaybe` 的状态矩阵与 bsk 的 `ElementState::satisfied_by(attached, visible)` 逐条对齐（单测用 3×4 矩阵钉死），探针里的可见性判定也抄 bsk 的口径（`checkVisibility` + 非零盒子 + computed style 兜底）。超时证据的措辞两边共用同一句（`末次探测：还在 DOM=…，可见=…`）——同一个条件在旧版与新版上说两种话，会让人以为是两回事。

### 5. 走 IPC 快路径，并保留一个强制降级的开关

`wait-for-element` 加进 `ipc-commands.ts` 的翻译表（`tool.wait_for_element`），参数与 CLI 逐字对齐；渲染行照抄 `cli/waits.rs` 的 human 输出（`wait-for-element ok tab=… target=… state=… satisfied=… attached=… visible=… elapsed_ms=…`），两条路径的文本一致。它归为「改动型」：等待不改页面，但它存在的意义就是「等到页面变了」，请求已发出后出错不能重发。

`PAGEQA_BSK_WAIT_FOR_ELEMENT=0`（同 `PAGEQA_BSK_IPC` 的风格）强制走探针。这条开关是为验证而加的：降级路径平时跑不到（本机 bsk 已有该命令），而它恰恰是最需要真机验证的一条。

> 一个反面教材：验证脚本初版用「放在 PATH 前面的 `bsk.cmd` 假包装」来模拟旧版，结果**根本没有被命中**——Windows 上 `execFile` 只按 CreateProcess 的规则解析 `.exe`，`.cmd` / `.bat` 不在解析范围内。于是它跑的还是真的 bsk，「降级通过」是假的。改用产品自带开关后才发现。凡是「模拟一个不存在的环境」的验证，必须先证明这个模拟真的生效。

### 6. 回放格式：只加一个可选字段，不升版本号

`ReplayWaitForStep` 新增可选 `state`，与 `wait_for` 当初的处理同一条规则：加载时逐步校验，缺省即 `visible`（与旧脚本录制当时的行为一致），所以旧脚本不需要重录、也不升 `REPLAY_VERSION`。手工改坏的脚本（`state` 不合法，或配在 `text`/`gone` 上）在**加载时**就拒掉，而不是回放中途静默丢掉这个意图。

## 后果

- 元素类条件等待的往返次数从「每个轮询间隔一次」降到「一次」，且不再依赖页面定时器；
- 文本条件仍是老路径，`settle.ts`（页面稳定检测）保持自研——它等的是「网络与渲染都安静」，单元素状态表达不了；
- `gone` 的语义变宽（隐藏也算消失），这是**有意的行为变更**，已在工具描述里写明，并给了 `state: "detached"` 作为严格替代；
- 真机验证：`scripts/verify-wait-for-element.mjs`（11 项，含原生路径、探针降级路径、证据措辞一致性）。
