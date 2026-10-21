# ADR-0019：同文档导航（hash / SPA 路由）不算失败

- 状态：采纳（2026-10）
- 背景：一次真实运行（钉钉日志用例 D1/D2）在 `navigate` 上失败——不是页面打不开，而是命令报了 `timed out waiting for lifecycle "DOMContentLoaded" after 30000ms`。可那次导航的目标地址与当前页**只差一个 hash**（`…/#/system/messages/dingtalk-log`），页面实际上已经在目标路由上、表格也能正常读到。

## 根因

`bsk navigate --wait-until <任一档位>` 等的是 CDP 的 `Page.lifecycleEvent`。**同文档导航不会触发任何 lifecycle 事件**：Chromium 只换 hash，不发 `commit` / `DOMContentLoaded` / `load`。实测连 `--wait-until commit` 也是 30s 超时，而超时返回时 `location.href` 已经是目标地址、`readyState` 是 `complete`——也就是说这只等待是在等一个**不该发生**的事件，导航本身早就完成了。

对 pageqa 的后果不只是「慢 30 秒」：`navigate` 失败会让模型以为页面没打开，于是重试 navigate（再等 30 秒）、或者直接放弃后续步骤，把一条本来能通过的用例判死。

## 决策

### 1. 先预判，再等

`navigate` 执行前先读一次当前地址。若目标地址与当前页**同源 + 同 path/query**（只差 hash 或路由片段），就把 `--wait-until` 的预算从默认 30s 压到 `SAME_DOCUMENT_WAIT_MS`（1s）。

理由：这类导航付满 30s 是**必然**的，不是概率事件；而导航动作本身是瞬时的（实测拿到 timeout 的那一刻页面已经在目标地址），1s 足够覆盖慢页面的边界。

### 2. 超时后核对结果，而不是直接判失败

`navigate` 等到 lifecycle 超时后，先问一句「真的没到吗」：

1. 页面当前地址必须是目标地址（或只差 hash）——否则导航确实没到（被重定向、或根本没完成），照旧报错；
2. `document.readyState` 必须已经出了 `loading`——地址对了但还在加载不算完成。

两条都成立才改判成功，并在返回文本里说明原因。**任一条不成立就原样报错**：这层只把「已经到位却报错」扭正，不替真正的失败开脱。

### 3. 判据用 URL 结构 + 运行时观测，不猜

- 静态判据 `isSameDocumentNavigation`：同源 + 同 path/query。解析不了（`about:blank` 这类）退回「去 hash 后字符相等」，而不是直接判否——宁可多压一次短超时，也别把能用的导航判死。
- 运行时判据 `readPageLocation`：读 `location.href` 与 `readyState`，只读、不改页面。读不到就当核对没做（按原样报错）。
- `canonicalUrl` 只归一一处：空 hash 与 `#/` 视为同一个地址（SPA 首页最常见）。多做一步「猜意图」就会把真失败的地址判成命中。

### 4. 不做「同文档就跳过 navigate 命令」

可以让模型自己去改 hash，但那要求模型知道这件事、并且每次都用对——等于把浏览器语义推给提示词。改在工具层处理，所有路径（录制、回放、IPC 快路径、CLI 子进程）一次到位。

## 后果

- 同文档导航从「30s 白等 + 判死用例」变成「1s、成功、返回文本里说明原因」；
- 真失败（端口没起、主机不可达、被重定向）的行为完全不变（单测与真机都钉住了）；
- 首次真导航（有文档加载）仍走默认预算，不受影响。

验证：`tests/bsk/bsk-navigate-same-document.test.mjs`（9 项，两条判据的正反两个方向），以及真机复验——同文档切换 30s → 1s，`http://127.0.0.1:59999/nope` 仍正确报 `ERR_CONNECTION_REFUSED`。
