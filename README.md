# page-test-agent

用自然语言驱动的页面测试 agent。基于 **pi-agent-core**（状态化 LLM agent）编排测试步骤，**browserskill（`bsk`）** 驱动真实浏览器执行，默认经 **CodeBuddy 本地反代**（混元）实现免官网 Key 的自然语言解析。最终产出可读文本报告与机器可读 JSON 报告，返回可接入 CI 的退出码。

- 运行时：**Node.js + TypeScript**，npm 分发，CLI 入口。
- 浏览器驱动：**browserskill（`bsk`）**，连接一个已运行的真实浏览器（Chrome/Edge），支持公开页与登录态页面。
- 自然语言驱动：**pi-agent-core** 状态化 agent，把自然语言意图解析为浏览器操作步骤并自动编排；LLM 后端默认 CodeBuddy 反代（混元）。

## 前置

1. 安装并启动 `bsk` daemon，且连接一个浏览器：
   ```bash
   bsk status          # 确认 daemon 与已连接浏览器
   bsk session start   # 创建 session（CLI 也会自动创建）
   ```
2. CodeBuddy 本地反代可用（默认 `http://127.0.0.1:3000/v1`，模型 `hunyuan-2.0-instruct`，Key `codebuddy-proxy-key`）。
   可用环境变量覆盖：
   - `PAGE_TEST_LLM_BASE_URL`
   - `PAGE_TEST_LLM_API_KEY`
   - `PAGE_TEST_LLM_MODEL`

## 安装

```bash
npm install
npm run build
```

## 使用

```bash
# 内联自然语言（多句按行分隔）
page-test-agent --session <id> "打开 https://example.com
并断言标题包含 Example"

# 读取脚本文件（自动识别 `## ` 分隔的多个场景，逐个运行并汇总）
page-test-agent examples/smoke.md

# JSON 报告
page-test-agent --json examples/smoke.md

# 强制按多场景套件运行（即使只有一个场景）
page-test-agent --suite "打开 https://example.com 并断言标题包含 Example"
```

### 多场景套件

脚本（`.md`/`.txt`）中用 `## 场景名` 分隔多个独立测试场景，CLI 会逐个运行、分别给出结论，并汇总整体 PASS/FAIL 与总退出码（任一场景失败则整体失败）。

### CLI 选项

| 选项 | 说明 |
| --- | --- |
| `--session <id>` | 指定已存在的 bsk session（默认自动创建） |
| `--json` | 输出 JSON 报告 |
| `--suite` | 强制按多场景套件运行 |
| `--out <file>` | 将报告写入文件 |
| `-h, --help` | 帮助 |

退出码：`0` 全部断言通过；`1` 任一断言失败/错误/无法执行。可直接接入 CI。

## 工作原理

```
自然语言意图
   └─> pi-agent-core Agent（LLM: pi-ai 自定义 provider -> CodeBuddy 反代 -> 混元）
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

冒烟测试覆盖：A1 打开+标题断言、A2 元素交互与断言、A3 失败可读原因与退出码、A4 文本/JSON 报告。需 bsk daemon 连接浏览器且 CodeBuddy 反代可用。

也可直接运行套件脚本：

```bash
page-test-agent examples/smoke.md --json
```

## CI 集成

`.github/workflows/ci.yml` 演示如何在 GitHub Actions 中接入：安装 bsk 并连接浏览器 → 构建 → 运行 `examples/smoke.md` → 上传 JSON 报告。失败场景会使退出码非零，从而标记 CI 失败。CodeBuddy 反代地址/Key 通过仓库 Secrets（`PAGE_TEST_LLM_BASE_URL` 等）注入。

## 目录

```text
src/
  index.ts       CLI 入口
  agent.ts       编排器（pi-agent-core Agent + bsk 工具 + 报告）
  llm.ts         LLM 后端（pi-ai 自定义 provider -> CodeBuddy 反代）
  bsk/tools.ts   browserskill 工具层
  report.ts      报告解析与渲染
tests/smoke.test.mjs 端到端验证
```
