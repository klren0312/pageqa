import { execFile, execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { JevClient } from "../jev.js";
import { debugLog, info, timer } from "../log.js";

/**
 * browserskill（`bsk`）工具层：把 bsk CLI 命令包装成 pi-agent-core 的 AgentTool。
 *
 * bsk 连接一个已运行的真实浏览器，每个命令都需要 --session <id>。
 * 所有命令以 --quiet 抑制进度输出，仅返回结构化/可读结果。
 *
 * 分两层：
 * - `createBskOps`（操作层）：每次浏览器操作 = 一条 bsk 命令，返回可读结果。
 * - `createBskTools`（工具层）：把操作层包成 agent 可调用的工具，并上报每次执行为录制提供素材。
 * 回放（replay.ts）直接用操作层，因此「录制时怎么操作」与「回放时怎么操作」是同一条命令路径。
 */

const BSK_TIMEOUT_MS = 60_000;

function bsk(args: string[]): string {
  // 调试模式打印每条 bsk 命令，便于定位「卡在哪条命令」；
  // execFileSync 是阻塞的，所以命令执行期间不会再有其它的日志。
  const done = timer();
  debugLog("[bsk] $ bsk " + args.join(" "));
  try {
    const out = execFileSync("bsk", args, {
      encoding: "utf-8",
      timeout: BSK_TIMEOUT_MS,
      windowsHide: true,
    }).toString();
    debugLog(`[bsk] $ bsk ${args[0] ?? ""} 完成（${done()}ms）`);
    return out;
  } catch (err) {
    debugLog(`[bsk] $ bsk ${args[0] ?? ""} 失败（${done()}ms）`);
    const e = err as { code?: string; signal?: string };
    if (e.code === "ENOENT") {
      throw new Error(
        "未找到 bsk 命令：请先安装 browserskill 并确认 bsk 在 PATH 中",
      );
    }
    if (e.code === "ETIMEDOUT" || e.signal === "SIGTERM") {
      throw new Error(
        `bsk 命令执行超时（${BSK_TIMEOUT_MS / 1000}s）：可能 bsk daemon 未启动或未连接浏览器。` +
          `请先运行 \`bsk session start\` 并确认浏览器已连接，再重试。命令：bsk ${args.join(" ")}`,
      );
    }
    throw err;
  }
}

/**
 * `bsk status --json` 的异步版本。
 *
 * 与同步版返回语义一致：daemon 未运行/解析失败返回 null；bsk 未安装（ENOENT）抛出致命错误。
 * 用于 daemon 启动轮询：轮询期间必须让出事件循环，否则同步子进程调用会阻塞
 * 整个进程，导致启动等待期（最长 30s）无法响应 Ctrl+C 等信号。
 */
function bskStatusJsonAsync(): Promise<unknown | null> {
  return new Promise((resolve, reject) => {
    execFile(
      "bsk",
      ["status", "--json"],
      { encoding: "utf-8", timeout: BSK_TIMEOUT_MS, windowsHide: true },
      (err, stdout) => {
        if (err) {
          const e = err as { code?: string };
          if (e.code === "ENOENT") {
            reject(
              new Error(
                "未找到 bsk 命令：请先安装 browserskill 并确认 bsk 在 PATH 中",
              ),
            );
            return;
          }
          resolve(null);
          return;
        }
        try {
          resolve(JSON.parse(stdout) as unknown);
        } catch {
          resolve(null);
        }
      },
    );
  });
}

/** 当前是否已连接至少一个浏览器（从 status 解析，异步）。 */
async function connectedBrowserCount(): Promise<number> {
  const status = (await bskStatusJsonAsync()) as { browsers?: unknown[] } | null;
  if (!status || !Array.isArray(status.browsers)) return 0;
  return status.browsers.length;
}

/** 后台启动 bsk daemon（bsk daemon start 是前台阻塞的，必须 detached 启动后轮询等待就绪）。 */
function startDaemon(): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    info("[pageqa] bsk daemon 未运行，正在后台启动（首次可能需数秒）…");
    const child = spawn("bsk", ["daemon", "start"], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();

    const deadline = Date.now() + 30_000;
    const poll = async () => {
      try {
        if (child.exitCode !== null && child.exitCode !== 0) {
          reject(new Error(`bsk daemon 启动失败，退出码 ${child.exitCode}`));
          return;
        }
      } catch {
        // 子进程状态读取失败，继续轮询
      }
      let status: unknown | null;
      try {
        status = await bskStatusJsonAsync();
      } catch (err) {
        // bsk 未安装（ENOENT）：致命错误，直接失败而不是空等 30s
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      if (status !== null) {
        info(
          `[pageqa] bsk daemon 已就绪（${((Date.now() - started) / 1000).toFixed(1)}s）`,
        );
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        reject(
          new Error(
            "bsk daemon 启动超时（30s），请检查 bsk 安装或手动运行 `bsk daemon start`",
          ),
        );
        return;
      }
      debugLog(
        `[bsk] 等待 daemon 就绪… ${((Date.now() - started) / 1000).toFixed(1)}s`,
      );
      setTimeout(poll, 500);
    };
    setTimeout(poll, 500);
  });
}

