/**
 * session 存档层：把一次 agent 运行的「输入参数 + 完整交互」持久化，供 `pageqa sessions`
 * 查询服务回看。
 *
 * 为什么需要它：出问题时能看到多少现场，决定了能不能查下去。「模型为什么点错了元素」
 * 「为什么只跑了两步就收尾」「这一轮到底把多少上下文交给了模型」——这些问题的答案全在
 * 「传给 agent 的参数」与「每次工具调用的入参/结果」里，而默认日志只留下了工具名与一行
 * 失败原因（见 log.ts 的口径：stderr 是给人看的进度，不是档案），`--debug` 也只够眼看着
 * 滚过去、事后无从翻查。
 *
 * 存储走 pi 官方的 SQLite session 后端（`@earendil-works/pi-session-backend-sqlite-node`），
 * 全部运行落在 `~/.pageqa/sessions/sessions.sqlite` 这一个容器里：
 * - 一次运行 = 一个 Session（id 就是运行 id）；
 * - 参数快照、列表摘要与终态 = Session 的 `Value`（命名空间 `pageqa`）；
 * - 每轮上下文与每次工具调用 = Session 的 `ValueList`。
 *
 * 用它的 `Value`/`ValueList`、而不是继续自造 JSON 文件，换来的是：**事务写入**（一次运行
 * 的参数/轮次/工具调用要么整条落库、要么一条都不落，不会留下半截档案）、schema 迁移由
 * 后端负责、以及不必再自己维护「一运行两个文件 + 清理」这套文件账。
 *
 * 刻意**没有**用它的 Branch / Entry / fork 等会话语义：我们记的是运行档案（只写一次、
 * 之后只读），不是可续跑的对话；把档案塞进对话树只会让两边都别扭。
 *
 * 采集与落盘**绝不影响测试结论**：它是一次旁路记录，写失败只提示、不改退出码
 * （与 side-outputs.ts 同一条口径）。因此 `SessionCollector` 的方法都不抛错。
 */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  appendList,
  BACKGROUND_CONTEXT,
  list,
  sessionName,
  setValue,
  value,
  type Context,
} from "@earendil-works/pi-agent-core";
import {
  createNodeSqliteFactory,
  SqliteSessionRepo,
} from "@earendil-works/pi-session-backend-sqlite-node";
import { CONFIG_DIR } from "./config.js";
import type { RawUsage, TokenUsage } from "./report.js";

/** 存档默认目录：与配置同处 `~/.pageqa` 下，不随工作目录漂移（跨项目也要能查到）。 */
export const SESSIONS_DIR = join(CONFIG_DIR, "sessions");

/** 单容器数据库文件名：所有运行都在这一个 SQLite 文件里（同目录还会出现它的 -wal/-shm）。 */
export const SESSIONS_DATABASE = "sessions.sqlite";

/**
 * 存档结构标识与版本。
 *
 * 与容器自身的 schema 版本（后端管的 `storageVersion`）是两件事：这个版本说的是
 * 「`pageqa` 命名空间下那几份 Value/ValueList 的形状」。改动它们的字段时递增，
 * 读端据此拒绝比自己新的档案，而不是把字段对不上的档案当成能读的。
 */
export const SESSION_FORMAT = "pageqa-session";
export const SESSION_VERSION = 1;

/** 存档在 Session 里占用的命名空间与键名（改名等于换存档格式，需同步 SESSION_VERSION）。 */
const NS = "pageqa";
const K_PARAMS = "params";
const K_SUMMARY = "summary";
const K_RESULT = "result";
const K_TURNS = "turns";
const K_TOOLS = "toolCalls";

/**
 * 单段文本的保存上限（消息、工具结果、系统提示）。
 *
 * 一份长流程的上下文里，页面快照动辄几千字符；不设上限的话，一次运行的存档会有几十 MB，
 * 查询服务与编辑器都打不开。截断处会标注原始长度，所以「被截了多少」本身也看得见。
 */
export const MAX_TEXT_CHARS = 4_000;

/** 列表页保留的存档条数上限（超出时删最旧的；0 表示不清理）。 */
export const DEFAULT_KEEP_SESSIONS = 200;

/** 本次运行展开占位符用的取值（脱去 vars.ts 的内部字段，存档自成一个稳定契约）。 */
export interface SessionVar {
  name: string;
  placeholder: string;
  value: string;
}

