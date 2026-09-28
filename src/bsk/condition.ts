/**
 * 「等到页面出现某个东西」的页面侧探针，以及它的轮询框架。
 *
 * 为什么要做这个工具（对着实测数据）：一份 6 场景的回放脚本里，`wait` 步骤占了墙钟的
 * **47%**（11s / 23s）——那些 `wait 2000` 是录制时模型对「给页面一点时间」的**猜测**，
 * 回放里每一步都照付，而且它既可能等太久，也可能等不够。模型真正知道的往往不是「等 2 秒」，
 * 而是「等到出现『导出成功』」——把这件事交给它表达，回放就变成**条件等待**：
 * 条件成立立刻走，不成立才等满上限。相比 `--settle-waits`（等「页面稳定」这个代理指标），
 * 这里等的是模型当初真正关心的那件事，因此**不存在提前放行的风险**：
 * 条件没达成就一定会等到上限，与原来的固定等待同长。
 *
 * 与 settle.ts 同一条实现路线，理由也一样：**同步探针 + 外层轮询**，
 * 不依赖页面内的任何定时器（后台标签页的定时器会被节流到 1s 以上，那种写法会在用户
 * 切走窗口时退化成几十秒的挂起）。
 *
 * 两个刻意的取舍：
 * - **轮询用 `textContent`（便宜），命中后再用 `innerText` 复核（可见性）**。
 *   `innerText` 会触发布局，在大页面上每次几十毫秒；150ms 一次的轮询用它等于持续给页面
 *   加负担。而 `textContent` 会把隐藏内容、`<script>` 里的字也算上——所以它只用来做
 *   「可能命中」的粗筛，真正的结论由一次 `innerText` 复核给出。
 * - **三种条件互斥**（出现文本 / 出现元素 / 元素消失），由调用方保证；这里只负责把
 *   给定的那一种翻译成探针。
 */

/**
 * 等待条件：三者只能给一个（由工具层校验）。
 *
 * 文案与操作层其余方法保持一致（硬编码中文）：这些字符串会进轨迹与报告，
 * 与「已点击」「页面已稳定」是同一层，不额外走 i18n。
 */
export interface WaitCondition {
  /** 等到页面**可见文本**中出现该文本。 */
  text?: string;
  /** 等到该 CSS 选择器命中元素。 */
  selector?: string;
  /** 等到该 CSS 选择器**不再**命中元素（如 loading 遮罩消失）。 */
  gone?: string;
}

/** 条件的人类可读描述，用于日志、轨迹与报告。 */
export function describeCondition(cond: WaitCondition): string {
  if (cond.text) return `文本「${cond.text}」`;
  if (cond.selector) return `元素 ${cond.selector}`;
  if (cond.gone) return `元素 ${cond.gone} 消失`;
  return "（未指定条件）";
}

/** JSON 字面量（把外部输入安全地嵌进表达式，避免引号/换行把脚本拼坏）。 */
function literal(value: string | undefined): string {
  return value === undefined ? "null" : JSON.stringify(value);
}

/**
 * 轮询探针：**只做便宜的事**（`querySelector` + `textContent`），同步返回两个布尔。
 *
 * 不在这里判 `innerText`：那是命中复核与超时取证的事（见 buildConfirmExpression）。
 */
export function buildProbeExpression(cond: WaitCondition): string {
  return [
    "(() => {",
    `  var SEL = ${literal(cond.selector)};`,
    `  var GONE = ${literal(cond.gone)};`,
    `  var TXT = ${literal(cond.text)};`,
    "  var out = { selectorHit: false, selectorPresent: false, textPresent: false };",
    "  try {",
    "    if (SEL !== null) out.selectorHit = !!document.querySelector(SEL);",
    "    if (GONE !== null) out.selectorPresent = !!document.querySelector(GONE);",
    "  } catch (e) { /* 选择器非法：当作没命中，由上层按超时处理 */ }",
    "  try {",
    "    if (TXT !== null) {",
    "      var root = document.body || document.documentElement;",
    "      out.textPresent = !!root && root.textContent.indexOf(TXT) !== -1;",
    "    }",
    "  } catch (e) {}",
    "  return out;",
    "})()",
  ].join("\n");
}

/**
 * 复核 + 取证探针：读一次**可见文本**（`innerText`）。
 *
 * 两处用它：`textContent` 报「可能出现」时复核可见性（避免隐藏文本造成假命中），
 * 以及超时后取一段页面当前可见文本作为证据（让人一眼看出当时页面上是什么）。
 */
