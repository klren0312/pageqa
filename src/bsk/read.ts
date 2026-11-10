/**
 * `bsk read`（DOM read protocol 1.9 / bsk 0.5.0+）的接入层。
 *
 * 真实形态已对照 BrowserSkill 源码核对（`cli-v0.4.2-96-gd5cfe8f9`，2026-11-09）：
 * - `crates/bsk-cli/src/cli/read.rs:38,69-72`：`dispatch` 忽略 `Format`，**无论是否传
 *   `--json`，stdout 恒为 `serde_json::to_string_pretty(&ReadResult)`**；
 * - `crates/bsk-protocol/src/tools/read.rs:74-85`：`ReadResult` = `tab_id` / `page_url` /
 *   `frame_url` / `frame_id` / `title` / `captured_at` / `items` / `truncated` / `scope`；
 *   `ReadItem` = `{ ref, values: IndexMap<String, Value>, redacted: string[] }`。
 *   **没有顶层 `text` / `url` / `attributes`**，正文在 `items[].values` 里；
 * - `crates/bsk-cli/src/cli/read.rs:15-37`：必填 `--session`，可选 `--selector` / `--ref`
 *   （互斥）/ `--fields-json` / `--max-nodes` / `--max-bytes` / `--timeout-ms` / `--tab-id`；
 * - 默认 fields 是 `[{"key":"text","read":"text"}]`，**不给 selector 时只读 root 节点**，
 *   文本是它的 `textContent`（`apps/extension/src/tools/read/collector.ts:63`）。要读
 *   value / checked / 属性，必须显式给 `--selector` + `--fields-json`；
 * - `--json` 是全局 flag（`cli/mod.rs:104-106`，`global = true`）。本层保留它**只为了让
 *   错误也走结构化信封**（`cli/error.rs:159-183`），便于能力探测；成功输出与它无关。
 *
 * 为什么单独一层：这是**可选能力**（命令不存在 / daemon 协议太老 / 输出形状变了都静默
 * 退回 `snapshot`）；它是**断言语料的补充来源**（补 aria 快照对 CSS 大小写转换、hidden
 * 被 CSS 恢复显示、表单当前值的盲区，见 v0.5.0 更新日志 16/17）；它**不能替代 snapshot**
 * （输出没有 `@eN`，locator.ts / snapshot.ts 与快照格式逐字节耦合）。
 *
 * 两条安全边界：只把 `items[].values` 的**字符串值**并进断言语料（绝不把整个 JSON 塞
 * 进去，否则断言 `"page_url"` 会命中键名制造假通过）；任何失败都只记 debug 日志并返回
 * null，唯一例外是用户按 Esc（signal 已中止）必须原样抛出。
 *
 * **一个必须知道的取舍**：`collector.ts:63` 取精确 `textContent`，**不做可见性过滤**，
 * 隐藏 DOM / 模板里的文字也会进来。它让断言不再漏判，但理论上也可能让 `assert_text`
 * 命中真正不可见的文字（假通过）。用例对此敏感时用 `PAGEQA_BSK_READ_ASSERT=0` 只关闭
 * 语料合并（`read` 工具本身仍可用）。
 *
 * **刻意不走 IPC 快路径**：`--json` 被 `ipc-commands.ts` 的 `REJECTED_FLAGS` 拒绝；更重要
 * 的是 `tool.read` 要求 daemon protocol ≥ 1.9，老 daemon 上 RPC 会报协议漂移，而
 * `runBskCommand` 对协议漂移的处理是 `ipcDisabled = true` —— 那会把 snapshot/click/fill
 * 等**全部**快路径一起关掉，为一次可选读取赔上全局性能。CLI 子进程 13–20ms 更划算。
 */
import { debugLog } from "../shared/log.js";

/** 一次页面读取的结果。`text` 是唯一能进断言语料的字段，其余只用于展示给模型。 */
export interface PageRead {
  /** 页面文本（断言语料）：拼接 `items[].values` 里的字符串值。空串表示没取到文本。 */
  text: string;
  title?: string;
  url?: string;
  /** 读取元信息 / 布尔与数值字段 / ref / 脱敏字段（已格式化成文本）。 */
  details?: string;
  /** bsk 侧已达 max_bytes / max_nodes，文本不完整。 */
  truncated?: boolean;
}

