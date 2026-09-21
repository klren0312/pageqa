#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
  /** 参数解析错误（如带值选项缺少参数）；有值时 main 会提示并退出。 */
  error?: string;
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
      case "--session": {
        const v = argv[++i];
        if (v === undefined) {
          args.error = "--session 需要一个 session id 参数";
          return args;
        }
        args.session = v;
        break;
      }
      case "--json":
        args.json = true;
        break;
      case "--suite":
        args.suite = true;
        break;
      case "--init-config":
        args.initConfig = true;
        break;
      case "--out": {
        const v = argv[++i];
        if (v === undefined) {
          args.error = "--out 需要一个文件路径参数";
          return args;
        }
        args.out = v;
        break;
      }
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

  <input>          自然语言脚本文件(.md/.txt，路径含空格请用引号包裹)，
                   或用引号包裹的内联文本
                  脚本中可用『## 场景名』分隔多个测试场景，自动批量运行
                  路径中粘贴带来的不可见字符（Bidi/零宽）会被自动清理；
                  若路径以 .md/.txt 结尾但文件不存在，会直接报错而非当作内联文本

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

/**
 * 从资源管理器「复制文件路径」或聊天工具粘贴路径时，常会夹带不可见的
 * Bidi 控制符 / 零宽字符（如 U+202A LEFT-TO-RIGHT EMBEDDING、U+200B、U+FEFF）。
 * 它们肉眼不可见，却会让 readFileSync 找不到文件，进而把路径误判成内联文本。
 */
const INVISIBLE_CHARS = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

/** 清洗命令行传入的 <input>：去不可见字符、去首尾空白、去成对引号、去 file:// 前缀。 */
function cleanInput(raw: string): string {
  let s = raw.replace(INVISIBLE_CHARS, "").trim();
  const quoted = s.match(/^(["'])([\s\S]*)\1$/);
  if (quoted) s = quoted[2].replace(INVISIBLE_CHARS, "").trim();
  if (/^file:\/\//i.test(s)) {
    try {
      s = fileURLToPath(s);
    } catch {
      // 非法 file URL：保持原样，后续按不存在处理
    }
  }
  return s;
}

/** 是否"看起来"是一个脚本文件路径：单行且以 .md/.txt 结尾（大小写不敏感）。 */
function looksLikeScriptFile(input: string): boolean {
  return !/[\r\n]/.test(input) && /\.(md|txt)$/i.test(input);
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) {
    process.stderr.write(`参数错误：${args.error}\n\n`);
    process.stdout.write(HELP + "\n");
    return 1;
  }
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
  const rawInput = cleanInput(args.input);
  const isFile = looksLikeScriptFile(rawInput) && existsSync(rawInput);
  if (!isFile && looksLikeScriptFile(rawInput)) {
    // 看起来是脚本文件路径但打不开：明确报错，避免把路径本身当成用例去"测试"
    process.stderr.write(
      `找不到脚本文件：${rawInput}\n` +
        `  - 请确认路径存在且拼写正确\n` +
        `  - 若路径含空格，请用引号包裹（如 "C:\\dir\\my case.md"）\n` +
        `  - 若只想跑内联文本，请不要让文本以 .md/.txt 结尾\n`,
    );
    return 1;
  }
  const input = isFile
    ? expandVars(readFileSync(rawInput, "utf8"))
    : expandVars(rawInput);
  const hasScenarios = /^##\s+/m.test(input);
  const suiteMode = hasScenarios || args.suite;

  info("[pageqa] ===== 启动 =====");
  info(
    `[pageqa] 已读取${isFile ? `脚本文件 ${rawInput}` : "内联用例"}（${input.length} 字符）`,
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

// 兜底：main() 的 catch 只能捕获其 Promise 链内的错误。
// 工具执行、事件订阅回调等异步路径上抛出的异常不会被它捕获，
// 若不处理会直接静默崩溃（进程退出码非 0 但无任何报错信息）。
process.on("uncaughtException", (err) => {
  process.stderr.write(
    `执行失败（未捕获异常）: ${err instanceof Error ? err.stack : String(err)}\n`,
  );
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  process.stderr.write(
    `执行失败（未处理的 Promise rejection）: ${
      reason instanceof Error ? reason.stack : String(reason)
    }\n`,
  );
  process.exit(1);
});
