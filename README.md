# pageqa

用自然语言驱动的页面测试 agent。基于 **pi-agent-core**（状态化 LLM agent）编排测试步骤，**browserskill（`bsk`）** 驱动真实浏览器执行，自然语言解析由可配置的 LLM 端点完成。最终产出可读文本报告与机器可读 JSON 报告，返回可接入 CI 的退出码。

<https://github.com/user-attachments/assets/d5315f93-7e02-4445-a7cf-506b3bfcaa2d>

- 运行时：**Node.js + TypeScript**，以 npm 包分发、CLI 入口；仓库开发使用 **pnpm**（锁文件为 `pnpm-lock.yaml`）。
- 浏览器驱动：**browserskill（`bsk`）**，连接一个已运行的真实浏览器（Chrome/Edge），支持公开页与登录态页面。
- 自然语言驱动：**pi-agent-core** 状态化 agent，把自然语言意图解析为浏览器操作步骤并自动编排；LLM 后端通过可配置的 OpenAI 兼容端点接入（base URL / API Key / 模型均可配置）。

## 前置

### 1. 安装并配置 browserskill（`bsk`）

`bsk` 是连接真实浏览器（Chrome/Edge）的驱动，本项目通过它执行页面操作。

- 项目主页与安装方式：**<https://github.com/Tencent/BrowserSkill>**
- 按仓库 README **安装 `bsk` CLI**（只需装一次）。

> **无需手动启动 daemon**：运行 `pageqa` 时会自动检查并在 daemon 未运行时后台启动它（`bsk daemon start`），每个进程只启动一次。你也可以用 `bsk status` 查看状态。

**浏览器连接仍需你来做**（这是物理操作，pageqa 无法自动完成）：在浏览器中安装 bsk 扩展并完成连接。若启动时检测不到任何已连接浏览器，pageqa 会明确报错并提示你先连接，而不是卡死。

验证安装与连接：

```bash
bsk status           # 查看 daemon 与已连接浏览器
bsk session start    # 可选：手动创建 session（不传 --session 时 pageqa 会自动创建）
```

> 提示：本工具的 `--session <id>` 即来自 `bsk session start` 返回的 `session_id`；不传时 CLI 会自动新建一个（前提已有浏览器连接）。

> **重点提示：要执行「文件上传」用例，必须先给 bsk 浏览器扩展开启「允许访问文件网址（Allow access to file URLs）」，否则上传一定失败。**
>
> 开启方式（Edge / Chrome）：打开 `edge://extensions`（或 `chrome://extensions`）→ 找到 BrowserSkill 扩展 → 点「详细信息」→ 打开「允许访问文件网址」开关 → 回到扩展卡片点一次「重新加载」（必要时重启浏览器）。
>
> 未开启时的典型报错：`the upload trigger did not activate a file input`，以及 `the browser could not attach the staged file to the input ... {"code":-32000,"message":"Not allowed"}`。
>
> 这是浏览器级设置，**pageqa 与 bsk 都无法自动开启**（Agent Window 也无法打开 `edge://` 页面），必须人工开一次；开启后本机所有上传用例都可用。

### 2. LLM 后端（可配置 OpenAI 兼容端点）

自然语言解析依赖一个 OpenAI 兼容的 LLM 端点。端点地址、密钥与模型均可通过配置文件或环境变量设置：

- 默认地址：`http://127.0.0.1:3000/v1`（可被覆盖为任意 OpenAI 兼容端点）
- 默认 Key：`codebuddy-proxy-key`

可用环境变量覆盖（优先级高于配置文件）：

- `PAGEQA_LLM_BASE_URL`
- `PAGEQA_LLM_API_KEY`
- `PAGEQA_LLM_MODEL`

### 3. 用户级配置文件（可选但推荐）

工具会在**用户主目录**自动创建配置文件，持久化 LLM 设置，避免每次用环境变量：

- 配置目录：`~/.pageqa`（Windows：`%USERPROFILE%\.pageqa`）
- 配置文件：`config.json`

```json
{
  "baseUrl": "http://127.0.0.1:3000/v1",
  "apiKey": "codebuddy-proxy-key",
  "model": "hunyuan-2.0-instruct"
}
```

- 首次运行（或执行 `pageqa --init-config`）会自动创建该文件，编辑即可切换模型/端点地址/密钥。
- **优先级（高 → 低）**：环境变量 `PAGEQA_LLM_*`  >  用户配置文件 `config.json`  >  内置默认值。
- 例如要改用其他兼容 OpenAI 的端点，把 `baseUrl`/`apiKey`/`model` 改掉即可，无需改代码。

