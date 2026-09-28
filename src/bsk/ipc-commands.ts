/**
 * bsk CLI argv → daemon IPC 的翻译层，以及把结果渲染回 CLI 的文本。
 *
 * 为什么需要这一层：操作层（tools.ts）与回放引擎都是按「一条命令一段文本」写成的，
 * 它们消费的是 CLI 的 stdout（`click ok tab=… target=…`、快照正文），失败时读的是
 * stderr 里的 `error:/hint:/details:` 三行。走 IPC 只是换了一条传输，**这些文本必须一模一样**，
 * 否则模型看到的操作回显、报告里的失败原因都会悄悄变样。
 *
 * 支持范围刻意只覆盖「高频 + 结果简单」的子集：
 * snapshot / click / fill / hover / scroll-to / wait-ms / evaluate
 * （最后一个是「页面稳定检测」的载体，见 settle.ts）。
 * 其余（navigate 的失败诊断、upload/download 的文件传输与 `--json` 信封、
 * session 生命周期、observe/get-html…）继续走 CLI 子进程——它们的价值和复杂度都在
 * CLI 那一侧的渲染与文件处理上，搬过来只会多一份需要同步维护的实现。
 *
 * **认不出来就返回 null**（未知子命令、未知参数、缺参数、`--json`）：调用方原样退回 CLI。
 * 这条规则是整层安全性的地基——新增一个 bsk 参数不会让这里静默跑错，只会让快路径暂时失效。
 */

import { BskIpcRpcError, BskIpcTransportError } from "./ipc.js";

/** 一次 IPC 快路径调用：怎么发、发完怎么渲染。 */
export interface IpcPlan {
  /** daemon 的 RPC 方法名（`tool.snapshot` 等）。 */
  method: string;
  params: Record<string, unknown>;
  /** 连接复用键：同一 session 共用一条连接；无 session 的命令用 `@daemon`。 */
  sessionKey: string;
  /**
   * 这条命令是否会改动页面。
   *
   * 决定「请求已经发出去之后出错」时的处置：改动型命令**绝不能**退回 CLI 重发
   * （动作可能已经生效，重发就是点两次）；只读命令可以安全重发。
   */
  mutating: boolean;
  /** 把 daemon 的 result 渲染成与 CLI human 模式一致的文本。 */
  render: (result: unknown) => string;
}

/** 带值的参数：出现时必须紧跟一个值。 */
const VALUE_FLAGS = new Set([
  "session",
  "tab-id",
  "max-depth",
  "max-tokens",
  "value",
  "timeout",
  "settle",
  "await-promise",
  "return-by-value",
]);

/** 布尔参数（不带值）。 */
const BOOL_FLAGS = new Set(["quiet", "no-clear"]);

/** 认不出的参数一律拒绝：宁可退回 CLI，也不猜它是什么意思。 */
const REJECTED_FLAGS = new Set(["json"]);

interface ParsedArgs {
  command: string;
  positionals: string[];
  flags: Map<string, string | true>;
}

/** 把 argv 切成子命令、位置参数与参数表；遇到不认识的形状返回 null。 */
function parseArgs(args: string[]): ParsedArgs | null {
  const [command, ...rest] = args;
  if (!command) return null;
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (REJECTED_FLAGS.has(name)) return null;
    if (BOOL_FLAGS.has(name)) {
      flags.set(name, true);
      continue;
    }
    if (!VALUE_FLAGS.has(name)) return null;
    const value = rest[i + 1];
    if (value === undefined) return null;
    flags.set(name, value);
    i += 1;
  }
  return { command, positionals, flags };
}

/** 与 bsk CLI 的 `looks_like_ref` 同义：`e3` / `@e3` 是引用，其余按 CSS 选择器。 */
export function looksLikeRef(target: string): boolean {
  const stripped = target.startsWith("@") ? target.slice(1) : target;
  if (!stripped.startsWith("e")) return false;
  const rest = stripped.slice(1);
  return rest.length > 0 && /^\d+$/.test(rest);
}

/** 目标 → `{ref}` 或 `{selector}`（与 CLI 的 split_target 同规则）。 */
function targetParams(target: string): Record<string, unknown> | null {
  if (!target) return null;
  return looksLikeRef(target) ? { ref: target } : { selector: target };
}

/** 可选的 `--tab-id`。 */
function tabId(flags: Map<string, string | true>): Record<string, unknown> {
  const raw = flags.get("tab-id");
  if (typeof raw !== "string") return {};
  const n = Number(raw);
  return Number.isInteger(n) ? { tab_id: n } : {};
}

/** 可选的 `--timeout`（毫秒），与 CLI 的 `--timeout 30s` 语法保持一致的子集。 */
function timeoutMs(flags: Map<string, string | true>): Record<string, unknown> {
  const raw = flags.get("timeout");
  if (typeof raw !== "string") return {};
  const ms = parseDurationMs(raw);
  return ms === null ? {} : { timeout_ms: ms };
}