let readyPromise: Promise<void> | null = null;

/**
 * 自动确保 bsk 就绪：启动 daemon（若未运行）+ 校验浏览器连接（若未连则报错）。
 * 整个进程只真正执行一次（readyPromise 缓存）。
 */
export function ensureBskReady(): Promise<void> {
  if (readyPromise) return readyPromise;
  readyPromise = (async () => {
    debugLog("[bsk] 查询 daemon 状态…");
    if ((await bskStatusJsonAsync()) === null) {
      await startDaemon();
    } else {
      debugLog("[bsk] daemon 已在运行，跳过启动");
    }
    const n = await connectedBrowserCount();
    if (n === 0) {
      throw new Error(
        "bsk 未连接任何浏览器：pageqa 无法自动连接物理浏览器。\n" +
          "请在浏览器中安装 bsk 扩展并完成连接（或运行 `bsk session start` 按其提示连接），再重试。",
      );
    }
    info(`[pageqa] bsk 已连接浏览器 ${n} 个`);
  })();
  return readyPromise;
}

/** 构造 AgentTool 标准的成功返回（含必填 details 字段）。 */
function ok(text: string) {
  return { content: [{ type: "text", text } as const], details: {} };
}

/**
 * 构造 AgentTool 的 parameters 声明。
 * pi-agent-core 的 parameters 类型与 JSON Schema 子集不完全兼容，
 * 这里集中做一次类型断言，避免在每个工具定义里重复 `as unknown as ...`。
 */
function paramsOf(
  properties: Record<string, unknown>,
  required: string[] = [],
): AgentTool["parameters"] {
  // SAFETY: pi-agent-core 的 AgentTool["parameters"] 类型是 JSON Schema 的受限子集，
  // 与这里构造的 {type, properties, required} 结构在运行时兼容，但静态类型无法推导，
  // 因此集中在此处断言一次（工具定义处不再重复断言）。
  return {
    type: "object",
    properties,
    required,
  } as unknown as AgentTool["parameters"];
}

/**
 * bsk 操作层：一次浏览器操作 = 一条 bsk 命令。
 *
 * `lastSnapshot()` 暴露「最近一次快照文本」：录制时用它把 `@eN` 解析成语义定位符
 * （`@eN` 只在那次快照内有效，不能直接写进回放脚本）。
 */
export interface BskOps {
  readonly session: string;
  /** 最近一次快照文本（每次 snapshot / assert_text 都会刷新）。 */
  lastSnapshot(): string;
  navigate(url: string): string;
  snapshot(): string;
  click(target: string): string;
  fill(target: string, value: string): string;
  upload(target: string | undefined, file: string): string;
  hover(target: string): string;
  scroll(target: string): string;
  wait(ms: number): string;
  /** 断言页面是否包含期望文本；Jev 可用时走语义判断，否则字符串包含。 */
  assertText(expectation: string): Promise<string>;
}

