# ADR-0004：交互模式的模型切换与登录

- 状态：采纳（2026-09）
- 背景：用户希望 `pageqa --tui` 能像 pi-coding-agent 那样，在交互界面里切换模型、登录内置 provider，而不必退出终端改 `config.json` 或敲环境变量。
- 范围：仅交互模式（`tui/app.ts`）的 `/model`、`/login`、`/logout` 命令与底层模型目录（`models.ts`）、凭据存储（`auth.ts`）。批处理/管道模式行为不变。

## 决策

### 1. 模型选择走「模型目录」，不复刻一棵树
`models.ts` 的 `createModelCatalog()` 直接复用 pi-ai 的 `createModels`（它持有内置 provider 注册表与 `auth.json` 之外的全部逻辑），而不是自己维护一份模型清单。这样新增内置 provider 时无需改 pageqa。`createModels` 的 `credentials` 注入 pageqa 自带的 `FileCredentialStore`（`~/.pageqa/auth.json`），`authContext` 提供 `configDir` 让 pi-ai 把授权文件落在 pageqa 的配置目录而非 pi-coding-agent 的目录。

### 2. 自定义端点是「零加载成本」的一等公民
`createModelCatalog()` 默认 `loadBuiltins: false`，只注册 `pageqa`（自定义 OpenAI 兼容端点，来自 `config.json` 的 `baseUrl`/`apiKey`/`model`）。内置 provider 那棵依赖树（openai/anthropic sdk 等）只在两种情况下才 `loadBuiltinProviders()`：
- `/login` 或 `/model` 需要列出它们；
- 用户用 `config.json` 的 `modelProvider` 指向某个内置 provider 作为启动默认。

理由：内置 provider 的注册涉及动态 `import()` 一整批 sdk，每次启动都拉会拖慢交互模式的冷启动。自定义端点是 pageqa 的主路径，必须即时可用。

### 3. 切换只影响「之后的场景」，不打断当前
`/model` 选定的选择存在 TUI 的 `currentChoice` 里；场景入队执行时**那一刻**才把 `{ ...currentChoice }` 传给 `runAgent`。因此正在跑的场景沿用开跑时的模型，下一个场景才用新模型——报告里每个场景的模型归属清晰，不会出现「跑到一半换模型」导致的归属含糊。

### 4. 启动默认存在 config.json，会话选择存在内存
两套状态分开：`defaultChoice` 来自 `config.json`（`modelProvider`+`model`），`currentChoice` 是本次会话实际用的。只有 `/model` 里按 `Ctrl+S` 才写回 `config.json`（`saveModelSelection`），普通 `Enter` 只改内存。理由：用户可能因临时试一个模型而切走，「当前用哪个」和「下次默认哪个」是不同意图，不该互相覆盖。

### 5. 启动默认不可用时，警告并退回而不是硬失败
`resolveInitialChoice()` 在启动时校验 `config.json` 的默认选择是否仍在模型目录里可用（provider 已登录 / 模型未下线）。不可用时如实告警，并退回自定义端点的第一个模型，让第一条场景仍能跑——而不是每一条场景都报「模型不存在」，那会让人以为工具坏了。

### 6. 选择器用浮层，登录用「浮层 + 底部输入框」共用一套输入
- 选择（模型/登录 provider/登出条目）用 pi-tui 的 `SelectList` 放进 `TuiOverlay`（标题 + 列表 + 提示三件套）。`VStack`/`Container` 只做布局**不**向子组件转发按键，所以包了一层 `SelectorOverlay extends VStack`，自己 `handleInput` 把按键转交 `SelectList`；否则方向键/回车全石沉大海。
- 登录的文本/密钥提问**复用底部输入框**（`editor.onSubmit`），而不是另开一个输入框——提问态由 `pendingAsk` 持有，回车即「回答」、Esc 即「取消」。理由：避免两套输入路径，也避免浮层里嵌输入框的焦点管理噩梦。
- `Ctrl+S`（设为启动默认）是 `SelectList` 不认识的键，由全局输入监听在浮层打开时截获，先于列表处理。

### 7. 凭据存储：`~/.pageqa/auth.json` 串行原子写
`FileCredentialStore` 用单文件 JSON（`{ providerId: Credential }`），`read` 返回副本、`list` 只回 `(providerId, type)`（不泄露密钥）、`modify` 在**一个串行队列**里做「读-改-原子写」——多个 provider 并发登录不会互相覆盖。文件损坏时按「没有凭据」处理（宁可让用户重新登录也不崩）。`AbortSignal` 在落盘前即拒绝，已 abort 的请求不写盘。这份 `auth.json` 明确**不**进 git（与 `config.json` 区分：配置可提交，凭据不可）。

## 未采纳的替代方案

- **每条场景独立读 config 决定模型**：会让「切换」语义模糊（要不要打断当前？），且报告里模型归属难以对应。采纳「快照式」传参。
- **把凭据塞进 config.json**：凭据与可提交的配置混在一起，易被误提交。采纳独立 `auth.json`。
- **登录时也建一套独立输入框**：焦点管理与 Esc 语义重复。采纳复用底部输入框。

## 影响

- 新增文件：`src/models.ts`、`src/auth.ts`；`runAgent` 增加 `catalog`/`model` 入参；`config.ts` 增加 `modelProvider` 字段与 `saveModelSelection`。
- 新增依赖：`@earendil-works/pi-ai` 的模型/鉴权能力（已在 `package.json`）。
- 测试：`tests/credentials.test.mjs`（存储串行/损坏/中止）、`tests/model-catalog.test.mjs`（目录注册、列表、登出条目）。