/** 一个工具以 JSON Schema 形式发给模型的声明。 */
export interface SessionToolSpec {
  name: string;
  label?: string;
  description?: string;
  /** 参数 JSON Schema（原样保存，供排查「模型是不是被 schema 误导了」）。 */
  parameters?: unknown;
}

/** 运行开始时交给 agent 的全部参数。 */
export interface SessionParams {
  /** 系统提示词全文（默认提示或调用方覆盖的那份）。 */
  systemPrompt: string;
  /** 模型选择（provider + 模型 id）。 */
  model: { provider: string; id: string };
  /** 工具声明。 */
  tools: SessionToolSpec[];
  /** 首次下发的用例 prompt（已按步骤编号，即模型真正看到的那份）。 */
  prompt: string;
  /** 用例原文（未编号）。 */
  caseText: string;
  /** 编号后的步骤清单。 */
  steps: string[];
  /** bsk session id（浏览器会话）。 */
  bskSession?: string;
  /** 场景名（套件模式下由 `## 场景名` 提供）。 */
  scenarioName?: string;
  /** 本次运行展开占位符的取值。 */
  vars: SessionVar[];
  /** 是否处于 `--debug`。 */
  debug: boolean;
}

/** 一条消息在「这一轮实际发给模型的上下文」里的样子（长文本已截断）。 */
export interface SessionMessage {
  role: string;
  /** 可读文本（文本块拼接、工具调用与结果各自成一行的摘要）。 */
  text: string;
  /** 截断前的原始字符数。 */
  chars: number;
  /** 是否被截断。 */
  truncated?: boolean;
  /** 工具结果所属的工具名（有则带上）。 */
  toolName?: string;
}

/** 一轮 LLM 调用：耗时、用量，以及该轮请求**实际发出**的上下文。 */
export interface SessionTurn {
  /** 第几轮（1 起）。 */
  index: number;
  startedAt: number;
  durationMs: number;
  /** 该轮增量用量（端点没给就为空）。 */
  usage?: RawUsage;
  /** 该轮上下文的消息摘要（transformContext 之后的版本，即模型真正看到的）。 */
  context: SessionMessage[];
  /** 该轮上下文的原始字符总数（裁剪前）。 */
  contextCharsBefore?: number;
}

/** 一次工具调用：模型给的入参、工具返回的结果或失败原因、耗时。 */
export interface SessionToolCall {
  /** 第几次（1 起，按开始顺序）。 */
  index: number;
  toolCallId: string;
  name: string;
  /** 模型给出的入参。 */
  args: unknown;
  /** 是否成功。 */
  ok: boolean;
  /** 结果文本（失败时是失败原因）；已截断。 */
  result?: string;
  /** 结果的原始字符数。 */
  resultChars?: number;
  resultTruncated?: boolean;
  startedAt: number;
  durationMs: number;
}

/** 一份完整存档。 */
export interface SessionArchive {
  format: typeof SESSION_FORMAT;
  version: number;
  /** 运行 id（同时是文件名）。 */
  id: string;
  startedAt: string;
  endedAt?: string;
  /** 终态（正常收尾时写入）。 */
  status?: "pass" | "fail" | "cancelled";
  /** 归因说明（模型报错、被中止等），供列表与详情直接显示。 */
  note?: string;
  params: SessionParams;
  turns: SessionTurn[];
  toolCalls: SessionToolCall[];
  /** 本次运行总用量。 */
  usage?: TokenUsage;
}

/** 列表页用的摘要（`<id>.meta.json` 的内容）。 */
export interface SessionSummary {
  id: string;
  startedAt: string;
  endedAt?: string;
  status?: string;
  scenarioName?: string;
  /** 用例单行预览。 */
  casePreview: string;
  /** `provider/model`。 */
  model: string;
  /** 步骤数。 */
  steps: number;
  toolCalls: number;
  turns: number;
  /** 调用过模型则为 true（用于区分「一条都没跑」的存档）。 */
  called: boolean;
}

/** 把长文本压到上限内；返回值同时带上原始长度，便于在界面上如实标注「截断了多少」。 */
export function clipText(
  text: string,
  max: number = MAX_TEXT_CHARS,
): { text: string; chars: number; truncated?: boolean } {
  if (text.length <= max) return { text, chars: text.length };
  return { text: text.slice(0, max), chars: text.length, truncated: true };
}