/** 秒/毫秒语法的子集（`30s` / `1500ms` / 裸整数=毫秒）。 */
export function parseDurationMs(raw: string): number | null {
  const text = raw.trim();
  if (!text) return null;
  let num = text;
  let factor = 1;
  if (text.endsWith("ms")) num = text.slice(0, -2);
  else if (text.endsWith("s")) {
    num = text.slice(0, -1);
    factor = 1_000;
  } else if (text.endsWith("m")) {
    num = text.slice(0, -1);
    factor = 60_000;
  }
  const n = Number(num);
  if (!Number.isFinite(n) || n < 0) return null;
  return n * factor;
}

/** 数字渲染成 Rust `{}` 的样子（整数值不带 `.0`）；不是数字时给 `?`。 */
function num(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "?";
}

/** `target=` 的渲染规则（CLI 的 `format_used_target`）：引用加 `@` 前缀，取不到时 `?`。 */
function usedTarget(result: Record<string, unknown>): string {
  const usedRef = result.used_ref;
  if (typeof usedRef === "string" && usedRef) {
    return usedRef.startsWith("@") ? usedRef : `@${usedRef}`;
  }
  const usedSelector = result.used_selector;
  if (typeof usedSelector === "string" && usedSelector) return usedSelector;
  return "?";
}

/**
 * 结果形状不认识时抛**传输**错误（而不是普通错误）。
 *
 * 这样调用方会把它当成「这次快路径不可信」处理；但注意：命令已经执行过了，
 * 所以 tools.ts 对改动型命令不会退回 CLI——那会变成重复操作。
 */
function badShape(method: string, detail: string): BskIpcTransportError {
  return new BskIpcTransportError(`${method} 的结果形状无法识别：${detail}`, undefined, true);
}

function asRecord(result: unknown, method: string): Record<string, unknown> {
  if (!result || typeof result !== "object") throw badShape(method, String(result));
  return result as Record<string, unknown>;
}

/**
 * 把 argv 翻译成一次 IPC 调用；不属于支持范围时返回 null（调用方退回 CLI）。
 */