export function createBskOps(session: string, jevClient?: JevClient): BskOps {
  const quiet = ["--session", session, "--quiet"];
  let snapshotText = "";

  return {
    session,
    lastSnapshot: () => snapshotText,

    navigate(url: string): string {
      const out = bsk([
        "navigate",
        url,
        ...quiet,
        "--wait-until",
        "domcontentloaded",
      ]);
      return `已导航到 ${url}\n${out}`;
    },

    snapshot(): string {
      const out = bsk(["snapshot", ...quiet]);
      snapshotText = out;
      // 快照体积直接决定上下文压力（长流程易因上下文超限被中断）
      debugLog("[bsk] snapshot 字符数=" + out.length);
      return out;
    },

    click(target: string): string {
      const out = bsk(["click", target, ...quiet]);
      return `已点击 ${target}\n${out}`;
    },

    fill(target: string, value: string): string {
      const out = bsk(["fill", target, "--value", value, ...quiet]);
      return `已在 ${target} 填入文本\n${out}`;
    },

    upload(target: string | undefined, file: string): string {
      if (!existsSync(file)) {
        throw new Error(`待上传文件不存在：${file}`);
      }
      const args = ["upload"];
      if (target) args.push(target);
      args.push("--file", file, ...quiet);
      const out = bsk(args);
      return `已上传文件 ${file}\n${out}`;
    },

    hover(target: string): string {
      const out = bsk(["hover", target, ...quiet]);
      return `已悬停 ${target}\n${out}`;
    },

    scroll(target: string): string {
      // scroll-to 同时支持 @eN 引用与 CSS 选择器。
      // （早期实现用 evaluate + querySelector，遇到 @eN 会静默返回 element-not-found。）
      const out = bsk(["scroll-to", target, ...quiet]);
      return `已滚动到 ${target}\n${out}`;
    },

    wait(ms: number): string {
      // wait-ms 是 daemon 端 sleep，不接受 --session
      bsk(["wait-ms", String(ms)]);
      return `已等待 ${ms}ms`;
    },

    async assertText(expectation: string): Promise<string> {
      const snap = bsk(["snapshot", ...quiet]);
      snapshotText = snap;
      const evidence = (verdict: string, why: string) =>
        `断言「${expectation}」：${verdict}。${why}`;

      // 防御：快照为空或明显不是已加载页面 → 断言不成立。
      // 浏览器页面还没打开时，bsk 返回的是空串/about:blank/错误信息，
      // 此时不应信任 Jev 或直接判定「成立」（空页面不可能包含断言文本）。
      const snapLen = snap.trim().length;
      const SNAP_MIN_LEN = 30;
      if (snapLen < SNAP_MIN_LEN) {
        return evidence(
          "不成立",
          `证据：页面快照为空或过短（${snapLen} 字符），页面可能尚未打开或未导航`,
        );
      }

      // 当 Jev 客户端可用时，使用语义判断替代字符串包含匹配
      if (jevClient?.enabled) {
        try {
          const prob = await jevClient.assertText(snap, expectation);
          const pass = prob >= jevClient.threshold;
          const verdict = pass ? "成立" : "不成立";
          const why = pass
            ? `语义匹配度 ${(prob * 100).toFixed(1)}%，超过阈值 ${(jevClient.threshold * 100).toFixed(0)}%`
            : `语义匹配度 ${(prob * 100).toFixed(1)}%，未达到阈值 ${(jevClient.threshold * 100).toFixed(0)}%`;
          return evidence(verdict, why);
        } catch (err) {
          // Jev 调用失败：回退到原有的字符串包含逻辑。
          // 必须记录失败原因（超时/鉴权/网络等），否则用户只看到「Jev 不可用，已回退」，
          // 却无法从 --debug 日志判断到底是哪一类故障。
          debugLog(
            "[bsk] Jev 断言失败，回退到字符串匹配：" +
              (err instanceof Error ? err.message : String(err)),
          );
          return stringAssert(snap, expectation) + "（Jev 不可用，已回退）";
        }
      }

      // 默认：字符串包含匹配
      return stringAssert(snap, expectation);
    },
  };
}

/** 字符串包含匹配（默认断言路径，也是 Jev 不可用时的回退）。 */
function stringAssert(snapshotText: string, expectation: string): string {
  const hit = snapshotText.includes(expectation);
  return `断言「${expectation}」：${hit ? "成立" : "不成立"}。${
    hit ? `页面中包含「${expectation}」` : `页面中未找到「${expectation}」`
  }`;
}

/** 工具层上报的一次执行（供录制回放脚本）。 */
export interface BskToolExec {
  /** 工具名。 */
  name: string;
  /** 模型给出的入参。 */
  params: Record<string, unknown>;
  /** bsk 是否成功（失败的尝试不会被录进回放脚本）。 */
  ok: boolean;
  /** 本次操作**之前**页面最后一次快照文本。 */
  lastSnapshot: string;
}