/** `read` 工具可透传的读取参数（对应 CLI 的可选 flag）。 */
export interface ReadOptions {
  /** CSS 选择器，限定读取范围；不给则读 root。 */
  selector?: string;
  /** `--fields-json` 原文；只允许 text / attribute / value / checked / exists 五种读法。 */
  fieldsJson?: string;
  maxNodes?: number;
  maxBytes?: number;
  timeoutMs?: number;
}

/** 兼容其它版本 / 其它输出形状：只按明确字段名取值，认不出就降级。 */
const TEXT_KEYS = [
  "text",
  "visible_text",
  "visibleText",
  "page_text",
  "pageText",
  "body_text",
  "bodyText",
  "inner_text",
  "innerText",
  "content",
];
const TITLE_KEYS = ["title", "page_title", "pageTitle"];
const URL_KEYS = ["url", "page_url", "pageUrl", "href"];
const DETAIL_KEYS = [
  "attributes",
  "attrs",
  "form_state",
  "formState",
  "forms",
  "values",
  "properties",
];
/** `--json` 可能套一层信封：`{ok:true,data:{...}}`、`{result:{...}}`。 */
const ENVELOPE_KEYS = ["data", "result", "read", "page", "payload"];

/** 给模型看的默认体积上限（字符）。与 get_html 的默认字节预算同一个量级。 */
export const READ_DEFAULT_MAX_CHARS = 16_384;
export const READ_MAX_CHARS_LIMIT = 65_536;

type JsonObject = Record<string, unknown>;

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function clamp(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(min, Math.min(Math.round(value), max));
}

/** 真形态：`bsk_protocol::tools::ReadResult`（以 `items` 数组为判据）。 */
function parseReadResult(obj: JsonObject): PageRead {
  const texts: string[] = [];
  const detailLines: string[] = [];
  const items = Array.isArray(obj.items) ? obj.items : [];

  for (const rawItem of items) {
    if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem)) continue;
    const item = rawItem as JsonObject;
    const values =
      item.values && typeof item.values === "object" && !Array.isArray(item.values)
        ? (item.values as JsonObject)
        : null;
    const ref = asString(item.ref);
    const redacted = Array.isArray(item.redacted)
      ? item.redacted.filter((x): x is string => typeof x === "string")
      : [];
    const redactedKeys = new Set(redacted);
    if (values) {
      for (const [key, value] of Object.entries(values)) {
        // 脱敏字段跳过：里面通常是 "[REDACTED]" 之类的占位文本，进语料只会制造假命中。
        if (redactedKeys.has(key)) continue;
        // 字符串值才进语料（默认键 text 是 textContent；value / attribute 的字符串值也算）。
        // 布尔与数值只展示，不进语料：否则期望文本 "true" 会假命中。
        if (typeof value === "string" && value.trim()) texts.push(value);
        else if (typeof value === "boolean" || typeof value === "number") {
          detailLines.push(`${key}=${String(value)}`);
        }
      }
    }
    if (ref || redacted.length > 0) {
      detailLines.push(`[item] ref=${ref ?? "-"} redacted=${redacted.join(",") || "-"}`);
    }
  }

  const pageUrl = asString(obj.page_url);
  const frameUrl = asString(obj.frame_url);
  const title = asString(obj.title);
  const scope = asString(obj.scope);
  const capturedAt = asString(obj.captured_at);
  const truncated = obj.truncated === true;
  const meta: string[] = [];
  if (scope) meta.push(`scope=${scope}`);
  if (capturedAt) meta.push(`captured_at=${capturedAt}`);
  if (typeof obj.tab_id === "number") meta.push(`tab_id=${obj.tab_id}`);
  if (frameUrl && frameUrl !== pageUrl) meta.push(`frame_url=${frameUrl}`);
  if (truncated) {
    meta.push("truncated=true（bsk 侧已达 --max-bytes / --max-nodes，文本不完整）");
  }
  const details = [...meta, ...detailLines].join("\n").slice(0, 4_096) || undefined;

  return {
    text: texts.join("\n"),
    ...(title ? { title } : {}),
    ...(pageUrl ? { url: pageUrl } : {}),
    ...(details ? { details } : {}),
    ...(truncated ? { truncated } : {}),
  };
}

