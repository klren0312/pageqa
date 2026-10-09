# ADR-0017：免费模型网关目录

- 状态：采纳（2026-10）
- 背景：[pi-free](https://github.com/apmantza/pi-free) 整理了一批「不花钱也能用」的 OpenAI 兼容网关（cline / llm7 / fastrouter / orcarouter / xkiro …），pageqa 的 `/model` 却只有自定义端点与 pi-ai 内置 provider——想用一个免费模型，得自己去别处查端点、再手抄进 `config.json`。而免费网关恰恰是最需要「列表里能直接看到」的一类：它们的模型目录本来就是公开的。

## 决策

### 1. 搬数据，不搬扩展
pi-free 是 **Pi CLI 的扩展**：peer 依赖 `@earendil-works/pi-coding-agent` 与 `@earendil-works/pi-ai@^0.86`（pageqa 用的是 `^1.1.0`），只导出 `./dist/index.js` 一个入口，注册走 `pi.registerProvider()` 这个宿主 API。pageqa 没有 Pi 宿主，import 它只会拉进一棵装不下的依赖树。

能复用的是它**整理出来的数据**：base URL、鉴权变量名、哪些模型真的免费。据此新建 `src/free-providers.ts`，数据取自它的 `docs/providers.md` 与 `docs/free_models.md`（2026-08-26 审计），并在文件头写明来源与快照日期。

### 2. 目录：远端优先，快照兜底
每个网关挂 `fetchModels` 打它的 `/v1/models`（公开的不要 key），基线是内置的免费模型快照。pi-ai 的动态目录是**叠加**而非替换，且刷新失败会保留原列表——因此断网、被墙、网关改目录时 `/model` 永远有内容可列，不需要第二条代码路径。

刷新时机只有两个：打开 `/model`、以及启动时选中的就是免费网关（否则配置里那个模型 id 可能还没进快照，`resolveModel` 会直接判它不存在）。两处都限时 8 秒，失败静默——「沿用快照继续用」本身就是正确行为，报错只会让用户以为功能坏了。

### 3. 免费判定：快照 ∪ 命名规律，且**逐网关显式声明**
命名规律（`:free` / `-free` 后缀、末段就是 `free`）只能覆盖「上游自己标了免费」的那部分，剩下的靠快照补。但**不给默认规律**：llm7 的 `default` / `fast` 是精选 selector，底下就是付费模型池，套一条通用规律等于把付费模型放进来。每个网关自己声明用哪一条，或声明「只认快照」。

`/model` 里出现一个用不了的付费模型没有意义——这是这批 provider 唯一需要额外照顾的地方。

### 4. 允许匿名的网关仍然出现在 `/model`
`listModelOptions` 对非 `pageqa` 的 provider 一律先 `checkAuth()`：没配鉴权就不列。这条规则对 orcarouter / xkiro 正确（没 key 确实发不出请求），但 cline / llm7 / fastrouter 的目录公开、聊天免密，按规则藏起来就等于没人知道它们存在。

因此给这三个换成自定义 `ApiKeyAuth`：存储的 key → 环境变量 → 都没有就 resolve 出一个空 key。代价是「列得出来、点下去探活失败」这种可能——那由 `probeModel` 给出可读报错承担（ADR-0006 已有这套探活），比整块 provider 消失要好。`/login` 里它们因此显示为「已登录」，与「免 key 也能用」是同一件事。

### 5. Cline 的身份头照抄上游
Cline 网关按客户端身份放行，缺头（或头是别家的）会 403。因此模型上盖 `User-Agent: Cline/4.1.10` + `X-PLATFORM` / `X-CLIENT-TYPE` / `X-Task-ID`（ULID）等头，与 pi-free 的 `providers/cline/cline-headers.ts` 同源。

pi-ai 在**每次请求时**合并模型的 `headers`，所以这里逐模型造一个新对象即可，不需要上游那套「共享可变记录 + 旋转 task id」。

代价要说清楚：这是**冒充第三方客户端身份**，与 Cline 扩展本身和 pi-free 的做法一致。哪天Cline 改了版本号或头字段，这里就会退化成 403（探活会立刻发现）。

**这是知情下接受的代价**（提请用户确认过：知道它在冒充第三方客户端，仍然保留）。因此 `CLINE_EXTENSION_VERSION` / `VS_CODE_VERSION` 是显式常量而不是随手抄来的字面量——它们是一份**声明**，上游改了就该跟着改，改完还得真的验一次。跟进动作：probeModel 的报错里若出现 403 且选的是 `cline`，先怀疑这两个常量。

### 6. 动态目录的窗口/输出上限取中间值 128k / 32k
`/v1/models` 只回模型 id，不回窗口大小，而这两个数字直接决定 pageqa 何时裁剪上下文（ADR-0014）：报小了会**过度裁剪**（长场景静默丢证据），报大了会把请求推过端点上限（场景跑到一半才 400）。

这批网关在架的免费模型（gpt-oss-120b、qwen3.5-397b、nemotron-3.5、deepseek-v4）实际窗口都在 128k 以上，因此取这个中间值：既不按 `llm.ts` 那个 32k 最小预设无谓裁剪，也不押注各家上限。

### 7. `opencode-free` 故意不做
Zen 的免费层会**指纹请求里的工具列表**：`tools[]` 必须同时含 `bash`/`edit`/`glob`/`grep`/`read` 五个小写工具名，否则 403 `FreeTierError`。pi-free 的做法是把 Pi 的 `find` 工具改名为 `glob`，再在该 provider 上临时补 `glob` + `grep`。

pageqa 的工具集是浏览器动作（navigate / click / fill / …），没有那五个里的任何一个。为了过指纹塞五个死工具，等于每轮都往模型上下文里扔它永远不会用、却看得见摸得着的假工具——代价是每一轮的质量，而收益是一个免费模型。这笔账不划算，因此不做；需要 Zen 就走 pi-ai 内置的 `opencode` / `opencode-go`（配 `OPENCODE_API_KEY`），它们已经在 `/model` 里。

（这是**明确否决**，不是「暂时没做」：将来 pi-free 或别处再把它宣传成「零成本接入的免费模型」，不必重新评估。）

### 8. 首批只收「目录公开且真有免费对话模型」的网关
kilo / anyapi / sambanova / novita / routeway / opengateway / bai / tokenrouter / agnes / venice / infron / merge / commandcode … 都要 key，先不收。

收窄的判据不是「要不要 key」而是「零配置有没有用」：cline / llm7 / fastrouter 装完立刻能用，orcarouter / xkiro 则是零成本的补充（同一个注册路径，只多一个 `anonymous` 开关）。要扩就往 `SPECS` 里加一条，机制不用改。

## 未采纳的替代方案

- **直接装 pi-free 当依赖**：宿主 API 不兼容，依赖树也装不下（决策 1）。
- **读 `~/.pi/agent/auth.json` 与 `models-store.json` 复用 Pi 的凭据**：零维护，但要用户先装 Pi CLI 并 `pi install npm:pi-free`，且格式耦合到 Pi 的内部文件。pageqa 的凭据已经有自己的落点（`~/.pageqa/auth.json`）。
- **让 `spec.freePattern` 缺省时套一条通用规律**：llm7 反例（决策 3）。
- **动态目录落盘（`ModelsStore`）**：pi-ai 支持，但快照已经承担了兜底职责，落盘只是多一份会过期的副本。
- **用 models.dev 补精确的窗口/输出上限**：方向对（pi-free 也用它），但那是另一份要跟着上游走的依赖；这一轮先取中间值（决策 6）。

## 影响

- `src/free-providers.ts`（新）：网关目录表、快照、免费判定、匿名鉴权、Cline 身份头、动态目录拉取。
- `src/models.ts`：`loadBuiltinProviders` 一并注册免费网关；新增 `refreshFreeProviders`；`ModelOption` 增 `free`。
- `src/agent.ts`：`runAgent` 与 `probeModelReachable` 在选中免费网关时刷一次目录。
- `src/tui/app.ts`：`openModelSelector` 刷新目录、`resolveInitialChoice` 刷新后再判可用性、`/model` 描述行加「免费」标记；新增 `FREE_CATALOG_TIMEOUT_MS`。
- `src/i18n.ts`：`tui.model.badgeFree`（中英双语）。
- `README.md` / `README.zh-CN.md`：新增「免费模型网关 / Free model gateways」一节与 `/model` 的免费标记说明。
- 词汇表：`CONTEXT.md` 新增「免费网关」。
- 测试：`tests/free-providers.test.mjs`（12 例）——目录表与快照、匿名/需 key 的可见性差异、`free` 标记、`/login` 呈现、动态目录补新模型并滤掉付费模型、llm7 不做命名推断、刷新失败与非 2xx 回落快照。