export function buildConfirmExpression(cond: WaitCondition): string {
  return [
    "(() => {",
    `  var TXT = ${literal(cond.text)};`,
    "  var body = document.body;",
    "  var visible = body ? body.innerText || \"\" : \"\";",
    "  var flat = visible.replace(/\\s+/g, \" \").trim();",
    "  return {",
    "    visibleHit: TXT === null ? false : visible.indexOf(TXT) !== -1,",
    "    excerpt: flat.slice(0, 160),",
    "  };",
    "})()",
  ].join("\n");
}

/** 轮询探针的结果。 */
export interface ConditionProbe {
  selectorHit: boolean;
  selectorPresent: boolean;
  textPresent: boolean;
}

/** 复核探针的结果。 */
export interface ConditionConfirm {
  visibleHit: boolean;
  /** 页面当前可见文本的前若干字符（证据）。 */
  excerpt: string;
}

function asRecord(out: string): Record<string, unknown> | null {
  const text = out.trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    // 数组也是 object，但它不可能是我们探测出来的那个形状：一并当作认不出来。
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** 解析轮询探针的 stdout；认不出来返回 null（调用方按「这次探针不可用」处理）。 */
export function parseProbe(out: string): ConditionProbe | null {
  const raw = asRecord(out);
  if (!raw) return null;
  return {
    selectorHit: raw.selectorHit === true,
    selectorPresent: raw.selectorPresent === true,
    textPresent: raw.textPresent === true,
  };
}

/** 解析复核探针的 stdout；认不出来返回 null。 */
export function parseConfirm(out: string): ConditionConfirm | null {
  const raw = asRecord(out);
  if (!raw) return null;
  return {
    visibleHit: raw.visibleHit === true,
    excerpt: typeof raw.excerpt === "string" ? raw.excerpt : "",
  };
}

/** 探针是否已经可以判定命中（文本类条件还要等复核，因此这里不给结论）。 */
export function probeSaysMaybe(cond: WaitCondition, probe: ConditionProbe): boolean {
  if (cond.selector) return probe.selectorHit;
  if (cond.gone) return !probe.selectorPresent;
  if (cond.text) return probe.textPresent;
  return false;
}

/** 文本条件的最终判定需要复核；选择器类条件探针说了算。 */
export function needsConfirm(cond: WaitCondition): boolean {
  return Boolean(cond.text);
}

/**
 * 轮询框架：`sample` 取一次样本、`isHit` 判定。
 *
 * 抽成注入式（`sleep`/`now` 都由调用方给）是为了让「条件等待」这件事可以在单测里
 * 精确控制时间——否则这段逻辑只能靠真浏览器验证，而它恰恰是最容易写错的地方
 * （第一次采样、超时边界、间隔与剩余时间的夹取）。
 */
export interface PollOptions<T> {
  /** 等待上限（毫秒）。 */
  timeoutMs: number;
  /** 采样间隔（毫秒）。 */
  intervalMs: number;
  /** 取一次样本；返回 null 表示这次没取到（按未命中继续）。 */
  sample: () => Promise<T | null>;
  /**
   * 判定样本是否命中。
   *
   * 允许返回 Promise：文本类条件要用**两次**探针才能定论（便宜的 `textContent` 粗筛 →
   * `innerText` 复核可见性），把它放进来比让调用方在外面自己写循环干净。
   */
  isHit: (sample: T) => boolean | Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export interface PollOutcome<T> {
  hit: boolean;
  /** 最后一次取到的样本（从未取到时为 null）。 */
  last: T | null;
  waitedMs: number;
  polls: number;
}

export async function pollUntil<T>(opts: PollOptions<T>): Promise<PollOutcome<T>> {
  const startedAt = opts.now();
  let polls = 0;
  let last: T | null = null;
  for (;;) {
    // 先采样再判断：条件可能**此刻已经成立**（例如「等 loading 消失」而遮罩根本没出现），
    // 那就不该先睡一个间隔。
    const sample = await opts.sample();
    polls += 1;
    if (sample !== null) {
      last = sample;
      if (await opts.isHit(sample)) {
        return { hit: true, last, waitedMs: opts.now() - startedAt, polls };
      }
    }
    const elapsed = opts.now() - startedAt;
    if (elapsed >= opts.timeoutMs) {
      return { hit: false, last, waitedMs: elapsed, polls };
    }
    await opts.sleep(Math.max(0, Math.min(opts.intervalMs, opts.timeoutMs - elapsed)));
  }
}