/** 取消息里的文本块（字符串 content 或 content 数组里的 text 块）。 */
function partsText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const out: string[] = [];
  for (const part of content as {
    type?: string;
    text?: string;
    name?: string;
    arguments?: unknown;
  }[]) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "text" && typeof part.text === "string") {
      out.push(part.text);
    } else if (part.type === "toolCall") {
      // 工具调用本身也是模型「说了什么」的一部分：入参是排查点错元素的第一手材料，
      // 因此转成一行可读文本保留下来，而不是当作非文本块丢掉。
      out.push(
        `[toolCall] ${part.name ?? "?"} ${
          part.arguments === undefined ? "" : safeJson(part.arguments)
        }`,
      );
    }
  }
  return out.join("\n");
}

/** 安全地 JSON 化（循环引用等极端情况不该让存档采集本身抛错）。 */
function safeJson(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** 把一条 AgentMessage 压成可读摘要。 */
export function summarizeMessage(message: unknown): SessionMessage {
  const m = (message ?? {}) as {
    role?: unknown;
    content?: unknown;
    toolName?: unknown;
    stopReason?: unknown;
  };
  const role = typeof m.role === "string" ? m.role : "unknown";
  const raw = partsText(m.content);
  const clipped = clipText(raw);
  const toolName = typeof m.toolName === "string" ? m.toolName : undefined;
  // 中止/报错轮次的 stopReason 是「这次为什么没跑完」的直接证据，不能丢。
  const stop =
    m.stopReason === "error" || m.stopReason === "aborted"
      ? `[stopReason=${String(m.stopReason)}]`
      : "";
  const suffix = stop ? (clipped.text ? `\n${stop}` : stop) : "";
  return {
    role,
    text: clipped.text + suffix,
    chars: clipped.chars,
    ...(clipped.truncated ? { truncated: true } : {}),
    ...(toolName ? { toolName } : {}),
  };
}

/** 批量摘要（一次 LLM 请求的上下文）。 */
export function summarizeMessages(messages: readonly unknown[]): SessionMessage[] {
  return messages.map((m) => summarizeMessage(m));
}

/** 生成一个运行 id：`yyyyMMdd-HHmmss-<4 位随机>`（可读、可排序，且同秒内不撞名）。 */
export function newSessionId(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `${stamp}-${randomBytes(2).toString("hex")}`;
}

/**
 * 采集器：在运行过程中逐条记录轮次与工具调用。
 *
 * 时间点由调用方注入（与 timing.ts 同一条理由）：采集逻辑因此是纯的，可以单测。
 * 所有方法都不抛错——采集出问题不该影响这一次测试。
 */
export class SessionCollector {
  private readonly archive: SessionArchive;
  private readonly now: () => number;
  private readonly maxText: number;
  private turnIndex = 0;
  private toolIndex = 0;
  private pendingTurn: {
    startedAt: number;
    context?: SessionMessage[];
    charsBefore?: number;
  } | null = null;
  private readonly openTools = new Map<string, { index: number; startedAt: number }>();

  constructor(
    params: SessionParams,
    opts: { id?: string; now?: () => number; maxText?: number } = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.maxText = opts.maxText ?? MAX_TEXT_CHARS;
    this.archive = {
      format: SESSION_FORMAT,
      version: SESSION_VERSION,
      id: opts.id ?? newSessionId(new Date(this.now())),
      startedAt: new Date(this.now()).toISOString(),
      params,
      turns: [],
      toolCalls: [],
    };
  }

  /** 当前存档（只读视图；落盘时原样序列化）。 */
  get data(): SessionArchive {
    return this.archive;
  }

  /**
   * `turn_start`：开一轮，记下起点。
   *
   * 若本轮上下文已经先被采集（`transformContext` 与 `turn_start` 的先后由 agent 内部
   * 决定，不是我们能约定的），这里要**保留**它——覆盖掉就等于丢掉了「这一轮模型到底
   * 看到了什么」，而那正是存档存在的理由。
   */
  noteTurnStart(): void {
    const startedAt = this.now();
    this.pendingTurn = this.pendingTurn
      ? { ...this.pendingTurn, startedAt }
      : { startedAt };
  }

  /**
   * 记录本轮**实际发给模型**的上下文。
   *
   * 由 agent 的 `transformContext` 钩子在每次 LLM 请求前调用——那里拿到的就是裁剪后
   * 真正要发出去的 messages，因此能如实回答「模型这一轮看到了什么、被裁掉了多少」。
   */
  noteTurnContext(messages: readonly unknown[], charsBefore?: number): void {
    if (!this.pendingTurn) this.pendingTurn = { startedAt: this.now() };
    this.pendingTurn.context = summarizeMessages(messages);
    if (charsBefore !== undefined) this.pendingTurn.charsBefore = charsBefore;
  }

  /** `turn_end`：收一轮，落一条轮次记录。 */
  noteTurnEnd(usage?: RawUsage | null): void {
    const startedAt = this.pendingTurn?.startedAt ?? this.now();
    const ended = this.now();
    this.turnIndex += 1;
    const charsBefore = this.pendingTurn?.charsBefore;
    const turn: SessionTurn = {
      index: this.turnIndex,
      startedAt,
      durationMs: Math.max(0, ended - startedAt),
      context: this.pendingTurn?.context ?? [],
      ...(usage ? { usage } : {}),
      ...(charsBefore !== undefined ? { contextCharsBefore: charsBefore } : {}),
    };
    this.archive.turns.push(turn);
    this.pendingTurn = null;
  }

  /** `tool_execution_start`：记下入参与起点。 */
  noteToolStart(toolCallId: string, name: string, args: unknown): void {
    this.toolIndex += 1;
    this.openTools.set(toolCallId, { index: this.toolIndex, startedAt: this.now() });
    this.archive.toolCalls.push({
      index: this.toolIndex,
      toolCallId,
      name,
      args,
      ok: false,
      startedAt: this.now(),
      durationMs: 0,
    });
  }

  /** `tool_execution_end`：补上结果与耗时。 */
  noteToolEnd(toolCallId: string, ok: boolean, resultText: string): void {
    const call = this.archive.toolCalls.find((c) => c.toolCallId === toolCallId);
    if (!call) return;
    const open = this.openTools.get(toolCallId);
    const clipped = clipText(resultText, this.maxText);
    call.ok = ok;
    call.result = clipped.text;
    call.resultChars = clipped.chars;
    if (clipped.truncated) call.resultTruncated = true;
    if (open) {
      call.durationMs = Math.max(0, this.now() - open.startedAt);
      this.openTools.delete(toolCallId);
    }
  }

  /** 收尾：写入终态与总用量，返回完整存档。 */
  finish(input: {
    status?: "pass" | "fail" | "cancelled";
    note?: string;
    usage?: TokenUsage;
  }): SessionArchive {
    this.archive.endedAt = new Date(this.now()).toISOString();
    if (input.status) this.archive.status = input.status;
    if (input.note) this.archive.note = input.note;
    if (input.usage) this.archive.usage = input.usage;
    return this.archive;
  }
}

/** 存档容器的完整路径（`pageqa sessions --dir` 指向的就是它的所在目录）。 */
export function databasePath(dir: string = SESSIONS_DIR): string {
  return join(dir, SESSIONS_DATABASE);
}

/**
 * 开一个仓库、跑一段操作、**必定关闭**它。
 *
 * 读写都走这一个口子：`SqliteSessionRepo` 持有数据库句柄（单容器模式下就是同一个文件），
 * 忘了关会一直占着它——查询服务是常驻进程，跑一次用例又是另一个进程，句柄漏出去的代价
 * 是下一方打不开。因此这里用 finally 兜底，而不是指望每个调用点自己记得。
 */
async function withRepo<T>(
  dir: string,
  fn: (repo: SqliteSessionRepo, ctx: Context) => Promise<T>,
): Promise<T> {
  const repo = new SqliteSessionRepo({
    directory: dir,
    // 单容器：所有运行共用一个 .sqlite，列表与详情都不必逐个文件去开。
    databasePath: databasePath(dir),
    databaseFactory: createNodeSqliteFactory(),
  });
  try {
    return await fn(repo, BACKGROUND_CONTEXT);
  } finally {
    await repo.close(BACKGROUND_CONTEXT);
  }
}

/**
 * id 只允许 `[A-Za-z0-9._-]`：它既是 Session 的 id，也是查询服务 URL 的一部分。
 *
 * 存储换成 SQLite 之后它不再被拼进文件路径，但校验照旧：`pageqa sessions` 接的是浏览器
 * 请求，让任意字符串进到「按 id 取一条记录」这条路里没有任何好处。
 */
export function assertSafeId(id: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(id) || id.includes("..")) {
    throw new Error(`非法的 session id：${id}`);
  }
  return id;
}