### 4. Jev 语义断言（可选增强）

> **什么是 Jev？** Jev 是 TypeSafe AI 推出的 [System One 模型](https://docs.typesafe.ai)，专为结构化决策设计。它不做文本生成，而是直接返回校准后的概率值（如匹配度 0.93）。适合替代原有的字符串包含匹配，做更精准的语义级断言。

**启用方式**：在 `~/.pageqa/config.json` 中添加 `jev` 字段，或设置环境变量：

```json
{
  "baseUrl": "http://127.0.0.1:3000/v1",
  "apiKey": "codebuddy-proxy-key",
  "model": "hunyuan-2.0-instruct",
  "jev": {
    "enabled": true,
    "apiKey": "your-typesafe-api-key",
    "model": "jev-latest",
    "threshold": 0.5
  }
}
```

| Jev 配置项 | 说明 | 默认值 |
| --- | --- | --- |
| `enabled` | 是否启用 Jev 语义断言 | `false` |
| `apiKey` | TypeSafe API 密钥 | （无） |
| `model` | Jev 模型 ID | `jev-latest` |
| `threshold` | 语义匹配概率阈值（0~1） | `0.5` |

**环境变量覆盖**（优先级高于配置文件）：

- `PAGEQA_JEV_ENABLED=true`
- `PAGEQA_JEV_API_KEY=<your-key>`
- `PAGEQA_JEV_MODEL=jev-latest`
- `PAGEQA_JEV_THRESHOLD=0.6`

**获取 API Key**：

1. 访问 [console.typesafe.ai/settings/keys](https://console.typesafe.ai/settings/keys)（需等待早期访问权限）
2. 或通过 Vercel AI Gateway 获取

**工作原理**：启用后，`assert_text` 工具会将页面快照文本发送给 Jev，由 Jev 判断页面内容是否语义匹配断言期望。相比原有的字符串 `includes` 匹配，Jev 能处理同义词、近义表达、大小写变体等情况，大幅降低误判。

**降级机制**：若 Jev API 调用失败（网络/超时/鉴权错误），会自动回退到原有的字符串包含匹配，确保测试不因 Jev 服务中断而失败。

**架构示意**：

```text
自然语言意图
   └─> pi-agent-core Agent（LLM → 可配置 OpenAI 兼容端点）
          └─> bsk 工具：navigate / snapshot / click / fill / hover / scroll / wait
                 └─> 真实浏览器（bsk 连接）
          └─> assert_text ──→ Jev Noul API（可选，语义匹配）
          └─> 结论与证据 → 报告（文本/JSON）+ 退出码
```

## 安装

本地开发（仓库使用 pnpm，请先安装：`npm install -g pnpm`）：

```bash
pnpm install --frozen-lockfile
pnpm run build
```

全局安装（发布后）：

```bash
npm install -g pageqa   # 或 pnpm add -g pageqa
pageqa --init-config   # 在用户目录创建配置文件 ~/.pageqa/config.json
```

> 全局安装后首次运行也会自动创建配置文件；用 `--init-config` 可显式创建/重置。

## 使用

```bash
# 内联自然语言（多句按行分隔）
pageqa --session <id> "打开 https://example.com
并断言标题包含 Example"

# 读取脚本文件（自动识别 `## ` 分隔的多个场景，逐个运行并汇总）
pageqa examples/smoke.md

# JSON 报告
pageqa --json examples/smoke.md

# 强制按多场景套件运行（即使只有一个场景）
pageqa --suite "打开 https://example.com 并断言标题包含 Example"
```

### 多场景套件

脚本（`.md`/`.txt`）中用 `## 场景名` 分隔多个独立测试场景，CLI 会逐个运行、分别给出结论，并汇总整体 PASS/FAIL 与总退出码（任一场景失败则整体失败）。

### 失败定位（步骤编号 + 执行轨迹）

长流程失败时，只看到「步骤完成：23/42」是没法改用例的——不知道卡在用例的哪一句。为此：

1. **步骤由 pageqa 统一编号**：用例的每个非空行（忽略 `#`/`>` 说明行）会被编号为 `### 步骤 k：<原文>` 后再交给模型。模型必须按编号执行，并输出同一套编号的「第 k 步完成：…」「步骤完成：k/n」。因此 `k` 能直接映射回用例的某一行。
2. **报告输出执行轨迹**：套件报告里每个场景会附上工具调用与步骤自述（末尾 25 条），失败原因与卡点一目了然。
3. **未跑完时直接点名下一步**：完整性校验的失败项会给出「最后进展」和「未执行到的步骤（第 k/n 步）：<用例原文>」，照着它就能定位到要改的那句。
4. JSON 报告额外提供 `steps`（用例步骤清单）与 `trace`（执行轨迹数组）字段；套件模式还提供 `scenarios[]`（逐场景的 `name/status/steps/trace/assertions`），便于 CI 侧做失败归因。

失败时的报告片段示例：

```text
--- 场景 1：P1 产品 → 目录 → 物料 → … [FAIL] ---
  - [PASS] 页面中已出现产品 `自动化测试产品202609210905` (证据：列表首行显示…)
  - [FAIL] 全部步骤执行完成（23/36） (agent 自报的步骤完成度不足；最后进展：第 23 步完成：已点击「操作」下拉并选择「检出」；未执行到的步骤（第 24/36 步）：点击页面右侧菜单栏的「待办事项」，进入「待办列表」；轨迹末尾：[tool] snapshot → [tool-ok] click → [tool-error] click)
  - [FAIL] 用例中的断言全部执行（实际 2/6） (…；最后进展：第 23 步完成…)
  执行轨迹（末尾 25/25 条）:
    [tool] navigate
    第 1 步完成：已打开产品列表页
    [tool-ok] snapshot
    …
    [tool-error] click
    第 23 步完成：已点击「操作」下拉并选择「检出」
```

### Token 消耗

每次运行结束后，报告**末尾**会给出本次运行的 LLM token 消耗（多场景套件在每个场景与末尾合计处各输出一行）：

```text
---
Token 消耗: 输入 446 / 输出 136 / 缓存读 6720 / 缓存写 0 / 合计 7302（LLM 调用 4 次）
```

- 数据来自各轮 assistant 消息的 `usage`（含自动续跑的轮次），`输入/输出/缓存读/缓存写` 为分项，`合计` 取端点返回的 `totalTokens`。
- JSON 报告（`--json`）中为 `usage` 字段：`{ input, output, cacheRead, cacheWrite, reasoning, total, calls }`。
- 若 LLM 端点未返回 usage（合计为 0），会在同一行标注「端点未返回 usage」，避免把 0 误读成真实消耗。

### 脚本占位符（运行时变量）

脚本里可以写 `${timestamp}` 之类的占位符，CLI 在读取脚本时按本机当前时间展开。同一次运行内所有占位符共用同一时刻，所以「名称 + 时间戳」这类用例既不会重名，也不必每次手工改时间戳：

```md
## P1 创建产品

打开 https://example.com/product
点击「新增」，填写产品名称 `自动化测试产品${timestamp}`
断言页面包含 `自动化测试产品${timestamp}`
```

| 占位符 | 展开结果 |
| --- | --- |
| `${timestamp}` | `yyyyMMddHHmm`，如 `202609191146` |
| `${date}` / `${time}` | `yyyyMMdd` / `HHmmss` |
| `${datetime}` | `yyyyMMddHHmmss` |
| `${timestamp:<格式>}` | 自定义格式，支持 `yyyy` `yy` `MM` `dd` `HH` `mm` `ss` `SSS`，如 `${timestamp:yyyy-MM-dd HH:mm}` |

未识别的占位符（如 `${PATH}`）原样保留，不会被替换。完整示例：`examples/plm-product-bom.md`。

### 运行进度日志

长流程（建产品 → 建物料 → 检定 → 审批 …）单次可能跑十几分钟。为避免「终端没输出、不知道卡在哪一步」，pageqa 会把**带时间戳的进度日志实时输出到 stderr**（stdout 只保留最终报告，两者互不干扰）：

```text
08:48:45 [pageqa] ===== 启动 =====
08:48:45 [pageqa] 已读取脚本文件 examples/plm-product-bom.md（892 字符）
08:48:45 [pageqa] 运行模式：单场景
08:48:45 [pageqa] 用例开始：打开 http://localhost/#/plm/product/list …（892 字符）
08:48:45 [pageqa] LLM 已就绪：model=hunyuan-2.0-instruct
08:48:45 [pageqa] 检查 bsk daemon 与浏览器连接…
08:48:45 [pageqa] bsk daemon 未运行，正在后台启动（首次可能需数秒）…
08:48:47 [pageqa] bsk daemon 已就绪（1.6s）
08:48:47 [pageqa] bsk 已连接浏览器 1 个
08:48:47 [pageqa] bsk session=abc123
08:48:47 [pageqa] 已提交用例，等待模型与浏览器执行…
08:48:48 [pageqa] 模型已开始输出，正在推进步骤…
08:48:49 [pageqa] ▶ #1 navigate …
08:48:52 [pageqa] ✓ #1 navigate 2874ms
08:48:52 [pageqa] ▶ #2 snapshot …
08:48:53 [pageqa] ✓ #2 snapshot 412ms
...
08:53:10 [pageqa] 步骤未跑完，发起第 1 次续跑（进度 12/16，断言 2/4）
08:55:02 [pageqa] 用例结束：PASS，断言 4 条，耗时 376.4s
```

- 覆盖的关键节点：脚本读取、LLM 就绪、bsk daemon 启动/就绪耗时、浏览器连接数、session、每一步工具调用（编号 + 名称 + 耗时 + 成败）、自动续跑、最终结论与总耗时。
- 加 `--debug` 可看到更细的明细：每条 `bsk` 命令原文与耗时、快照字符数、上下文裁剪、Jev 请求详情。
- 需要把日志与报告分开处理时：报告在 stdout（`--json` 也走 stdout），日志始终在 stderr，`pageqa --json … > report.json` 即可不受日志干扰。

### CLI 选项

| 选项 | 说明 |
| --- | --- |
| `--session <id>` | 指定已存在的 bsk session（默认自动创建） |
| `--json` | 输出 JSON 报告 |
| `--suite` | 强制按多场景套件运行 |
| `--init-config` | 在用户目录创建/重置配置文件 |
| `--out <file>` | 将报告写入文件 |
| `--debug` | 显示调试日志（bsk 命令与耗时、快照体积、上下文裁剪、Jev 请求详情） |
| `-h, --help` | 帮助 |

退出码：`0` 全部断言通过；`1` 任一断言失败/错误/无法执行。可直接接入 CI。

### 自动关闭浏览器窗口

用例跑完后（无论 PASS、FAIL 还是中途报错），pageqa 都会执行 `bsk session stop <id>` 收尾：

- 关掉本次自动化操作所在的浏览器窗口（bsk Agent Window），并归还借用过的用户标签页；
- 多场景套件是逐个场景运行，因此每个场景结束后各自关闭自己的窗口，不会越跑越多；
- `--session <id>` 传入的 session 也会在运行结束后被关闭（下次运行会重新创建）；
- 关闭失败只在日志里提示，不会改变测试结论。

### 文件上传

脚本里直接写「点击某个上传按钮上传本地文件 `<绝对路径>`」，agent 会调用 `upload` 工具完成（可运行 `examples/element-plus-upload.md` 体验）：

```md
## U1 点击 Click to upload 上传图片

打开 https://element-plus.org/zh-CN/component/upload
点击示例中的「Click to upload」按钮并上传本地文件 D:\Downloads\example.png
等待 2 秒，让上传列表完成渲染
断言页面中已出现上传的文件名 example.png
```

```bash
pageqa examples/element-plus-upload.md
```

要点（踩过的坑）：

- **先开扩展权限**：见「前置 → 1. 安装并配置 browserskill」中的重点提示。未开启时上传必然失败，报 `Not allowed`。
- `target` 传**触发文件选择器的元素**（按钮的 `@eN` 或 CSS 选择器）；不要传隐藏的 `input[type=file]`——它没有可见几何，bsk 会拒绝点击并报 `target element has no visible geometry`。省略 `target` 时由 bsk 自动在页面中查找文件输入框。
- **不要先 `click` 上传按钮再调用上传**：原生系统文件选择框无法被自动化操作，单独 click 会把流程挂住。`upload` 会自己点击触发元素并接管文件选择器。
- 路径必须是**本机绝对路径且文件真实存在**：`upload` 会先校验，不存在直接报错，不会默默跳过。
- 像 `el-upload` 这类「点击按钮 → 页面 JS 触发隐藏 input」的组件，首次尝试可能返回 `did not activate a file input`（时序问题，不是权限问题）；此时重试一次即可成功。
- 上传动作成功不等于用例通过：**真伪仍由页面断言决定**。若站点把文件提交到外部接口而接口不可用（例如 element-plus 文档示例提交到 `run.mocky.io`，本机证书校验失败），组件会在上传失败后移除该文件，此时「断言文件出现在列表中」会如实报 FAIL——这是被测页面的真实行为，不是工具问题。

## 工作原理

```
自然语言意图
   └─> pi-agent-core Agent（LLM: pi-ai 自定义 provider -> 可配置 OpenAI 兼容端点）
          └─> bsk 工具：navigate / snapshot / click / fill / upload / hover / scroll / wait / assert_text
                 └─> 真实浏览器（bsk 连接）
          └─> 结论与证据 -> 报告（文本/JSON）+ 退出码
```

可用工具（`src/bsk/tools.ts`）：

- `navigate(url)` 打开网页
- `snapshot()` 读取页面 aria 树与可见文本（标题、段落、链接、按钮等）
- `click(target)` / `fill(target, value)` / `hover(target)` 元素交互（target 用 `@eN` 引用或 CSS 选择器）
- `upload(target, file)` 上传本地文件（target 为触发文件选择器的元素，省略则由 bsk 自动查找文件输入框）
- `scroll(target)` / `wait(ms)` 滚动与等待
- `assert_text(expectation)` 断言页面是否包含指定文本，返回「成立/不成立」与证据

**长流程保护（自动续跑）**：一轮对话结束后，如果 agent 自报的进度没跑满（`步骤完成：k/n` 且 `k < n`），或者用例里写了断言但报告只解析到一部分，pageqa 会自动补一次「继续执行剩余步骤」的提示并继续跑，最多 5 轮；续跑后进度与断言数都没有推进就停止。这样可以避免模型做完一两步就自行收尾、却让报告看起来正常的情况。

## 验证

```bash
pnpm test            # 端到端冒烟：需 bsk daemon 已连接浏览器 + LLM 端点可用
pnpm run test:unit   # 仅单元测试：不依赖浏览器与 LLM
```

冒烟测试覆盖：A1 打开+标题断言、A2 元素交互与断言、A3 失败可读原因与退出码、A4 文本/JSON 报告。需 bsk daemon 连接浏览器且 LLM 端点可用。

也可直接运行套件脚本：

```bash
pageqa examples/smoke.md --json
```

## CI 集成

**`.github/workflows/ci.yml`**：在 `master`/`main` 的 push 与 PR 上运行，流程为 pnpm 冻结锁文件安装（`pnpm install --frozen-lockfile`）→ `pnpm run build` → `pnpm run test:unit`。

端到端冒烟（`examples/smoke.md`）需要 bsk daemon、已连接的真实浏览器与可用的 LLM 端点，GitHub 托管 runner 上不具备这些条件，因此不在仓库 CI 中运行。若要在自己的 CI 里跑端到端，用环境变量注入 LLM 端点（`PAGEQA_LLM_BASE_URL` / `PAGEQA_LLM_API_KEY` / `PAGEQA_LLM_MODEL`，建议放仓库 Secrets）：

```bash
pnpm run build
node dist/index.js --json examples/smoke.md
```

任一断言失败会返回非零退出码，可直接作为 CI 门禁。

**`.github/workflows/release.yml`**：推送 `v*` tag 时触发，`check` job 先冻结锁文件安装并构建，随后通过 npm **OIDC 可信发布**（依赖 `id-token: write`，无需 `NPM_TOKEN`）发布到 npm 并自动创建 GitHub Release。发布产物附带 SLSA provenance 证明，因此 `package.json` 中的 `repository` 字段必须与仓库地址一致，不可删除。

## 目录

```text
src/
  index.ts       CLI 入口
  agent.ts       编排器（pi-agent-core Agent + bsk 工具 + 报告）
  llm.ts         LLM 后端（pi-ai 自定义 provider -> 可配置 OpenAI 兼容端点）
  log.ts         进度日志（stderr 默认输出；--debug 输出调试明细）
  bsk/tools.ts   browserskill 工具层（含 upload 文件上传）
  report.ts      报告解析与渲染
examples/
  smoke.md                  示例套件（A1–A3）
  github-star.md            GitHub Star 用例
  element-plus-upload.md    文件上传用例（点击 Click to upload 上传本地图片）
  plm-product-bom.md        PLM 长流程用例（建产品→目录→物料→检出→待办同意→BOM 插入）
tests/smoke.test.mjs 端到端验证
```
