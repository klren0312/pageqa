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
 * 存储走 pi 官方的 `@earendil-works/pi-durable`，全部运行落在
 * `~/.pageqa/sessions/sessions.sqlite` 这一个容器里。我们只用它的 **Session + 文档**这一层
 * （`createSession` + SQLite storage），不牵进 Harness / 模型 / 工具运行时——存档是旁路记录，
 * 不该把 agent 的执行引擎也拖进来：
 * - 一次运行 = 文档族 `pageqa.archive` 的一个成员，**键就是运行 id**（所以按 id 取存档是一次
 *   直接查表，不必扫一遍别的运行）；
 * - 列表页要的摘要 = 单例文档 `pageqa.index`，一次读就能列全，且不必把每份档案的轮次与工具
 *   调用都读出来。
 *
 * 一次运行就是**一次提交**：档案与索引要么一起落库、要么都不落，不会留下「列表上有、点开缺
 * 东西」的半截记录（排查时最怕的正是这种「看着有、实际缺」）。schema 版本与迁移交给文档定义
 * 自己管，我们只声明 `version`，字段形状变了递增 `SESSION_VERSION` 即可。
 *
 * 刻意**没有**用它的 Conversation / Entry / Task 等会话语义：那些是「可续跑的对话」，
 * 我们记的是运行档案（只写一次、之后只读），把档案塞进对话树只会让两边都别扭。
 *
 * 采集与落盘**绝不影响测试结论**：它是一次旁路记录，写失败只提示、不改退出码
 * （与 side-outputs.ts 同一条口径）。因此 `SessionCollector` 的方法都不抛错。
 */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createSession,
  defineDoc,
  defineDocFamily,
  type Session,
  type SessionDocToken,
  type SessionDocFamilyToken,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CONFIG_DIR } from "../config/config.js";
import { t } from "../shared/i18n.js";
import type { RawUsage, TokenUsage } from "../report/report.js";

/** 存档默认目录：与配置同处 `~/.pageqa` 下，不随工作目录漂移（跨项目也要能查到）。 */
export const SESSIONS_DIR = join(CONFIG_DIR, "sessions");

/** 单容器数据库文件名：所有运行都在这一个 SQLite 文件里（同目录还会出现它的 -wal/-shm）。 */
export const SESSIONS_DATABASE = "sessions.sqlite";

/**
 * 存档结构标识与版本。
 *
 * 与容器自身的 schema 版本（durable 管的存储版本）是两件事：这个版本说的是
 * 「`pageqa.archive` 文档与 `pageqa.index` 文档的形状」。改动它们的字段时递增，
 * 读端据此拒绝比自己新的档案，而不是把字段对不上的档案当成能读的。
 */
export const SESSION_FORMAT = "pageqa-session";
export const SESSION_VERSION = 1;

/**
 * 一份存档在 durable 里就是文档族 `pageqa.archive` 的一个成员，键为运行 id。
 *
 * 字段用 `JsonValue` 而不是直接用 `SessionArchive`：存档里有 `unknown`（工具入参、工具
 * schema），而 durable 的文档必须是纯 JSON。读写两端各过一次 `asJson`/`fromJson`，
 * 转换只发生在边界上，对外的类型仍然是 `SessionArchive`。
 */
type StoredArchive = {
  format: string;
  version: number;
  startedAt: string;
  endedAt?: string;
  status?: string;
  note?: string;
  params: JsonValue;
  turns: JsonValue;
  toolCalls: JsonValue;
  usage?: JsonValue;
};

/** 列表索引：按开始时间倒序的摘要（最新的一条在数组开头）。 */
type StoredIndex = {
  runs: JsonValue;
};

const ArchiveDoc: SessionDocFamilyToken<StoredArchive, StoredArchive> =
  defineDocFamily<StoredArchive, StoredArchive>({
    kind: "pageqa.archive",
    version: SESSION_VERSION,
    family: true,
    scope: "session",
    // 整份档案一次写入，之后只按 id 读回来，所以 seed 就是它本身。
    initial: (seed) => seed,
  });