/** 从完整存档派生列表摘要。 */
export function summarizeArchive(archive: SessionArchive): SessionSummary {
  const oneLine = archive.params.caseText.replace(/\s+/g, " ").trim();
  return {
    id: archive.id,
    startedAt: archive.startedAt,
    ...(archive.endedAt ? { endedAt: archive.endedAt } : {}),
    ...(archive.status ? { status: archive.status } : {}),
    ...(archive.params.scenarioName ? { scenarioName: archive.params.scenarioName } : {}),
    casePreview: oneLine.length > 120 ? oneLine.slice(0, 120) + "…" : oneLine,
    model: `${archive.params.model.provider}/${archive.params.model.id}`,
    steps: archive.params.steps.length,
    toolCalls: archive.toolCalls.length,
    turns: archive.turns.length,
    called: archive.turns.length > 0,
  };
}

/** 终态与总量（存在 Session 的 `result` 值里；`startedAt` 也放这里，让档案自描述）。 */
interface ResultPayload {
  startedAt: string;
  endedAt?: string;
  status?: SessionArchive["status"];
  note?: string;
  usage?: TokenUsage;
}

/** 容器里一条 Session 的元数据（`open` 要的是它，而不是光一个 id）。 */
type SessionMeta = Awaited<ReturnType<SqliteSessionRepo["list"]>>[number];

