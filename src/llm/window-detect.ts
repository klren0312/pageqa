/**
 * 从本地推理引擎问出「它现在真正能装多少 token」。
 *
 * 为什么需要（一次真实故障的教训）：自配的 OpenAI 兼容端点没有窗口元数据，
 * pageqa 只能按 32k 保守猜；用户的 LM Studio 把模型载入成 `n_ctx = 8192`，
 * 于是第一个请求就被引擎拒成 `exceed_context_size_error`。用户当然可以自己在
 * 配置里声明 `contextWindow`，但「本地跑个小模型」这件事本身不该要求用户先去
 * 读引擎的加载设置——引擎自己就知道答案，问它一次即可。
 *
 * 顺带说清**不做**什么：
 * - 不猜、不推导：只在引擎真的回了数字时用它；任何失败（没起、超时、格式不对）
 *   都返回 undefined，由调用方退回保守兜底。
 * - 不覆盖用户声明：声明了 `contextWindow` 就以声明为准（见 agent.ts 的调用点）。
 * - 不做健康检查：探测失败不是错误，只是一条降级的日志。
 *
 * 认两类引擎（覆盖本地跑模型的主流方式）：
 * - **LM Studio**：`GET /api/v0/models` → 每项带 `loaded_context_length`（当前载入的
 *   窗口）与 `max_context_length`（模型上限）；优先前者，因为真正生效的是载入值。
 * - **llama.cpp server**：`GET /props` → `default_generation_settings.n_ctx`。
 */
import { debugLog } from "../shared/log.js";

/** 探测超时：它是「顺手一问」，不该让一次运行在启动时多等。 */
const DETECT_TIMEOUT_MS = 3_000;

/**
 * 由 baseUrl 推出引擎根地址。
 *
 * `http://127.0.0.1:1234/v1` → `http://127.0.0.1:1234`：
 * 管理接口（`/api/v0/models`、`/props`）挂在根上，不在 `/v1` 下。
 */
export function engineRootOf(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "").replace(/\/v1$/i, "");
}

/** 从 LM Studio 的 `/api/v0/models` 响应里取窗口（导出便于单测）。 */
export function windowFromLmStudio(
  body: unknown,
  modelId: string,
): number | undefined {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return undefined;
  const entries = data as {
    id?: string;
    state?: string;
    loaded_context_length?: number;
    max_context_length?: number;
  }[];
  const normalized = modelId.toLowerCase();
  const entry =
    entries.find((item) => (item.id ?? "").toLowerCase() === normalized) ??
    entries.find((item) => item.state === "loaded") ??
    (entries.length === 1 ? entries[0] : undefined);
  if (!entry) return undefined;
  return pickWindow(entry.loaded_context_length) ?? pickWindow(entry.max_context_length);
}

/** 从 llama.cpp 的 `/props` 响应里取窗口（导出便于单测）。 */
export function windowFromLlamaCpp(body: unknown): number | undefined {
  const settings = (body as { default_generation_settings?: { n_ctx?: number } } | null)
    ?.default_generation_settings;
  return pickWindow(settings?.n_ctx);
}

/** 只接受像样的窗口值：小于 256 或非数字都当没探测到。 */
function pickWindow(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 256
    ? Math.round(value)
    : undefined;
}

async function getJson(
  url: string,
  signal: AbortSignal,
): Promise<unknown | undefined> {
  try {
    const response = await fetch(url, { signal });
    if (!response.ok) return undefined;
    return await response.json();
  } catch {
    // 引擎没起、没这个接口、超时、返回的不是 JSON：都只是「探测不到」。
    return undefined;
  }
}

export interface DetectWindowOptions {
  /** 模型 id（LM Studio 用它挑条目）。 */
  modelId: string;
  timeoutMs?: number;
  /** 调用方的中止信号（用户按 Esc 时不必等探测超时）。 */
  signal?: AbortSignal;
}

/**
 * 问一次引擎的实际窗口；问不出来返回 undefined（调用方据此退回兜底值）。
 *
 * 两个接口**并行**问：它们是两套引擎的两条路，串行只会让启动多等一个超时。
 */
export async function detectContextWindow(
  baseUrl: string,
  opts: DetectWindowOptions,
): Promise<number | undefined> {
  const root = engineRootOf(baseUrl);
  if (!/^https?:\/\//i.test(root)) return undefined;
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? DETECT_TIMEOUT_MS);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  const [lmStudio, llamaCpp] = await Promise.all([
    getJson(`${root}/api/v0/models`, signal).then((body) =>
      windowFromLmStudio(body, opts.modelId),
    ),
    getJson(`${root}/props`, signal).then(windowFromLlamaCpp),
  ]);
  const detected = lmStudio ?? llamaCpp;
  if (detected) {
    debugLog(
      `[window-detect] ${root} 自报窗口 ${detected} tokens` +
        (lmStudio ? "（LM Studio /api/v0/models）" : "（llama.cpp /props）"),
    );
  }
  return detected;
}