const IndexDoc: SessionDocToken<StoredIndex> = defineDoc<StoredIndex>({
  kind: "pageqa.index",
  version: SESSION_VERSION,
  scope: "session",
  initial: () => ({ runs: [] }),
  // 索引每次写入都是整份重排。让它每次都存成完整基线，而不是攒一长串增量：
  // 索引很小（上限几百条摘要），攒增量只会让「读一次列表」越来越贵。
  checkpointWhen: () => true,
});

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
  /**
   * 本次运行的上下文决策（窗口多大、从哪来的、固定前缀压没压、为什么）。
   *
   * 单列出来是因为「模型怎么被对待的」在别的字段里看不出来：systemPrompt 与 tools 只显示
   * 结果（压缩版还是完整版），看不出**为什么**——而「我的小模型为什么没被当小模型对待」
   * 恰恰是最常被问到的问题。这里把依据（窗口来源、预算、压缩理由）一并留下。
   */
  context?: SessionContextInfo;
}

/** 上下文决策的可读快照（写进存档，见 {@link SessionParams.context}）。 */
export interface SessionContextInfo {
  /** 实际使用的窗口（token）。 */
  window: number;
  /** 窗口来自哪里：`config`（用户声明）/ `engine`（引擎自报）/ `metadata`（模型目录）/ `fallback`（保守兜底）。 */
  windowSource: "config" | "engine" | "metadata" | "fallback";
  /** 输入预算（`窗口 − 输出预留 − 安全边际`）。 */
  inputBudget: number;
  /** 输出预留（与请求里的 `max_tokens` 同源）。 */
  outputReserve: number;
  /** 是否压缩了固定前缀。 */
  compact: boolean;
  /** 压缩理由：`window` / `model` / `config` / `none`。 */
  compactReason: string;
  /** 小窗口下的单份快照字符预算（未缩放时为空 = 用默认值）。 */
  snapshotBudgetChars?: number;
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
  /**
   * 该轮上下文的原始 token 估算值（裁剪前）。
   *
   * 与字符数一并记：字符是旧口径（跨记录可比），token 才是与窗口对照的那个数
   * （`pageqa sessions` 里看到「裁剪前 9.8k token / 窗口 8k」就知道为什么会被裁）。
   */
  contextTokensBefore?: number;
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

/**
 * 列表页用的摘要（索引文档 `pageqa.index` 的一个元素）。
 *
 * 写成 `type` 而不是 `interface`：摘要要整体存进 durable 的 JSON 文档，而 TypeScript 只给
 * 对象**类型别名**隐式索引签名（interface 没有），否则 `SessionSummary[]` 存不进 `JsonValue`。
 */
export type SessionSummary = {
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
};

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
    tokensBefore?: number;
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
  noteTurnContext(
    messages: readonly unknown[],
    charsBefore?: number,
    tokensBefore?: number,
  ): void {
    if (!this.pendingTurn) this.pendingTurn = { startedAt: this.now() };
    this.pendingTurn.context = summarizeMessages(messages);
    if (charsBefore !== undefined) this.pendingTurn.charsBefore = charsBefore;
    if (tokensBefore !== undefined) this.pendingTurn.tokensBefore = tokensBefore;
  }