/** 按 id 找元数据；找不到就抛出（调用方决定是翻成 404 还是跳过）。 */
async function findMeta(
  repo: SqliteSessionRepo,
  ctx: Context,
  id: string,
): Promise<SessionMeta> {
  const meta = (await repo.list(undefined, ctx)).find((m) => m.id === id);
  if (!meta) throw new Error(`找不到运行存档：${id}`);
  return meta;
}

/**
 * 落盘一份存档：参数、每轮上下文、每次工具调用、终态与列表摘要，**一次事务**写进去。
 *
 * 用一次 `commit` 而不是逐条 `setValue`/`appendList`，是为了让「这次运行的档案」要么整条
 * 可读、要么一条都不存在：中途失败留下的半截档案会让列表页列出一条点开却缺东西的记录
 * ——排查时最怕的正是这种「看着有、实际缺」。
 *
 * 任何失败都抛给调用方（由 agent 侧吞掉并记日志），失败语义与退出码无关。
 */
export async function writeArchive(
  archive: SessionArchive,
  dir: string = SESSIONS_DIR,
): Promise<string> {
  const summary = summarizeArchive(archive);
  const result: ResultPayload = {
    startedAt: archive.startedAt,
    ...(archive.endedAt ? { endedAt: archive.endedAt } : {}),
    ...(archive.status ? { status: archive.status } : {}),
    ...(archive.note ? { note: archive.note } : {}),
    ...(archive.usage ? { usage: archive.usage } : {}),
  };
  return await withRepo(dir, async (repo, ctx) => {
    const session = await repo.create({ id: archive.id }, ctx);
    try {
      const writes = [
        setValue(value(NS, K_PARAMS), archive.params),
        // 摘要单独存一份：列表页只取它，不必把每份档案的轮次与工具调用都读出来。
        setValue(value(NS, K_SUMMARY), summary),
        setValue(value(NS, K_RESULT), result),
        // `sessionName` 是后端的内置值（就是「会话名」）：点开一条空档案时，它至少还留着
        // 一行「这次跑的是哪条用例」的线索。
        setValue(sessionName, summary.casePreview),
        ...archive.turns.map((turn) => appendList(list(NS, K_TURNS), turn)),
        ...archive.toolCalls.map((call) => appendList(list(NS, K_TOOLS), call)),
      ];
      await session.mutate((mutator, inner) => mutator.commit(writes, inner), ctx);
    } finally {
      await session.close(ctx);
    }
    return databasePath(dir);
  });
}

