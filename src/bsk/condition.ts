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
 *
 * ## 与 `bsk wait-for-element` 的关系（两套实现，一套语义）
 *
 * 元素类条件（`selector` / `gone`）优先交给 bsk 原生等待（一次 RPC、轮询在扩展侧，不受后台
 * 标签页定时器节流影响）；文本条件 bsk 表达不了，仍走这里的页面侧探针。原生命令不可用
 * （旧版 bsk）时退回探针，**判定规则必须一致**——所以 `probeSaysMaybe` 按状态判定的矩阵
 * 与 bsk 的 `ElementState::satisfied_by(attached, visible)` 逐条对齐，探针里的可见性判定
 * 也抄 bsk 的口径（`checkVisibility` + 非零盒子 + computed style 兜底）。两套路径对同一页面
 * 必须给同一个答案，否则「旧版通过、新版超时」会变成一条查不出来的差异。
 */

/**
 * 元素等待的四种状态，语义与 bsk 的 `--state` 一一对应。
 *
 * `visible` / `hidden` 问的是**可见性**，`attached` / `detached` 问的是**是否在 DOM 里**。
 * 分开表达的理由全在超时报告上：「还在树里但没显形」和「压根没出现过」是两种不同的 bug，
 * 合并成一个「没等到」等于把排查方向也一起丢了。
 */
export type ElementState = "visible" | "hidden" | "attached" | "detached";

/** 合法状态的运行期清单（工具层与回放脚本校验共用一份）。 */
export const ELEMENT_STATES: readonly ElementState[] = [
  "visible",
  "hidden",
  "attached",
  "detached",
];

export function isElementState(value: unknown): value is ElementState {
  return typeof value === "string" && (ELEMENT_STATES as readonly string[]).includes(value);
}

/**
 * 等待条件：`text` / `selector` / `gone` 三者只能给一个（由工具层校验）。
 *
 * `state` 只修饰 `selector`：`selector` 不带 `state` 时等的是**可见**（与 bsk
 * `wait-for-element` 的默认值一致，也是「等到它出现」这句话的字面意思）；`gone` 等价于
 * `selector + state: "hidden"`，保留它是因为它是回放脚本里已有的写法，且比写两个字段更直白。
 *
 * 文案与操作层其余方法保持一致（硬编码中文）：这些字符串会进轨迹与报告，
 * 与「已点击」「页面已稳定」是同一层，不额外走 i18n。
 */
export interface WaitCondition {
  /** 等到页面**可见文本**中出现该文本。 */
  text?: string;
  /** 等到该 CSS 选择器达到 `state` 描述的状态（缺省 `visible`）。 */
  selector?: string;
  /** 等到该 CSS 选择器**不再可见**（如 loading 遮罩消失；等价于 `selector + hidden`）。 */
  gone?: string;
  /** `selector` 要等的状态；缺省 `visible`。只与 `selector` 搭配。 */
  state?: ElementState;
}

/** 元素条件实际要等的状态（`gone` 归一成 `hidden`，`selector` 缺省 `visible`）。 */
export function conditionState(cond: WaitCondition): ElementState | null {
  if (cond.gone) return "hidden";
  if (cond.selector) return cond.state ?? "visible";
  return null;
}

/** 状态的中文说法（进日志、轨迹与报告）。 */
export function describeState(state: ElementState): string {
  switch (state) {
    case "visible":
      return "可见";
    case "hidden":
      return "不可见或已移除";
    case "attached":
      return "已进入 DOM";
    case "detached":
      return "已离开 DOM";
  }
}

/** 条件的人类可读描述，用于日志、轨迹与报告。 */
export function describeCondition(cond: WaitCondition): string {
  if (cond.text) return `文本「${cond.text}」`;
  if (cond.gone) return `元素 ${cond.gone} 消失`;
  if (cond.selector) {
    return `元素 ${cond.selector} ${describeState(cond.state ?? "visible")}`;
  }
  return "（未指定条件）";
}

/** JSON 字面量（把外部输入安全地嵌进表达式，避免引号/换行把脚本拼坏）。 */
function literal(value: string | undefined): string {
  return value === undefined ? "null" : JSON.stringify(value);
}