/**
 * 根对象 + 最多三层信封。只沿 ENVELOPE_KEYS 展开，不遍历任意对象：
 * 表单值里也可能有 `text` 字段，把它当正文会让断言读到不该读的东西。
 */
function layersOf(root: JsonObject): JsonObject[] {
  const layers: JsonObject[] = [];
  let batch: JsonObject[] = [root];
  for (let depth = 0; batch.length > 0 && depth < 3; depth++) {
    const next: JsonObject[] = [];
    for (const layer of batch) {
      layers.push(layer);
      for (const key of ENVELOPE_KEYS) {
        const value = layer[key];
        if (value && typeof value === "object" && !Array.isArray(value)) {
          next.push(value as JsonObject);
        }
      }
    }
    batch = next;
  }
  return layers;
}

/** 按「字段名优先」在信封各层查找字符串值。 */
function findString(root: JsonObject, keys: string[]): string | undefined {
  const layers = layersOf(root);
  for (const key of keys) {
    for (const layer of layers) {
      const value = layer[key];
      if (typeof value === "string" && value.trim()) return value;
    }
  }
  return undefined;
}

/** 属性 / 表单状态：原样格式化，但每块限长，避免一份表单把上下文吃满。 */
function collectDetails(root: JsonObject): string | undefined {
  const layers = layersOf(root);
  const blocks: string[] = [];
  for (const layer of layers) {
    for (const key of DETAIL_KEYS) {
      const value = layer[key];
      if (value === undefined || value === null) continue;
      const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
      if (!text || text === "{}" || text === "[]") continue;
      blocks.push(text.slice(0, 4_096));
    }
  }
  return blocks.length > 0 ? blocks.join("\n") : undefined;
}

/**
 * 解析 `bsk read` 的 stdout（成功输出恒为 JSON，见文件头）。
 *
 * - 真形态 `ReadResult`：按 `items[].values` 取文本，顶层取标题 / URL / 元信息；
 * - 其它 JSON 对象：按明确字段名容错取值，一个都不认识则返回 null（宁可降级，
 *   也不要把 `{ "foo": … }` 的字符串形态当页面文本）；
 * - 非 JSON（未来若改成 human 输出）：整段就是文本；
 * - 空输出 / JSON 数组：null。
 *
 * 返回 null 表示「这次没读到能用的东西」，调用方退回快照，不改变断言结论。
 */
export function parseReadOutput(out: string): PageRead | null {
  const raw = out.trim();
  if (!raw) return null;

  let parsed: unknown;
  let isJson = true;
  try {
    parsed = JSON.parse(raw);
  } catch {
    isJson = false;
  }
  if (!isJson) {
    // JSON 数组不是认识的信封：整段塞进语料会让断言命中里面的键名。
    if (raw.startsWith("[") && raw.endsWith("]")) return null;
    return { text: raw };
  }
  if (Array.isArray(parsed)) return null;
  if (typeof parsed === "string") return { text: parsed };
  if (!parsed || typeof parsed !== "object") return null;

  const obj = parsed as JsonObject;
  if (Array.isArray(obj.items)) return parseReadResult(obj);

  const text = findString(obj, TEXT_KEYS) ?? "";
  const title = findString(obj, TITLE_KEYS);
  const url = findString(obj, URL_KEYS);
  const details = collectDetails(obj);
  if (!text && !title && !url && !details) return null;
  return {
    text,
    ...(title ? { title } : {}),
    ...(url ? { url } : {}),
    ...(details ? { details } : {}),
  };
}