/** 读一份完整存档；找不到或读不出来时抛错（调用方决定怎么呈现）。 */
export async function readArchive(
  id: string,
  dir: string = SESSIONS_DIR,
): Promise<SessionArchive> {
  assertSafeId(id);
  // 容器还不存在时直接报「没有这条」：`SqliteSessionRepo` 的 open 是**建库**打开，
  // 为了查一个不存在的 id 在磁盘上留一个空数据库，不是查询该有的副作用。
  if (!existsSync(databasePath(dir))) throw new Error(`找不到运行存档：${id}`);
  return await withRepo(dir, async (repo, ctx) => {
    const meta = await findMeta(repo, ctx, id);
    const session = await repo.open(meta, ctx);
    try {
      const storedParams = await session.getValue<SessionParams>(
        value(NS, K_PARAMS),
        ctx,
      );
      if (!storedParams) throw new Error(`运行存档缺少参数：${id}`);
      const turns = await session.readList<SessionTurn>(
        list(NS, K_TURNS),
        undefined,
        ctx,
      );
      const tools = await session.readList<SessionToolCall>(
        list(NS, K_TOOLS),
        undefined,
        ctx,
      );
      const payload = (
        await session.getValue<ResultPayload>(value(NS, K_RESULT), ctx)
      )?.value;
      return {
        format: SESSION_FORMAT,
        version: SESSION_VERSION,
        id,
        // 终态里有更准的开始时间（采集器建档案的那一刻）；没有就退回 Session 的创建时间。
        startedAt: payload?.startedAt ?? new Date(meta.createdAt).toISOString(),
        ...(payload?.endedAt ? { endedAt: payload.endedAt } : {}),
        ...(payload?.status ? { status: payload.status } : {}),
        ...(payload?.note ? { note: payload.note } : {}),
        ...(payload?.usage ? { usage: payload.usage } : {}),
        params: storedParams.value,
        turns: turns.map((row) => row.value),
        toolCalls: tools.map((row) => row.value),
      };
    } finally {
      await session.close(ctx);
    }
  });
}

/**
 * 列出全部存档摘要，按开始时间**倒序**（同一时刻的按 id 兜底）。
 *
 * 摘要存在每条 Session 自己的 `summary` 值里，所以列表要逐个 open 去取——单容器模式下
 * 每次 open 只是同一个文件上的一次读，代价远小于「为列一屏条目把每份档案的轮次与工具
 * 调用全读出来」。取不到摘要的 Session（写了一半、或别的程序往同一容器里塞过东西）直接
 * 跳过：列出一条点开缺东西的记录，比少列一条更糟。
 */
export async function listArchives(
  dir: string = SESSIONS_DIR,
): Promise<SessionSummary[]> {
  // 目录或容器还不存在时不去开仓库：`SqliteSessionRepo` 会顺手把容器建出来，而
  // 「看一眼列表」不该在磁盘上留下一个新数据库文件。
  if (!existsSync(databasePath(dir))) return [];
  const found = await withRepo(dir, async (repo, ctx) => {
    const out: SessionSummary[] = [];
    for (const meta of await repo.list(undefined, ctx)) {
      try {
        const session = await repo.open(meta, ctx);
        try {
          const stored = await session.getValue<SessionSummary>(
            value(NS, K_SUMMARY),
            ctx,
          );
          if (stored?.value && typeof stored.value.id === "string") {
            out.push(stored.value);
          }
        } finally {
          await session.close(ctx);
        }
      } catch {
        // 单条读不出来就跳过它，别让一条坏记录拖垮整个列表页。
      }
    }
    return out;
  });
  return found.sort((a, b) =>
    a.startedAt === b.startedAt
      ? b.id.localeCompare(a.id)
      : b.startedAt.localeCompare(a.startedAt),
  );
}

/**
 * 清掉超出上限的旧存档（保留最近 keep 条，按容器里的创建时间倒序数）。
 *
 * 返回实际删掉的条数。**不抛错**：清理是维护动作，它失败不该冒泡成「这次运行出错了」；
 * 真失败的后果只是磁盘上多留几条旧档案。
 */
export async function pruneArchives(
  dir: string = SESSIONS_DIR,
  keep = DEFAULT_KEEP_SESSIONS,
): Promise<number> {
  if (keep <= 0 || !existsSync(databasePath(dir))) return 0;
  try {
    return await withRepo(dir, async (repo, ctx) => {
      const metas = (await repo.list(undefined, ctx)).sort(
        (a, b) => b.createdAt - a.createdAt,
      );
      let removed = 0;
      for (const meta of metas.slice(keep)) {
        await repo.delete(meta, ctx);
        removed += 1;
      }
      return removed;
    });
  } catch {
    return 0;
  }
}
