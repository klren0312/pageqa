#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { runAgent, runSuite } from "./agent.js";

interface CliArgs {
  input?: string;
  session?: string;
  json: boolean;
  out?: string;
  suite: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { json: false, suite: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "-h":
      case "--help":
        args.help = true;
        break;
      case "--session":
        args.session = argv[++i];
        break;
      case "--json":
        args.json = true;
        break;
      case "--suite":
        args.suite = true;
        break;
      case "--out":
        args.out = argv[++i];
        break;
      default:
        if (!a.startsWith("-")) args.input = a;
    }
  }
  return args;
}

const HELP = `page-test-agent - 自然语言驱动的页面测试工具（pi-agent-core + browserskill）

用法:
  page-test-agent [options] <input>

  <input>          自然语言脚本文件(.md/.txt)，或用引号包裹的内联文本
                  脚本中可用『## 场景名』分隔多个测试场景，自动批量运行

选项:
  --session <id>   指定已存在的 bsk session（默认自动创建）
  --json           输出 JSON 报告
  --suite          强制按多场景套件运行（即使只有一个场景）
  --out <file>     将报告写入文件
  -h, --help       显示帮助

前置:
  - 已安装并启动 bsk daemon，且连接了一个浏览器（bsk session start）
  - CodeBuddy 本地反代可用（默认 http://127.0.0.1:3000/v1，模型 hunyuan-2.0-instruct）
    可通过环境变量 PAGE_TEST_LLM_BASE_URL / PAGE_TEST_LLM_API_KEY / PAGE_TEST_LLM_MODEL 覆盖

示例:
  page-test-agent --session ulao "打开 https://example.com 并断言标题包含 Example"
  page-test-agent examples/smoke.md --json
`;

function readInput(input: string): string {
  if (!input.includes("\n") && (input.endsWith(".md") || input.endsWith(".txt"))) {
    try {
      return readFileSync(input, "utf8");
    } catch {
      // 不是文件：视为内联文本
    }
  }
  return input;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.input) {
    process.stdout.write(HELP + "\n");
    return args.help ? 0 : 1;
  }

  const input = readInput(args.input);
  try {
    const hasScenarios = /^##\s+/m.test(input);
    const result = hasScenarios || args.suite
      ? await runSuite(input, { session: args.session })
      : await runAgent(input, { session: args.session });
    const out = args.json ? result.json : result.text;
    if (args.out) {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(args.out, out + "\n");
    }
    process.stdout.write(out + "\n");
    return result.report.status === "pass" ? 0 : 1;
  } catch (err) {
    process.stderr.write(`执行失败: ${err instanceof Error ? err.stack : String(err)}\n`);
    return 1;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`执行失败: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
  });