/**
 * 轮询探针：**只做便宜的事**（`querySelector` + 可见性 + `textContent`），同步返回几个布尔。
 *
 * 可见性判定抄的是 bsk 自己的口径（`checkVisibility` + 非零盒子 + computed style 兜底）：
 * 这条探针是 `bsk wait-for-element` 不可用时的**降级路径**，两种路径对「可见」必须给同一个答案，
 * 否则「旧版 bsk 上这条用例通过、新版上超时」会变成一条查不出来的差异。
 *
 * 不在这里判 `innerText`：那是命中复核与超时取证的事（见 buildConfirmExpression）。
 */
export function buildProbeExpression(cond: WaitCondition): string {
  return [
    "(() => {",
    `  var SEL = ${literal(cond.selector)};`,
    `  var GONE = ${literal(cond.gone)};`,
    `  var TXT = ${literal(cond.text)};`,
    "  var out = {",
    "    selectorHit: false, selectorVisible: false,",
    "    gonePresent: false, goneVisible: false, textPresent: false,",
    "  };",
    "  var visible = function (el) {",
    "    if (!el) return false;",
    "    try {",
    "      if (el.checkVisibility) {",
    "        return !!el.checkVisibility({",
    "          checkOpacity: true, checkVisibilityCSS: true, contentVisibilityAuto: true,",
    "        });",
    "      }",
    "    } catch (e) {}",
    "    try {",
    "      var rect = el.getBoundingClientRect ? el.getBoundingClientRect() : null;",
    "      if (rect && !(rect.width > 0) && !(rect.height > 0)) return false;",
    "      var style = window.getComputedStyle ? window.getComputedStyle(el) : null;",
    "      if (!style) return true;",
    "      if (style.display === 'none' || style.visibility === 'hidden') return false;",
    "      if (style.opacity === '0' || style.opacity === 0) return false;",
    "      return true;",
    "    } catch (e) {",
    "      return false;",
    "    }",
    "  };",
    "  try {",
    "    if (SEL !== null) {",
    "      var el = document.querySelector(SEL);",
    "      out.selectorHit = !!el;",
    "      out.selectorVisible = visible(el);",
    "    }",
    "    if (GONE !== null) {",
    "      var goneEl = document.querySelector(GONE);",
    "      out.gonePresent = !!goneEl;",
    "      out.goneVisible = visible(goneEl);",
    "    }",
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
  /** `selector` 是否命中（命中不等于可见）。 */
  selectorHit: boolean;
  /** `selector` 是否命中**且**可见。 */
  selectorVisible: boolean;
  /** `gone` 是否还命中（还在 DOM 里）。 */
  gonePresent: boolean;
  /** `gone` 是否还命中**且**可见（`gone` 要等到它变 false）。 */
  goneVisible: boolean;
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
    selectorVisible: raw.selectorVisible === true,
    gonePresent: raw.gonePresent === true,
    goneVisible: raw.goneVisible === true,
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

/**
 * 探针是否已经可以判定命中（文本类条件还要等复核，因此这里不给结论）。
 *
 * 元素类条件按 `state` 判定，规则与 bsk 的 `ElementState::satisfied_by(attached, visible)` 一致——
 * 原生等待可用与否不该改变一条用例的结论。
 */
export function probeSaysMaybe(cond: WaitCondition, probe: ConditionProbe): boolean {
  if (cond.text) return probe.textPresent;
  if (cond.gone) return !probe.goneVisible;
  if (cond.selector) {
    switch (cond.state ?? "visible") {
      case "visible":
        return probe.selectorVisible;
      case "hidden":
        return !probe.selectorVisible;
      case "attached":
        return probe.selectorHit;
      case "detached":
        return !probe.selectorHit;
    }
  }
  return false;
}

/**
 * 元素类条件的末次探测证据，压成一行（超时报告与日志共用）。
 *
 * 措辞必须与 `describeNativeEvidence`（原生等待的超时证据）**逐字一致**：同一个条件
 * 在旧版 bsk（探针）与新版（原生）上给出两种说法，会让人以为是两回事。
 * 用「还在 DOM」而不是「命中」，是因为前者把「元素在不在」这个事实说全了，
 * 而「命中」在 gone 条件下读起来正好反过来。
 */
export function describeProbe(cond: WaitCondition, probe: ConditionProbe): string {
  if (cond.gone) {
    return `末次探测：还在 DOM=${probe.gonePresent}，可见=${probe.goneVisible}`;
  }
  return `末次探测：还在 DOM=${probe.selectorHit}，可见=${probe.selectorVisible}`;
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