export interface BskToolOptions {
  session: string;
  jevClient?: JevClient;
  /** 每次工具执行后的回调（录制回放脚本用）。 */
  onExec?: (event: BskToolExec) => void;
}

/** 构造一组浏览器操作工具，供 page-test agent 调用。 */
export function createBskTools(opts: BskToolOptions): AgentTool[] {
  const ops = createBskOps(opts.session, opts.jevClient);

  /**
   * 统一包装一次工具执行：拿到结果后上报给录制器，失败时先上报再抛出
   * （抛出让 pi-agent-core 把该工具标记为错误，模型会据此重试）。
   */
  const exec = async (
    name: string,
    params: Record<string, unknown>,
    fn: () => string | Promise<string>,
  ) => {
    const before = ops.lastSnapshot();
    try {
      const text = await fn();
      opts.onExec?.({ name, params, ok: true, lastSnapshot: before });
      return ok(text);
    } catch (err) {
      opts.onExec?.({ name, params, ok: false, lastSnapshot: before });
      throw err;
    }
  };

  const navigate: AgentTool = {
    name: "navigate",
    label: "Navigate",
    description:
      "在浏览器标签页打开一个 URL（支持 http/https/about: 等）。导航完成后页面 DOM 就绪。",
    parameters: paramsOf({ url: { type: "string", description: "目标 URL" } }, [
      "url",
    ]),
    execute: async (_id: string, params: unknown) => {
      const p = params as NavParams;
      return exec("navigate", { url: p.url }, () => ops.navigate(p.url));
    },
  };

  const snapshot: AgentTool = {
    name: "snapshot",
    label: "Snapshot",
    description:
      "读取当前页面的 aria 语义树与可见文本（标题、段落、链接、按钮等）。用于读取内容、标题、文本并定位元素。",
    parameters: paramsOf({}),
    execute: async () =>
      exec("snapshot", {}, () => ops.snapshot()),
  };

  const click: AgentTool = {
    name: "click",
    label: "Click",
    description: "点击一个元素。可用快照里的 @eN 引用或 CSS 选择器。",
    parameters: paramsOf(
      { target: { type: "string", description: "@eN 引用或 CSS 选择器" } },
      ["target"],
    ),
    execute: async (_id: string, params: unknown) => {
      const p = params as TargetParams;
      return exec("click", { target: p.target }, () => ops.click(p.target));
    },
  };

  const fill: AgentTool = {
    name: "fill",
    label: "Fill",
    description: "在输入框/文本域中填入文本（会先清空原有内容）。",
    parameters: paramsOf(
      {
        target: { type: "string", description: "@eN 引用或 CSS 选择器" },
        value: { type: "string", description: "要输入的文本" },
      },
      ["target", "value"],
    ),
    execute: async (_id: string, params: unknown) => {
      const p = params as FillParams;
      return exec("fill", { target: p.target, value: p.value }, () =>
        ops.fill(p.target, p.value),
      );
    },
  };

  const upload: AgentTool = {
    name: "upload",
    label: "Upload",
    description:
      "上传本地文件到页面的文件输入框或上传区域（如 el-upload 的「Click to upload」按钮）。" +
      "target 传触发文件选择器的元素（@eN 或 CSS 选择器），也可直接传隐藏的 <input type=\"file\">；" +
      "不传 target 时 bsk 自动在页面中查找文件输入框。" +
      "注意：原生文件选择框无法被自动化点击，因此不要先 click 触发按钮再调用本工具，" +
      "直接调用 upload 并指定该按钮为 target 即可。",
    parameters: paramsOf(
      {
        target: {
          type: "string",
          description:
            "触发文件选择器的元素（@eN 引用或 CSS 选择器），或 file input 本身",
        },
        file: { type: "string", description: "待上传的本地文件绝对路径" },
      },
      ["file"],
    ),
    execute: async (_id: string, params: unknown) => {
      const p = params as UploadParams;
      return exec(
        "upload",
        p.target ? { target: p.target, file: p.file } : { file: p.file },
        () => ops.upload(p.target, p.file),
      );
    },
  };

  const hover: AgentTool = {
    name: "hover",
    label: "Hover",
    description: "悬停在一个元素上，用于触发悬停菜单/提示。",
    parameters: paramsOf(
      { target: { type: "string", description: "@eN 引用或 CSS 选择器" } },
      ["target"],
    ),
    execute: async (_id: string, params: unknown) => {
      const p = params as TargetParams;
      return exec("hover", { target: p.target }, () => ops.hover(p.target));
    },
  };

  const scroll: AgentTool = {
    name: "scroll",
    label: "Scroll",
    description: "滚动到指定元素使其进入视口。",
    parameters: paramsOf(
      { target: { type: "string", description: "@eN 引用或 CSS 选择器" } },
      ["target"],
    ),
    execute: async (_id: string, params: unknown) => {
      const p = params as TargetParams;
      return exec("scroll", { target: p.target }, () => ops.scroll(p.target));
    },
  };

  const wait: AgentTool = {
    name: "wait",
    label: "Wait",
    description: "等待一段时间（毫秒）或等待页面导航完成。",
    parameters: paramsOf({ ms: { type: "number", description: "等待毫秒数" } }),
    execute: async (_id: string, params: unknown) => {
      const p = (params as WaitParams) ?? {};
      const ms = p.ms ?? 1000;
      return exec("wait", { ms }, () => ops.wait(ms));
    },
  };

  const assertText: AgentTool = {
    name: "assert_text",
    label: "Assert Text",
    description:
      "断言当前页面是否包含指定文本。返回「成立」或「不成立」并附上证据（命中片段）。用于校验测试结果。",
    parameters: paramsOf(
      {
        expectation: { type: "string", description: "期望在页面中出现的文本" },
      },
      ["expectation"],
    ),
    execute: async (_id: string, params: unknown) => {
      const p = params as ExpectParams;
      return exec("assert_text", { expectation: p.expectation }, () =>
        ops.assertText(p.expectation),
      );
    },
  };

  return [
    navigate,
    snapshot,
    click,
    fill,
    upload,
    hover,
    scroll,
    wait,
    assertText,
  ];
}

