#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { runAgent, runSuite } from "./agent.js";
import { ensureConfigDir, CONFIG_PATH, loadConfig } from "./config.js";
import { expandVars, VAR_HELP } from "./vars.js";
import { info, setDebug } from "./log.js";

interface CliArgs {
  input?: string;
  session?: string;
  json: boolean;
  out?: string;
  suite: boolean;
  initConfig: boolean;
  help: boolean;
  debug: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    json: false,
    suite: false,
    initConfig: false,
    help: false,
    debug: false,
  };
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
      case "--init-config":
        args.initConfig = true;
        break;
      case "--out":
        args.out = argv[++i];
        break;
      case "--debug":
        args.debug = true;
        break;
      default:
        if (!a.startsWith("-")) args.input = a;
    }
  }
  return args;
}

const HELP = `pageqa - 自然语言驱动的页面测试工具（pi-agent-core + browserskill）

用法:
  pageqa [options] <input>

  <input>          自然语言脚本文件(.md/.txt)，或用引号包裹的内联文本
                  脚本中可用『## 场景名』分隔多个测试场景，自动批量运行

选项:
  --session <id>   指定已存在的 bsk session（默认自动创建）
                  无论新建还是复用，用例跑完后都会自动关闭该 session
                  并关掉它对应的浏览器窗口（Agent Window）
  --json           输出 JSON 报告
  --suite          强制按多场景套件运行（即使只有一个场景）
  --init-config    在用户目录创建/重置配置文件
  --out <file>     将报告写入文件
  --debug          显示调试日志（bsk 命令、快照体积、上下文裁剪、Jev 请求详情）
  -h, --help       显示帮助

进度日志:
  - 运行进度会带时间戳实时输出到 stderr（bsk daemon 启动、session、每一步工具调用、
    续跑与最终结论等），stdout 只输出最终报告，两者互不干扰；长流程可据此判断进行到哪一步。
  - 加 --debug 可看到更细的 bsk 命令与耗时明细。

脚本占位符:
${VAR_HELP}

配置:
  - 首次运行会在用户目录自动创建配置文件：~/.pageqa/config.json
    （Windows: %USERPROFILE%\\.pageqa\\config.json）
  - 可编辑该文件设置 baseUrl / apiKey / model
  - 也可用环境变量覆盖（优先级高于配置文件）：
      PAGEQA_LLM_BASE_URL / PAGEQA_LLM_API_KEY / PAGEQA_LLM_MODEL
  - Jev 语义判断（可选，用于增强断言精度）：
      PAGEQA_JEV_ENABLED=true   启用 Jev 辅助断言
      PAGEQA_JEV_API_KEY=<key>  TypeSafe API 密钥
      PAGEQA_JEV_MODEL=<model>  Jev 模型（默认 jev-latest）
      PAGEQA_JEV_THRESHOLD=<n>  判定阈值 0-1（默认 0.5）
  - 运行 pageqa --init-config 可显式创建/重置配置文件

前置:
  - 已安装并启动 bsk daemon，且连接了一个浏览器（bsk session start）
  - 有一个可用的 OpenAI 兼容 LLM 端点（默认 http://127.0.0.1:3000/v1，模型 hunyuan-2.0-instruct，
    可通过 ~/.pageqa/config.json 或 PAGEQA_LLM_* 环境变量覆盖）

示例:
  pageqa --session ulao "打开 https://example.com 并断言标题包含 Example"
  pageqa examples/smoke.md --json
  pageqa examples/smoke.md --debug
`;

function readInput(input: string): string {
  if (
    !input.includes("\n") &&
    (input.endsWith(".md") || input.endsWith(".txt"))
  ) {
    try {
      return expandVars(readFileSync(input, "utf8"));
    } catch {
      // 不是文件：视为内联文本
    }
  }
  return expandVars(input);
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP + "\n");
    return 0;
  }
  if (args.initConfig) {
    const dir = ensureConfigDir();
    loadConfig(); // 触发配置文件创建
    process.stdout.write(`配置文件已创建/确认：${CONFIG_PATH}\n目录：${dir}\n`);
    process.stdout.write(
      `当前生效配置：${JSON.stringify(loadConfig(), null, 2)}\n`,
    );
    return 0;
  }
  if (!args.input) {
    process.stdout.write(HELP + "\n");
    return 1;
  }

  setDebug(args.debug);
  const isFile =
    !args.input.includes("\n") &&
    (args.input.endsWith(".md") || args.input.endsWith(".txt")) &&
    existsSync(args.input);
  const input = readInput(args.input);
  const hasScenarios = /^##\s+/m.test(input);
  const suiteMode = hasScenarios || args.suite;

  info("[pageqa] ===== 启动 =====");
  info(
    `[pageqa] 已读取${isFile ? `脚本文件 ${args.input}` : "内联用例"}（${input.length} 字符）`,
  );
  info(
    `[pageqa] 运行模式：${suiteMode ? "多场景套件" : "单场景"}` +
      `${args.session ? `，session=${args.session}` : ""}` +
      `${args.debug ? "，debug=on（stderr 含调试明细）" : ""}`,
  );

  try {
    const result = suiteMode
      ? await runSuite(input, { session: args.session, debug: args.debug })
      : await runAgent(input, { session: args.session, debug: args.debug });
    const out = args.json ? result.json : result.text;
    if (args.out) {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(args.out, out + "\n");
    }
    process.stdout.write(out + "\n");
    return result.report.status === "pass" ? 0 : 1;
  } catch (err) {
    process.stderr.write(
      `执行失败: ${err instanceof Error ? err.stack : String(err)}\n`,
    );
    return 1;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(
      `执行失败: ${err instanceof Error ? err.stack : String(err)}\n`,
    );
    process.exit(1);
  });