/** 把一次读取渲染成给模型看的文本（只影响展示，不影响断言语料）。 */
export function renderRead(read: PageRead, maxChars: number = READ_DEFAULT_MAX_CHARS): string {
  const limit = Math.max(
    256,
    Math.min(Number.isFinite(maxChars) ? maxChars : READ_DEFAULT_MAX_CHARS, READ_MAX_CHARS_LIMIT),
  );
  const blocks: string[] = [];
  if (read.title) blocks.push(`标题：${read.title}`);
  if (read.url) blocks.push(`地址：${read.url}`);
  if (read.text) blocks.push(`【页面文本】\n${read.text}`);
  if (read.details) blocks.push(`【读取元信息 / 结构化字段】\n${read.details}`);
  const body = blocks.join("\n\n") || "（bsk read 没有返回内容）";
  if (body.length <= limit) return body;
  return `${body.slice(0, limit)}\n…（已截断，共 ${body.length} 字符；maxChars 可调大）`;
}

function errorText(err: unknown): string {
  const e = err as { stderr?: unknown; stdout?: unknown; message?: unknown } | null;
  return [
    typeof e?.stderr === "string" ? e.stderr : "",
    typeof e?.stdout === "string" ? e.stdout : "",
    typeof e?.message === "string" ? e.message : "",
  ].join("\n");
}

/** 当前 bsk 根本没有 `read` 这条命令（0.4.x 及更早）。与 isMissingWaitForElement 同一套判定。 */
export function isMissingReadCommand(err: unknown): boolean {
  const e = err as { bskCode?: unknown } | null;
  if (e?.bskCode === "unknown_method") return true;
  const text = errorText(err);
  return (
    /unrecognized subcommand/i.test(text) ||
    /unknown command/i.test(text) ||
    /no such command/i.test(text) ||
    /\bread\b[^\n]*(?:not found|does not exist|unknown|unavailable)/i.test(text)
  );
}

/**
 * 命令存在，但 daemon 协议太老：`crates/bsk-cli/src/cli/protocol.rs:15-27` 抛
 * `unsupported_feature` / `required_protocol: "1.9"`（DOM_READ_PROTOCOL），
 * message 是 "read requires daemon protocol 1.9 ..."。与「命令不存在」一样，本进程内
 * 不会自愈（要升级并重启 daemon），所以同样永久关闭，不让它反复失败拖慢每条断言。
 */
export function isUnsupportedReadFeature(err: unknown): boolean {
  const text = errorText(err);
  return (
    /unsupported_feature/i.test(text) ||
    /required_protocol/i.test(text) ||
    /requires daemon protocol/i.test(text)
  );
}

/** `--json` 这个 flag 不被当前 bsk 接受：退回 human 输出再读一次。 */
export function isUnsupportedReadFlag(err: unknown): boolean {
  const text = errorText(err);
  return (
    /unexpected argument '--json'/i.test(text) ||
    /unknown argument '--json'/i.test(text) ||
    /unrecognized argument '--json'/i.test(text) ||
    /--json[^\n]*(?:not (?:recognized|supported)|unexpected)/i.test(text)
  );
}

/** `PAGEQA_BSK_READ=0|off|false` 强制关闭整条 read 能力。 */
function defaultEnabled(): boolean {
  const flag = process.env.PAGEQA_BSK_READ?.trim().toLowerCase();
  return !(flag === "0" || flag === "off" || flag === "false");
}

/**
 * `PAGEQA_BSK_READ_ASSERT=0|off|false` 只关闭 `assert_text` 的语料合并，`read` 工具仍可用。
 * 用于 read 的 `textContent` 含隐藏 DOM 文本、可能让某条断言假通过时（见文件头取舍）。
 */
export function readAssertCorpusEnabled(): boolean {
  const flag = process.env.PAGEQA_BSK_READ_ASSERT?.trim().toLowerCase();
  return !(flag === "0" || flag === "off" || flag === "false");
}

export interface PageReaderOptions {
  session: string;
  /** 执行一条 bsk 命令（由 tools.ts 注入自己的 `bsk()`，保持命令串行与中止语义）。 */
  run: (args: string[], signal?: AbortSignal) => Promise<string>;
  /** 覆盖能力开关，测试用。 */
  enabled?: () => boolean;
}

export interface PageReader {
  /** 返回 null = 不可用 / 本次失败，调用方一律退回快照。options 只由 `read` 工具透传。 */
  read(signal?: AbortSignal, options?: ReadOptions): Promise<PageRead | null>;
}