interface NavParams {
  url: string;
}
interface TargetParams {
  target: string;
}
interface FillParams {
  target: string;
  value: string;
}
interface UploadParams {
  target?: string;
  file: string;
}
interface WaitParams {
  ms?: number;
}
interface ExpectParams {
  expectation: string;
}

/** 创建一个 bsk session；若已提供且仍在活跃列表中则复用，否则新建。 */
export function ensureSession(existing?: string): string {
  if (existing && isActiveSession(existing)) {
    debugLog(`[bsk] 复用已存在的 session ${existing}`);
    return existing;
  }
  debugLog("[bsk] 创建新的 session…");
  const out = bsk(["session", "start", "--json"]);
  try {
    const json = JSON.parse(out);
    if (json?.session_id) return json.session_id;
  } catch {
    const m = out.match(/session_id["\s:]+([a-z0-9]+)/i);
    if (m) return m[1];
  }
  throw new Error("无法创建 bsk session，请确认 bsk daemon 已连接浏览器。");
}

/**
 * 关闭本次运行用过的 bsk session：bsk 会随之销毁该 session 的 Agent Window，
 * 即自动化操作的那个浏览器窗口，并归还借用过的用户标签页。
 *
 * 用例跑完（无论通过还是失败）都应调用，避免留下越来越多个浏览器窗口。
 * 清理失败只提示、不抛出：它不应该改变测试结论，也不该掩盖真正的失败原因。
 */
export function closeSession(session: string): void {
  const done = timer();
  try {
    debugLog(`[bsk] 关闭 session ${session}（同时关闭 Agent Window）…`);
    bsk(["session", "stop", session, "--quiet"]);
    debugLog(`[bsk] session ${session} 已关闭（${done()}ms）`);
    info(`[pageqa] 已关闭 bsk session=${session}（浏览器窗口已关闭）`);
  } catch (err) {
    info(
      `[pageqa] 关闭 bsk session=${session} 失败（不影响测试结论）：` +
        (err instanceof Error ? err.message : String(err)),
    );
  }
}

/** 检查给定 session 是否在 bsk 活跃列表里。 */
function isActiveSession(id: string): boolean {
  try {
    const out = bsk(["session", "list", "--json"]);
    const list = JSON.parse(out);
    if (Array.isArray(list)) return list.some((s) => s?.session_id === id);
  } catch {
    // 忽略解析错误
  }
  return false;
}