export function planIpcCall(args: string[]): IpcPlan | null {
  const parsed = parseArgs(args);
  if (!parsed) return null;
  const { command, positionals, flags } = parsed;
  const session = flags.get("session");
  const sessionKey = typeof session === "string" && session ? session : "@daemon";

  switch (command) {
    case "snapshot": {
      if (typeof session !== "string" || !session) return null;
      if (positionals.length > 0) return null;
      const params: Record<string, unknown> = { session_id: session, ...tabId(flags) };
      const depth = flags.get("max-depth");
      if (typeof depth === "string" && Number.isInteger(Number(depth))) {
        params.max_depth = Number(depth);
      }
      const tokens = flags.get("max-tokens");
      if (typeof tokens === "string" && Number.isInteger(Number(tokens))) {
        params.max_tokens = Number(tokens);
      }
      return {
        method: "tool.snapshot",
        params,
        sessionKey,
        mutating: false,
        render: (result) => {
          const r = asRecord(result, "tool.snapshot");
          if (typeof r.text !== "string") throw badShape("tool.snapshot", "缺少 text");
          // CLI 在快照为空时打印的是这句提示，而不是空行。
          return r.text.length === 0 ? "(empty snapshot — page may still be loading)" : r.text;
        },
      };
    }

    case "click":
    case "hover":
    case "scroll-to": {
      if (typeof session !== "string" || !session) return null;
      if (positionals.length !== 1) return null;
      const target = targetParams(positionals[0]);
      if (!target) return null;
      const method =
        command === "click"
          ? "tool.click"
          : command === "hover"
            ? "tool.hover"
            : "tool.scroll_to";
      const params: Record<string, unknown> = {
        session_id: session,
        ...target,
        ...tabId(flags),
        ...timeoutMs(flags),
      };
      if (command === "hover") {
        // CLI 的 --settle 默认 200ms：不显式给出就会用到扩展侧的另一套默认值。
        const settle = flags.get("settle");
        params.settle_ms =
          typeof settle === "string" ? (parseDurationMs(settle) ?? 200) : 200;
      }
      return {
        method,
        params,
        sessionKey,
        mutating: true,
        render: (result) => {
          const r = asRecord(result, method);
          if (command === "scroll-to") {
            return (
              `scroll-to ok tab=${num(r.tab_id)} target=${usedTarget(r)}` +
              ` bounds=(${num(r.x)}, ${num(r.y)}, ${num(r.width)}, ${num(r.height)})`
            );
          }
          const verb = command === "click" ? "click" : "hover";
          return `${verb} ok tab=${num(r.tab_id)} target=${usedTarget(r)} at=(${num(r.x)}, ${num(r.y)})`;
        },
      };
    }

    case "fill": {
      if (typeof session !== "string" || !session) return null;
      if (positionals.length !== 1) return null;
      const value = flags.get("value");
      if (typeof value !== "string") return null;
      const target = targetParams(positionals[0]);
      if (!target) return null;
      return {
        method: "tool.fill",
        params: {
          session_id: session,
          value,
          ...target,
          ...tabId(flags),
          ...(flags.get("no-clear") === true ? { clear_before: false } : {}),
          ...timeoutMs(flags),
        },
        sessionKey,
        mutating: true,
        render: (result) => {
          const r = asRecord(result, "tool.fill");
          return `fill ok tab=${num(r.tab_id)} target=${usedTarget(r)} length=${num(r.value_length)}`;
        },
      };
    }

    case "evaluate": {
      if (typeof session !== "string" || !session) return null;
      if (positionals.length !== 1) return null;
      const expression = positionals[0];
      if (!expression.trim()) return null;
      // clap 里这两个开关是 `--flag <bool>`，缺省都是 true（CLI 与协议两侧都是）；
      // 只在显式给了值时透传，别自己发明一个默认值。
      const boolFlag = (name: string): Record<string, unknown> => {
        const raw = flags.get(name);
        if (typeof raw !== "string") return {};
        const v = raw.trim().toLowerCase();
        if (v === "true") return { [name.replace(/-/g, "_")]: true };
        if (v === "false") return { [name.replace(/-/g, "_")]: false };
        return {};
      };
      return {
        method: "tool.evaluate",
        params: {
          session_id: session,
          expression,
          ...tabId(flags),
          ...boolFlag("await-promise"),
          ...boolFlag("return-by-value"),
          ...timeoutMs(flags),
        },
        sessionKey,
        // 协议层把 evaluate 归为「会改动页面」（脚本想干什么都行）：请求已发出后出错时
        // 不能退回 CLI 重跑一遍脚本，理由与 click 相同。
        mutating: true,
        render: (result) => {
          const r = asRecord(result, "tool.evaluate");
          if (r.ok !== true) {
            // CLI 在 ok=false 时只把 throw 文本写 stderr、stdout 留空、退出码仍为 0
            // （见 cli/evaluate.rs 的退出码策略）。这里照抄，不发明新的失败形态。
            return "";
          }
          const value = r.value;
          if (value === undefined || value === null) return "null";
          return typeof value === "string" ? value : JSON.stringify(value);
        },
      };
    }

    case "wait-ms": {
      // daemon 端的 sleep：不走 session 队列、不需要 session（CLI 也是这个形状）。
      if (positionals.length !== 1) return null;
      if (typeof session === "string") return null;
      const ms = parseDurationMs(positionals[0]);
      if (ms === null) return null;
      return {
        method: "tool.wait_ms",
        params: { duration_ms: ms },
        sessionKey: "@daemon",
        mutating: false,
        render: (result) => {
          const r = asRecord(result, "tool.wait_ms");
          return `waited_ms=${num(r.waited_ms)}`;
        },
      };
    }

    default:
      return null;
  }
}

/**
 * 补上 CLI 的 `println!` 会给每条成功输出加的那个换行。
 *
 * 为什么要凑这一个字节：操作层的每处回显都是 `已点击 @e3\n${out}` 这样拼出来的，
 * 报告、日志、模型看到的文本都来自它。让「IPC 版本的 stdout」与「子进程版本」逐字节一致，
 * 回退/不回退就不再是两种可见行为——排查差异时不必再判断「这里差个换行是不是正常的」。
 */
export function withCliTrailingNewline(text: string): string {
  return text + "\n";
}

/**
 * ErrorCode → CLI 的 `error:` / `hint:` 文案。
 *
 * 抄的是 BrowserSkill 的 `crates/bsk-cli/src/cli/render_error.rs`，但**只抄这里面会出现的码**：
 * 这张表是给人/模型读的说明文本，不是判定依据（判定依据是 `code`），所以少一条只会让措辞退化成
 * daemon 原话，不会让结论出错。reason 级的细分覆盖（fill_failed 等）刻意不做——那些细节
 * 由 `details:` 一行里的 daemon 原话承担，避免把 bsk 的一大张表复制进这里慢慢漂移。
 */
