# ADR-0016：模型请求的代理路由

- 状态：采纳（2026-10）
- 背景：模型端点（以及 Jev 这类对外 API）在部分网络下直连不通，而 `127.0.0.1` 上的自定义端点、bsk daemon **必须**直连。此前没有任何出口配置，唯一的办法是在 shell 里设 `HTTP_PROXY`/`HTTPS_PROXY`——但 Node 的 fetch 根本不读这两个变量，于是用户要么完全没代理、要么只能改代码换端点地址。

## 决策

### 1. 按域名路由，三种动作：direct / proxy / fallback
规则自上而下匹配，第一条命中者胜；都没命中用全局 `mode`。`fallback` 是「先直连，遇到**网络层**错误再走代理重试一次」——只认网络错误（`ECONNREFUSED`/`ENOTFOUND`/超时…，沿 `cause` 链找），4xx/5xx 与其它异常原样抛出。

理由：模型端点不通的表现是「连不上」，不是「回来说不行」。把这两类混在一起会把一次 401 变成一次重试加一次代理绕路，既慢又把真正的原因藏起来。

代价：直连失败的请求会多花一次连接代理的时间。代理地址不存在时是 `ECONNREFUSED`（毫秒级），代理存在但不通时才会真的等一次连接超时。

### 2. 装配点只有一个：替换 `globalThis.fetch`
pi-ai 在**每次请求时**才构造 SDK 客户端，客户端默认取当时的 `globalThis.fetch`（`openai` / `anthropic` SDK 都是如此），因此 `installProxyRouting()` 一次替换就同时覆盖自定义端点与内置 provider（anthropic / openai / deepseek …）。自定义端点**不**再单独注入 fetch。

理由：两个入口各代理一次会让统计翻倍、fallback 套一层代理，而这种失真是静默的。`tests/proxy.test.mjs` 里那条端到端用例守的就是这个假设——pi-ai 哪天改成缓存客户端，症状只会是「代理配了没反应」。

装配必须早于任何一次请求：CLI 放在 `main()` 开头，`setDebug` 一并提前（否则「代理现状」那行 debug 日志永远打不出来）。套件的每个子进程都是 CLI 自己（ADR-0013），因此自动生效。

### 3. 走代理时用 undici 自己的 fetch，直连仍用 Node 原生 fetch
外部 undici 的 `ProxyAgent` 不能塞给 Node 内置的 fetch：内置 fetch 用的是 Node 自带的那份 undici，两份的请求处理接口跨大版本并不兼容（实测报 `InvalidArgumentError: invalid onRequestStart method`，且不会退化成「连不上」而是直接抛）。因此 `proxiedFetch` 取自 undici 包，与 `ProxyAgent` 出自同一份 undici，必然配套。

直连路径刻意不换实现：那条路径没有任何理由把 Node 原生 fetch 换成外部 undici。

代价：走代理的响应是 undici 的 `Response` 而非内置的那份。SDK 侧是鸭子类型，实测流式响应（SSE）解析正常。

### 4. 配置文件独立：`~/.pageqa/proxy.json`
不写进 `config.json`。理由：代理是**网络环境**问题，与「跑哪些用例、报告要不要 HTML」那类持久化偏好无关；混在一起会让 `--init-config` 打印的模型配置里混进一条 proxy。

读取不产生磁盘副作用（与 `config.ts` 的 `readRawConfig` 同一口径）；`--init-config` 才写模板。

### 5. 默认就装两条规则，且默认 enabled
默认规则是「本机与内网 `direct`，其余 `fallback`」，默认代理地址 `http://127.0.0.1:7890`。

理由：本机端点被塞进代理是「配了代理反而跑不起来」的头号原因（症状是连上了但不回话），而墙外的模型端点需要它。`fallback` 让「直连能通就零开销」，所以零配置的唯一行为变化是「失败的直连会多试一次代理」。想彻底关掉有两条明路：`"enabled": false` 或 `PAGEQA_PROXY_ENABLED=false`。

### 6. 规则三种情形要分清
- 没写 `rules`（或不是数组）→ 用默认规则；
- 显式 `"rules": []` → 就是「不设任何规则，全部按 `mode`」（「所有请求都走代理」只能这样表达）；
- 写了非空数组但一条都不合法 → 退回默认规则。