/**
 * 造一个绑定到 session 的读取器。三个进程内状态：
 * - `missing`：命令不存在，或 daemon 协议 < 1.9，都永久不再试（进程跑着时不会自愈）；
 * - `jsonFlag`：`--json` 不被接受后永久改发不带 json 的命令，不再每次白付一次参数错误
 *   （成功输出恒为 JSON，与这个 flag 无关，所以回退后解析照常）；
 * - 连续失败冷却：一次性抖动（会话 / 页面 / CDP）不缓存，连着三次失败冷却 30s。
 */
/** 连续失败的次数上限与冷却时长：可选能力不该在长流程里每条断言都白付一次失败命令。 */
const READ_FAILURE_COOLDOWN_MS = 30_000;
const READ_FAILURES_BEFORE_COOLDOWN = 3;

export function createPageReader(opts: PageReaderOptions): PageReader {
  let missing = false;
  let jsonFlag = true;
  let failures = 0;
  let suspendedUntil = 0;
  const enabled = opts.enabled ?? defaultEnabled;

  /** 一次性失败只记一笔；连着失败则冷却一阵，冷却过后仍会自动重试（不是永久关掉）。 */
  const noteFailure = (): void => {
    failures += 1;
    if (failures >= READ_FAILURES_BEFORE_COOLDOWN) {
      failures = 0;
      suspendedUntil = Date.now() + READ_FAILURE_COOLDOWN_MS;
      debugLog("[bsk] read 连续失败，冷却 30s 后再试（期间断言只用快照）");
    }
  };

  const call = async (
    json: boolean,
    signal: AbortSignal | undefined,
    options?: ReadOptions,
  ): Promise<PageRead | null> => {
    const args = ["read", "--session", opts.session];
    if (options?.selector) args.push("--selector", options.selector);
    if (options?.fieldsJson) args.push("--fields-json", options.fieldsJson);
    const maxNodes = clamp(options?.maxNodes, 1, 1000);
    const maxBytes = clamp(options?.maxBytes, 1024, 1_048_576);
    const timeoutMs = clamp(options?.timeoutMs, 100, 10_000);
    if (maxNodes !== undefined) args.push("--max-nodes", String(maxNodes));
    if (maxBytes !== undefined) args.push("--max-bytes", String(maxBytes));
    if (timeoutMs !== undefined) args.push("--timeout-ms", String(timeoutMs));
    if (json) args.push("--json");
    const out = await opts.run(args, signal);
    const parsed = parseReadOutput(out);
    if (!parsed) {
      debugLog(`[bsk] read 输出形状不认识，本次忽略：${out.trim().slice(0, 200)}`);
      noteFailure();
    }
    return parsed;
  };

  return {
    async read(signal?: AbortSignal, options?: ReadOptions): Promise<PageRead | null> {
      if (missing || !enabled() || Date.now() < suspendedUntil) return null;
      try {
        const parsed = await call(jsonFlag, signal, options);
        if (parsed) failures = 0;
        return parsed;
      } catch (err) {
        // 中止不是「读页失败」：不能被降级逻辑吞掉。
        if (signal?.aborted) throw err;
        if (isMissingReadCommand(err) || isUnsupportedReadFeature(err)) {
          missing = true;
          debugLog("[bsk] read 不可用（旧 bsk / daemon 协议 < 1.9），本次运行改用 snapshot");
          return null;
        }
        if (jsonFlag && isUnsupportedReadFlag(err)) {
          jsonFlag = false;
          debugLog("[bsk] read 不接受 --json，改发不带该 flag 的命令（成功输出仍是 JSON）");
          try {
            const parsed = await call(false, signal, options);
            if (parsed) failures = 0;
            return parsed;
          } catch (retryErr) {
            if (signal?.aborted) throw retryErr;
            if (isMissingReadCommand(retryErr) || isUnsupportedReadFeature(retryErr)) {
              missing = true;
            }
            debugLog(
              `[bsk] read 回退仍失败，本次退回快照：${String(retryErr).slice(0, 200)}`,
            );
            noteFailure();
            return null;
          }
        }
        debugLog(`[bsk] read 失败，本次退回快照：${String(err).slice(0, 200)}`);
        noteFailure();
        return null;
      }
    },
  };
}
