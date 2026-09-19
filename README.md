# pageqa

用自然语言驱动的页面测试 agent。基于 **pi-agent-core**（状态化 LLM agent）编排测试步骤，**browserskill（`bsk`）** 驱动真实浏览器执行，自然语言解析由可配置的 LLM 端点完成。最终产出可读文本报告与机器可读 JSON 报告，返回可接入 CI 的退出码。



https://github.com/user-attachments/assets/d5315f93-7e02-4445-a7cf-506b3bfcaa2d



- 运行时：**Node.js + TypeScript**，npm 分发，CLI 入口。
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

本地开发：

```bash
npm install
npm run build
```

全局安装（发布后）：

```bash
npm install -g pageqa
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

### CLI 选项

| 选项 | 说明 |
| --- | --- |
| `--session <id>` | 指定已存在的 bsk session（默认自动创建） |
| `--json` | 输出 JSON 报告 |
| `--suite` | 强制按多场景套件运行 |
| `--init-config` | 在用户目录创建/重置配置文件 |
| `--out <file>` | 将报告写入文件 |
| `-h, --help` | 帮助 |

退出码：`0` 全部断言通过；`1` 任一断言失败/错误/无法执行。可直接接入 CI。

## 工作原理

```
自然语言意图
   └─> pi-agent-core Agent（LLM: pi-ai 自定义 provider -> 可配置 OpenAI 兼容端点）
          └─> bsk 工具：navigate / snapshot / click / fill / hover / scroll / wait / assert_text
                 └─> 真实浏览器（bsk 连接）
          └─> 结论与证据 -> 报告（文本/JSON）+ 退出码
```

可用工具（`src/bsk/tools.ts`）：

- `navigate(url)` 打开网页
- `snapshot()` 读取页面 aria 树与可见文本（标题、段落、链接、按钮等）
- `click(target)` / `fill(target, value)` / `hover(target)` 元素交互（target 用 `@eN` 引用或 CSS 选择器）
- `scroll(target)` / `wait(ms)` 滚动与等待
- `assert_text(expectation)` 断言页面是否包含指定文本，返回「成立/不成立」与证据

## 验证

```bash
npm test
```

冒烟测试覆盖：A1 打开+标题断言、A2 元素交互与断言、A3 失败可读原因与退出码、A4 文本/JSON 报告。需 bsk daemon 连接浏览器且 LLM 端点可用。

也可直接运行套件脚本：

```bash
pageqa examples/smoke.md --json
```

## CI 集成

`.github/workflows/ci.yml` 演示如何在 GitHub Actions 中接入：安装 bsk 并连接浏览器 → 构建 → 运行 `examples/smoke.md` → 上传 JSON 报告。失败场景会使退出码非零，从而标记 CI 失败。LLM 端点地址/Key 通过仓库 Secrets（`PAGEQA_LLM_BASE_URL` 等）注入。

## 目录

```text
src/
  index.ts       CLI 入口
  agent.ts       编排器（pi-agent-core Agent + bsk 工具 + 报告）
  llm.ts         LLM 后端（pi-ai 自定义 provider -> 可配置 OpenAI 兼容端点）
  bsk/tools.ts   browserskill 工具层
  report.ts      报告解析与渲染
tests/smoke.test.mjs 端到端验证
```