  /** `turn_end`：收一轮，落一条轮次记录。 */
  noteTurnEnd(usage?: RawUsage | null): void {
    const startedAt = this.pendingTurn?.startedAt ?? this.now();
    const ended = this.now();
    this.turnIndex += 1;
    const charsBefore = this.pendingTurn?.charsBefore;
    const tokensBefore = this.pendingTurn?.tokensBefore;
    const turn: SessionTurn = {
      index: this.turnIndex,
      startedAt,
      durationMs: Math.max(0, ended - startedAt),
      context: this.pendingTurn?.context ?? [],
      ...(usage ? { usage } : {}),
      ...(charsBefore !== undefined ? { contextCharsBefore: charsBefore } : {}),
      ...(tokensBefore !== undefined ? { contextTokensBefore: tokensBefore } : {}),
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
 * 容器形态：路径上的这个文件到底是不是 pi-durable 的库。
 *
 * 为什么要先探一下：`openNodeSqliteStorage` 是**建库**操作（对一个陌生文件它会跑迁移），
 * 而 `~/.pageqa/sessions/sessions.sqlite` 这个路径上早先版本留下过表结构完全不同的容器
 * （`sessions` / `entries` / `usage_ledger` —— 见 spec 第 8 节的「旧格式不迁移」）。
 * 直接交给 durable 去开，迁移会撞在 `table entries already exists` 上：那是**旧数据**，
 * 不是坏数据，可结果是「看一眼列表」变成一次异常，`pageqa sessions` 起服务时当场失败退出。
 *
 * `unreadable` 与 `foreign` 刻意分开：打不开（被另一个进程占着、权限不足）只是**此刻**读不到，
 * 不该把一个还在正常工作的容器误判成外来文件、把读和写一起挡下来——那种情况交给 durable
 * 去开，它会给出真正的原因。
 */
type ContainerKind = "missing" | "empty" | "current" | "foreign" | "unreadable";

/** 只读探一次容器（不建库、不改文件）：有 `durable_schema` 才算我们的库。 */
function inspectContainer(file: string): ContainerKind {
  if (!existsSync(file)) return "missing";
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
    if (tables.length === 0) return "empty";
    return tables.some((row) => row.name === "durable_schema") ? "current" : "foreign";
  } catch {
    // 开得了但读不出表（不是 SQLite 文件）算外来；连开都开不了算「此刻读不到」。
    return db ? "foreign" : "unreadable";
  } finally {
    db?.close();
  }
}

/**
 * 容器是不是**不是** pageqa 当前格式（早期版本留下的同名文件）。
 *
 * 查询服务起服务时问一句：这种情况下列表只能是空的，得当场说清原因——「一个运行记录都没有」
 * 看起来像存档全丢了，而真实原因是换过存储格式、旧容器没被迁走。
 */
export function isForeignContainer(dir: string = SESSIONS_DIR): boolean {
  return inspectContainer(databasePath(dir)) === "foreign";
}

/**
 * 外来容器的统一说法：讲清「为什么读不出」与「怎么办」。
 *
 * 不把 SQLite 的原话（`table entries already exists`）端给用户：它指向的是我们自己的迁移，
 * 而用户需要知道的是「这个文件是旧版本的，移走或删掉就能重新开始」。
 */
function foreignContainerError(file: string): Error {
  return new Error(t("err.sessionArchiveForeign", { file }));
}

/**
 * 开一个 Session、跑一段操作、**必定关闭**它。
 *
 * 读写都走这一个口子：`Session` 持有 SQLite 句柄（单容器模式下就是同一个文件），忘了关会
 * 一直占着它——查询服务是常驻进程，跑一次用例又是另一个进程，句柄漏出去的代价是下一方打不开
 * （`Session.close()` 会连底层 storage 一起关）。因此这里用 finally 兜底，而不是指望每个调用
 * 点自己记得。
 */
async function withSession<T>(
  dir: string,
  fn: (session: Session) => Promise<T>,
): Promise<T> {
  const file = databasePath(dir);
  // 外来容器一律不交给 durable 开：迁移会撞在「表已存在」上，而这文件是旧数据不是坏数据。
  if (inspectContainer(file) === "foreign") throw foreignContainerError(file);
  const storage = await openNodeSqliteStorage(file);
  const session = createSession(storage);
  try {
    return await fn(session);
  } finally {
    await session.close(BACKGROUND_CONTEXT);
  }
}

/** JSON 边界：存档里存着 `unknown`（工具入参、工具 schema），落库前统一收成纯 JSON。 */
function asJson(value: unknown): JsonValue {
  return value as JsonValue;
}

/** JSON 边界的反向：把存回来的 JSON 认回存档的类型。 */
function fromJson<T>(value: JsonValue): T {
  return value as T;
}

/** 取出索引里的摘要数组（文档不存在时是空列表，而不是一次异常）。 */
async function readIndex(session: Session): Promise<SessionSummary[]> {
  const stored = await session.snapshot(IndexDoc, BACKGROUND_CONTEXT);
  if (!stored || !Array.isArray(stored.runs)) return [];
  return stored.runs as SessionSummary[];
}

/** 摘要倒序（同一时刻的按 id 兜底）：索引写入时就按这个顺序，读端再排一次以防旧档案。 */
function byStartedAtDesc(a: SessionSummary, b: SessionSummary): number {
  return a.startedAt === b.startedAt
    ? b.id.localeCompare(a.id)
    : b.startedAt.localeCompare(a.startedAt);
}

/**
 * id 只允许 `[A-Za-z0-9._-]`：它既是存档文档的键，也是查询服务 URL 的一部分。
 *
 * 它不再被拼进文件路径，但校验照旧：`pageqa sessions` 接的是浏览器请求，让任意字符串进到
 * 「按 id 取一条记录」这条路里没有任何好处。
 */
export function assertSafeId(id: string): string {
  if (!isSafeId(id)) {
    throw new Error(`非法的 session id：${id}`);
  }
  return id;
}

/**
 * 同一个判定，不抛错的版本。
 *
 * 只需要「问一句合不合法」的地方（HTTP 路由要在动手之前先分清 400 与 404）用它，
 * 省得把 `assertSafeId` 的异常当控制流——那份错误文案是给直接调用 `readArchive` 的代码看的。
 */
export function isSafeId(id: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(id) && !id.includes("..");
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

/** 档案落库前的形状（`format`/`version` 一并存进去，读端据此认出「这是 pageqa 的存档」）。 */
function toStored(archive: SessionArchive): StoredArchive {
  return {
    format: archive.format,
    version: archive.version,
    startedAt: archive.startedAt,
    ...(archive.endedAt ? { endedAt: archive.endedAt } : {}),
    ...(archive.status ? { status: archive.status } : {}),
    ...(archive.note ? { note: archive.note } : {}),
    params: asJson(archive.params),
    turns: asJson(archive.turns),
    toolCalls: asJson(archive.toolCalls),
    ...(archive.usage ? { usage: asJson(archive.usage) } : {}),
  };
}

/**
 * 落盘一份存档：参数、每轮上下文、每次工具调用、终态与列表摘要，**一次提交**写进去。
 *
 * 档案与索引在同一个 `commit` 里：中途失败不会留下「列表页列得出、点开却缺东西」的半截记录
 * ——排查时最怕的正是这种「看着有、实际缺」。
 *
 * 任何失败都抛给调用方（由 agent 侧吞掉并记日志），失败语义与退出码无关。
 */
export async function writeArchive(
  archive: SessionArchive,
  dir: string = SESSIONS_DIR,
): Promise<string> {
  assertSafeId(archive.id);
  const summary = summarizeArchive(archive);
  await withSession(dir, async (session) => {
    await session.commit(async (tx) => {
      await tx.doc(ArchiveDoc, archive.id, toStored(archive));
      // 索引里同一个 id 只留一条：重跑一次覆盖，而不是在列表页里出现两行。
      const index = await tx.doc(IndexDoc);
      const runs = (index.runs as SessionSummary[]).filter(
        (item) => item?.id !== archive.id,
      );
      index.runs = [summary, ...runs].sort(byStartedAtDesc);
    }, BACKGROUND_CONTEXT);
  });
  return databasePath(dir);
}

/** 读一份完整存档；找不到或读不出来时抛错（调用方决定怎么呈现）。 */
export async function readArchive(
  id: string,
  dir: string = SESSIONS_DIR,
): Promise<SessionArchive> {
  assertSafeId(id);
  // 容器还不存在时直接报「没有这条」：打开 SQLite 存储是**建库**操作，
  // 为了查一个不存在的 id 在磁盘上留一个空数据库，不是查询该有的副作用。
  // （容器存在但不是当前格式时，说法由 `withSession` 给出——那是「读不出来」的原因，不是「没有这条」。）
  if (!existsSync(databasePath(dir))) throw new Error(`找不到运行存档：${id}`);
  return await withSession(dir, async (session) => {
    const stored = await session.snapshot(ArchiveDoc, id, BACKGROUND_CONTEXT);
    // 文档存在但不是 pageqa 写的（同一容器里的其它写入者）：如实说读不出来，
    // 而不是把一个形状对不上的东西当成能读的档案返回。
    if (!stored || stored.format !== SESSION_FORMAT) {
      throw new Error(`找不到运行存档：${id}`);
    }
    return {
      format: SESSION_FORMAT,
      version: SESSION_VERSION,
      id,
      startedAt: stored.startedAt,
      ...(stored.endedAt ? { endedAt: stored.endedAt } : {}),
      ...(stored.status ? { status: stored.status as SessionArchive["status"] } : {}),
      ...(stored.note ? { note: stored.note } : {}),
      ...(stored.usage ? { usage: fromJson<TokenUsage>(stored.usage) } : {}),
      params: fromJson<SessionParams>(stored.params),
      turns: fromJson<SessionTurn[]>(stored.turns),
      toolCalls: fromJson<SessionToolCall[]>(stored.toolCalls),
    };
  });
}

/**
 * 列出全部存档摘要，按开始时间**倒序**（同一时刻的按 id 兜底）。
 *
 * 摘要全在 `pageqa.index` 这一份文档里，所以列一屏条目是一次读——不必像「每条运行各存一份
 * 摘要」那样逐个去打开。索引里没有的文档（别的写入者塞进来的）自然不在列表里：列出一条点开
 * 缺东西的记录，比少列一条更糟。
 */
export async function listArchives(
  dir: string = SESSIONS_DIR,
): Promise<SessionSummary[]> {
  // 没有存档可读的三种情形都不去开存储：目录/容器还不存在、容器是个空文件、容器不是当前格式
  // （早期版本留下的同名文件，见 `inspectContainer`）。打开 SQLite 存储会顺手把容器（连目录）
  // 建出来，而「看一眼列表」既不该在磁盘上留下一个新数据库，也不该因为一个旧容器而抛异常。
  const kind = inspectContainer(databasePath(dir));
  if (kind === "missing" || kind === "empty" || kind === "foreign") return [];
  const found = await withSession(dir, readIndex);
  return found.slice().sort(byStartedAtDesc);
}

/**
 * 删掉一条存档：索引里去掉摘要，`retireDoc` 掉档案文档。
 *
 * 与 {@link pruneArchives} 同一条口径——**索引与文档在同一次提交里一起动**，所以「列表里没有」
 * 与「详情也读不回来」始终是同一件事，不会留下点开才发现缺东西的半截记录。
 *
 * 返回是否真的删掉了：索引里没有这条（从来没记录过、或已经被清理掉）时返回 false，让调用方
 * 如实答「没有这条」而不是假装成功。
 */
export async function deleteArchive(
  id: string,
  dir: string = SESSIONS_DIR,
): Promise<boolean> {
  assertSafeId(id);
  // 容器不存在时没有可删的东西，也不要为了「删一条」在磁盘上建出一个空库。
  if (!existsSync(databasePath(dir))) return false;
  return await withSession(dir, async (session) => {
    let removed = false;
    await session.commit(async (tx) => {
      const index = await tx.doc(IndexDoc);
      const runs = index.runs as SessionSummary[];
      const kept = runs.filter((item) => item?.id !== id);
      // 索引里根本没有这一条：不写任何东西（无谓的提交只会徒增库文件体积）。
      if (kept.length === runs.length) return;
      removed = true;
      index.runs = kept;
      await tx.retireDoc(ArchiveDoc, id);
    }, BACKGROUND_CONTEXT);
    return removed;
  });
}

/**
 * 清空全部存档（列表页的「清空」按钮）：归档档文档，只留下一个空索引。
 *
 * 「清空」在页面上是不可撤销的，因此要求调用方**已经**在界面上跟用户确认过；这里只管做。
 *
 * 返回删掉的条数。不抛错语义与 {@link pruneArchives} 不同——它是一次用户明确要求的删除，
 * 失败必须让调用方知道（页面得给出「没删掉」而不是刷新后记录还在）。
 */
export async function clearArchives(dir: string = SESSIONS_DIR): Promise<number> {
  const kind = inspectContainer(databasePath(dir));
  // 没有存档可清的三种情形：目录/容器不存在、容器是个空文件、容器不是当前格式。
  // 前两种直接答 0（没有东西可删）；第三种交给 `withSession` 报「旧格式」，那是需要说清的原因。
  if (kind === "missing" || kind === "empty") return 0;
  return await withSession(dir, async (session) => {
    const runs = (await readIndex(session)).slice().sort(byStartedAtDesc);
    if (runs.length === 0) return 0;
    await session.commit(async (tx) => {
      const index = await tx.doc(IndexDoc);
      index.runs = [];
      for (const summary of runs) {
        await tx.retireDoc(ArchiveDoc, summary.id);
      }
    }, BACKGROUND_CONTEXT);
    return runs.length;
  });
}

/**
 * 清掉超出上限的旧存档（保留最近 keep 条，按开始时间倒序数）。
 *
 * 一次提交里既缩索引、又`retireDoc` 掉被淘汰的档案文档，所以「列表里没有」与「详情也读不回来」
 * 始终是同一件事。
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
    return await withSession(dir, async (session) => {
      const runs = (await readIndex(session)).slice().sort(byStartedAtDesc);
      const dropped = runs.slice(keep);
      if (dropped.length === 0) return 0;
      const kept = runs.slice(0, keep);
      await session.commit(async (tx) => {
        const index = await tx.doc(IndexDoc);
        index.runs = kept;
        for (const summary of dropped) {
          await tx.retireDoc(ArchiveDoc, summary.id);
        }
      }, BACKGROUND_CONTEXT);
      return dropped.length;
    });
  } catch {
    return 0;
  }
}