最后一条是刻意的：把 `"action": "PROXY"` 这种拼写错误静默当成「无规则」，会让**所有**请求悄悄改道——而用户以为配好了。

模式里的 `*` 是**任意位置**的通配（`172.2*` 覆盖 172.20–172.29）。只认「`*.` 前缀 / `.*` 后缀」两种写法时，内网网段只能列一长串——写错一个数字就静默失效，而规则本身没有任何报错。IPv6 主机的 `URL.hostname` 带方括号（`[::1]`），判断前剥掉，否则 `::1` 这条规则永远不命中。

### 7. `/proxy` 面板：开关落盘，临时直连不落盘
面板四项：启用/关闭（写回 `proxy.json`）、本次会话先全部直连（**不写盘**）、重新加载配置、查看统计与规则。

理由与 ADR-0011 的 `/setting` 同源但不同结论：代理开关是「下次启动仍要这样」，因此落盘；而「本次先直连」针对的是「这台机器此刻的网络」，存成默认值等于替用户把下一次的运行也关掉。

面板在环境变量在场时补一条提示（`tui.proxy.envOverride`），与 ADR-0015 决策三同理：env 优先级更高，不点破就会出现「我改了怎么没变」。

### 8. 不引入 `HTTPS_PROXY` 等标准环境变量
只认 `PAGEQA_PROXY_URL` / `PAGEQA_PROXY_ENABLED` / `PAGEQA_PROXY_MODE`。想要沿用 shell 里的变量就显式传：`PAGEQA_PROXY_URL=$HTTPS_PROXY pageqa 用例.md`。

理由：自动认领标准变量意味着「公司环境里恰好设了 `HTTPS_PROXY`」会静默改变每一次运行的出口。这类不可预期的默认值比多敲一次命令贵得多。

## 未采纳的替代方案

- **只给自定义端点注入 fetch**：内置 provider（`/login` 之后可用）就漏了，而漏掉的那部分恰好是最需要代理的（anthropic/openai 在墙内直连不通）。
- **给 pi-ai 传标准 `HTTPS_PROXY`**：pi-ai 的 `fetch` 注入位是**每次请求**的参数（`ProviderRequestOptions`），不是 provider 创建时的选项——要么在每个调用点传（agent.ts / models.ts 各一处，以后还会漏），要么不传。
- **降级 undici 到与内置 fetch 同大版本**（如 undici 7）：把正确性押在「用户跑的 Node 内置 undici 版本恰好与依赖匹配」上。Node 22 与 24 内置的版本就不同。
- **用 `NODE_USE_ENV_PROXY=1`（Node 24+）**：全局按环境变量代理，无法按域名规则，本机端点会被一起代理掉；且低于项目 engines 要求的 Node 版本没有这个开关。

## 影响

- `src/proxy.ts`（新）：配置解析、规则匹配、`isNetworkError`、带路由的 fetch、全局装配、统计与面板所需的运行期开关。
- `src/index.ts`：`main()` 开头 `setDebug` + `installProxyRouting` + `reportProxyRouting`（仅 `--debug` 打印）；`--init-config` 多打印一段代理配置。
- `src/tui/app.ts`：`/proxy` 面板与命令，补全项与文件头注释。
- `src/i18n.ts`：`tui.proxy.*`、`tui.cmd.proxy`、`log.proxyOn` / `log.proxyOff`、`config.proxyCreated` / `config.proxyExists`；`help.full` / `tui.help` / `tui.unknownCmd`（中英双语）补上 `/proxy` 与代理说明。
- `src/llm.ts`：**不**注入 fetch，注释改为说明「只留一个装配点」的理由。
- `package.json`：新增依赖 `undici`。
- 词汇表：`CONTEXT.md` 新增「代理路由」与「代理规则」。
- 测试：`tests/proxy.test.mjs`（21 例）——规则匹配、错误识别、配置优先级、fetch 行为、全局装配，以及一条端到端用例（假代理冒充 OpenAI 兼容端点，断言探活请求到达代理且流式响应解析正常）。