const ERROR_COPY: Record<string, { summary: string; hint?: string }> = {
  unknown_method: {
    summary: "daemon does not recognise this RPC method",
    hint: "upgrade both bsk CLI and the browser-skill extension; CLI and daemon may be on mismatched protocol versions",
  },
  unsupported: {
    summary: "this operation is not supported by the current build",
    hint: "check `bsk --version` and the bsk changelog to confirm whether the feature is available",
  },
  invalid_params: {
    summary: "invalid command parameters",
    hint: "check your command arguments; run `bsk <cmd> --help` to see the expected format",
  },
  not_found: {
    summary: "requested resource does not exist",
    hint: "the session, tab, or browser may have stopped; run `bsk session list` / `bsk browsers` to see current state",
  },
  permission_denied: {
    summary: "operation denied by the Agent Window sandbox",
    hint: "tabs outside an Agent Window must first be borrowed via `bsk tab borrow <tab-id> --session <id>`",
  },
  timeout: {
    summary: "operation timed out",
    hint: "retry the command; if timeouts persist, check `bsk logs` and confirm the browser is still responding",
  },
  cdp_failed: {
    summary: "browser rejected the underlying CDP call",
    hint: "confirm the tab is still in a loaded state and retry; reloading the tab usually resets a stuck DevTools session",
  },
  protocol_error: {
    summary: "protocol error communicating with bsk daemon",
    hint: "ensure CLI and daemon protocol versions match — check `protocol version` in `bsk status`",
  },
  cancelled: {
    summary: "operation cancelled",
    hint: "the previous command was interrupted (Ctrl-C or a remote `cancel` request)",
  },
  user_aborted: {
    summary: "operation interrupted by user",
    hint: "the user requested an interrupt (e.g. via the agent window's stop button); rerun if this was unintended",
  },
  version_too_old: {
    summary: "peer version is too old to communicate with this build",
    hint: "upgrade both bsk CLI and the browser-skill extension so both sides satisfy `min_compatible_protocol`",
  },
  multiple_browsers_online: {
    summary: "multiple browsers are online",
    hint: "use `--browser <instance_id-or-label>` to target a specific browser (run `bsk browsers` to list online browsers)",
  },
  no_browser_connected: {
    summary: "no browser is connected to the daemon",
    hint: 'open the browser-skill extension in your browser and wait for the popup to show "connected"',
  },
};

/**
 * 组装 CLI human 模式的 stderr 文本：`error: …` / `hint: …` / `details: …`。
 *
 * 三行的顺序与措辞是刻意的：`navigate-diagnosis` 靠 `details:` 取真实原因，
 * `bskErrorDetail` 靠剥离包装噪声后取整段——它们读的就是这段文本。
 */
export function renderCliErrorText(code: string, message: string, hint?: string): string {
  const copy = ERROR_COPY[code];
  const summary = copy ? copy.summary : message;
  const lines = [`error: ${summary}`];
  const hintText = hint ?? copy?.hint;
  if (hintText) lines.push(`hint: ${hintText}`);
  if (message && message !== summary) lines.push(`details: ${message}`);
  return lines.join("\n");
}

/**
 * daemon 的结构化错误 → 与 CLI 失败同样的 Error。
 *
 * `stderr` 赋成 human 文本、`stdout` 留空，与 `bsk <cmd> --quiet` 失败时的子进程错误同形；
 * 另外挂上 `bskCode`/`bskData` 供日志与单测直接取用（CLI 路径没有这两个字段，
 * 所以没有任何消费方会依赖它们）。
 */
export function ipcErrorToCliError(err: BskIpcRpcError): Error {
  const text = renderCliErrorText(err.code, err.message);
  const out = new Error(text) as Error & {
    stderr?: string;
    stdout?: string;
    bskCode?: string;
    bskData?: unknown;
  };
  out.stderr = text;
  out.stdout = "";
  out.bskCode = err.code;
  out.bskData = err.data;
  return out;
}

/**
 * 「请求已发出但结果没拿到」（超时、连接断了）→ 与 CLI 超时同样的 Error。
 *
 * 关键用途：**改动型命令不能退回 CLI 重发**（动作可能已经生效），所以这条路要用
 * 一条和 CLI 超时等价的失败把结论交给上层，而不是静默重试。
 */
export function ipcTimeoutToCliError(method: string, detail: string): Error {
  const text =
    renderCliErrorText("timeout", `IPC 调用未拿到结果：${method}（${detail}）`) +
    "\n（该动作可能已在页面生效：不要盲目重发，先重新观察页面）";
  const out = new Error(text) as Error & { stderr?: string; stdout?: string; bskCode?: string };
  out.stderr = text;
  out.stdout = "";
  out.bskCode = "timeout";
  return out;
}

/**
 * 协议漂移：对面根本不认这个方法 → 必然是我们的映射过时了，退回 CLI 重来一次是正确处置。
 *
 * 刻意**只认 `unknown_method`**：`invalid_params` 也可能是真实的工具错误
 * （例如对不可填的元素调 fill），把它当成漂移会导致「同一动作再跑一次」——
 * 那正是改动型命令最不能发生的事（见 IpcPlan.mutating）。
 */
export function isProtocolDrift(err: BskIpcRpcError): boolean {
  return err.code === "unknown_method";
}
