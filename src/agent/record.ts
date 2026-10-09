/**
 * 录制层：把一次带模型的运行里**成功执行过的浏览器操作**记成可回放的步骤。
 *
 * 两个关键判断：
 * - 只记成功的操作。失败的尝试是模型探索过程的一部分（它随后会重试别的元素），
 *   记下来只会让回放照着踩坑。
 * - 记语义定位符而不是 `@eN`。`@eN` 只在当时那次快照内有效（见 locator.ts）。
 */
import { buildLocator, type Locator } from "../shared/locator.js";
import type { ReplayStep } from "./replay.js";
import { restorePlaceholders, type RunVarValue } from "./vars.js";

/** 工具层上报的一次执行（ok=false 表示 bsk 报错，录制时会被忽略）。 */
export interface ToolExecEvent {
  /** 工具名：navigate / snapshot / click / fill / upload / download / hover / scroll / wait / assert_text。 */
  name: string;
  /** 模型给出的入参。 */
  params: Record<string, unknown>;
  ok: boolean;
  /** 本次操作前页面最后一次快照文本（用于构造语义定位符）。 */
  lastSnapshot: string;
  /** 该断言是否**靠 Jev 语义判断才成立**（仅 assert_text 会上报；未上报视为否）。 */
  semantic?: boolean;
}

/**
 * 从模型输出的自述里取「第 k 步完成」，用于把操作映射回用例步骤号。
 *
 * 模型写法并不统一，实测见过「第 3 步完成」「第3步已完成」「步骤 3 完成」「步骤 3：完成」。
 * 只认第一种会让整场运行的步骤映射全部落到第 1 步——比映射不出来更糟（报告会指错用例行）。
 */
const STEP_DONE_PATTERNS = [
  /第\s*(\d+)\s*步\s*(?:已)?\s*完\s*成/g,
  /步\s*骤\s*(\d+)\s*(?:已)?\s*完\s*成/g,
];

/** 自述可能被流式输出切在「完/成」之间，保留一小段尾巴拼回来再匹配。 */
const NARRATION_TAIL = 64;

export class Recorder {
  private readonly steps: ReplayStep[] = [];
  private lastCompletedStep = 0;
  /** 整场运行是否解析到过步骤自述；一次都没解析到时不给步骤号（见 recorded）。 */
  private sawNarration = false;
  /** 自述的尾部缓冲，用于跨 delta 匹配（流式输出会把「完成」切开）。 */
  private tail = "";

  constructor(private readonly vars: RunVarValue[] = []) {}

  /**
   * 喂入模型输出的文本增量，跟踪「已完成到第几步」。
   *
   * 模型是先调用工具、再自述「第 k 步完成：…」，因此某个工具调用归属哪一步只能用
   * 「它之前最后一次自述 + 1」来近似——映射不准时退化为 null，不影响回放正确性。
   */
  noteText(delta: string): void {
    // 在「上一段尾巴 + 本次增量」上匹配：只取已完成的步骤号（取最大值），
    // 因此重叠窗口造成的重复命中无害。
    const window = this.tail + delta;
    for (const pattern of STEP_DONE_PATTERNS) {
      pattern.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = pattern.exec(window)) !== null) {
        this.sawNarration = true;
        this.lastCompletedStep = Math.max(this.lastCompletedStep, Number(m[1]));
      }
    }
    this.tail = window.slice(-NARRATION_TAIL);
  }

  /** 记录一次工具执行。仅成功的操作会进入脚本；`snapshot` 不记录（回放不需要「看」）。 */
  noteTool(event: ToolExecEvent): void {
    if (!event.ok) return;
    const step = this.lastCompletedStep + 1;
    const p = event.params ?? {};
    const text = (key: string): string => String(p[key] ?? "");
    const restore = (value: string): string =>
      restorePlaceholders(value, this.vars);
    /** target + 定位符（target 为空时不做定位符解析）。 */
    const targetOf = (): { target: string; locator: Locator | null } => {
      const target = restore(text("target").trim());
      const locator = target
        ? buildLocator(target, event.lastSnapshot)
        : null;
      return {
        target,
        // 定位符的「可访问名」同样要还原占位符：列表里点的是「刚刚创建的那条」
        // （如 `自动化测试产品${timestamp}`），名字里若写死录制当次的时间戳，
        // 回放时新时间戳对不上，这一步必然定位失败。
        locator: locator
          ? { ...locator, name: restore(locator.name) }
          : null,
      };
    };

    switch (event.name) {
      case "navigate":
        this.steps.push({
          kind: "navigate",
          step,
          url: restore(text("url")),
        });
        return;
      case "click":
      case "hover":
      case "scroll": {
        const { target, locator } = targetOf();
        if (!target) return;
        this.steps.push({ kind: event.name, step, target, locator });
        return;
      }
      case "fill": {
        const { target, locator } = targetOf();
        if (!target) return;
        const raw = text("value");
        const value = restore(raw);
        this.steps.push({
          kind: "fill",
          step,
          target,
          value,
          // 占位符被还原时留一份「录制当次真正填了什么」，便于人工核对
          ...(value !== raw ? { recordedValue: raw } : {}),
          locator,
        });
        return;
      }
      case "select_option": {
        const { target, locator } = targetOf();
        if (!target) return;
        const option = restore(text("option")).trim();
        if (!option) return;
        this.steps.push({ kind: "select_option", step, target, option, locator });
        return;
      }
      case "pick_date": {
        const { target, locator } = targetOf();
        if (!target) return;
        const date = text("date").trim();
        if (!date) return;
        // 日期同样按占位符写法存：用例写 `${date}` 时，回放要按**当天**重新展开，
        // 把录制那天的具体日期写死会让这条用例从第二天起就失败（与 fill.value 同一条规则）。
        // 范围控件的结束日期同理，一起存。
        const endDate = text("endDate").trim();
        this.steps.push({
          kind: "pick_date",
          step,
          target,
          date,
          ...(endDate ? { endDate } : {}),
          locator,
        });
        return;
      }
      case "upload": {
        const { target, locator } = targetOf();
        this.steps.push({
          kind: "upload",
          step,
          file: restore(text("file")),
          ...(target ? { target, locator } : { locator: null }),
        });
        return;
      }
      case "download": {
        const { target, locator } = targetOf();
        // 没有触发元素这一步就没有意义：下载只能由本工具自己点击触发（bsk 的 download 要求 target）。
        if (!target) return;
        const rawOut = text("out");
        const expectName = text("expectName").trim();
        const ms = Number(p["timeoutMs"]);
        this.steps.push({
          kind: "download",
          step,
          target,
          locator,
          // 落盘路径与文件名期望按占位符写法存：显式路径里写 `${date}` 的用例，
          // 回放时要重新展开（与 fill.value 同一条规则）。
          ...(rawOut ? { out: restore(rawOut) } : {}),
          ...(expectName ? { expectName } : {}),
          // 只有用例真的指定过等待上限才写进脚本：写死一个默认值会让将来改默认值失效。
          ...(Number.isFinite(ms) && ms > 0 ? { timeoutMs: ms } : {}),
        });
        return;
      }
      case "press": {
        // 键名是这一步的主体；target 只是「先聚焦到哪」（可选，多数时候按当前焦点）。
        const key = restore(text("key")).trim();
        if (!key) return;
        const { target, locator } = targetOf();
        const modifiers = text("modifiers").trim();
        const ms = Number(p["holdMs"]);
        this.steps.push({
          kind: "press",
          step,
          key,
          ...(target ? { target } : {}),
          locator: target ? locator : null,
          ...(modifiers ? { modifiers } : {}),
          // 与 download / wait_for 同一条规则：只有模型明确给过才写进脚本，
          // 写死一个默认值会让将来改默认值失效。
          ...(Number.isFinite(ms) && ms > 0 ? { holdMs: ms } : {}),
        });
        return;
      }
      case "wheel": {
        // 滚轮是**动作**：录下增量与落点，回放时重新滚一遍——无限加载那类页面不滚就没有
        // 内容可断言，跳过它等于跳过整个加载过程。
        const { target, locator } = targetOf();
        const dx = Number(p["deltaX"]);
        const dy = Number(p["deltaY"]);
        const modifiers = text("modifiers").trim();
        this.steps.push({
          kind: "wheel",
          step,
          ...(target ? { target } : {}),
          locator: target ? locator : null,
          // 增量为 0 是默认值，不写进脚本（写死它等于把「当时的默认」固化，将来改默认值就失效）。
          ...(Number.isFinite(dx) && dx !== 0 ? { deltaX: dx } : {}),
          ...(Number.isFinite(dy) && dy !== 0 ? { deltaY: dy } : {}),
          ...(modifiers ? { modifiers } : {}),
        });
        return;
      }
      case "focus": {
        // 焦点变化是**动作**而不是查询：它会触发页面自己的 focus/blur 处理，
        // 回放必须重做，否则「失焦后出现报错提示」那条断言在回放里必然失败。
        const { target, locator } = targetOf();
        // 没有目标就没有这一步（工具层已拦过，这里再兜一次，免得把空条件写进脚本）。
        if (!target) return;
        this.steps.push({ kind: "focus", step, target, locator });
        return;
      }
      case "blur": {
        const { target, locator } = targetOf();
        if (!target) return;
        this.steps.push({ kind: "blur", step, target, locator });
        return;
      }
      case "screenshot": {
        // 录「截什么」，不录「截到哪」：默认路径带时间戳、每次运行都不同，把这一次的文件名
        // 写进脚本，回放只会把图覆盖到一堆没人看的旧名字里。用例显式给了 out 才照写。
        if (p["fullPage"] === true) {
          this.steps.push({ kind: "screenshot", step, fullPage: true, locator: null });
          return;
        }
        const { target, locator } = targetOf();
        const rawOut = text("out").trim();
        this.steps.push({
          kind: "screenshot",
          step,
          ...(target ? { target } : {}),
          // 元素截图带定位符：回放时在新快照里重新解析（与 click 同一条规则）。
          locator: target ? locator : null,
          ...(rawOut ? { out: restore(rawOut) } : {}),
        });
        return;
      }
      case "wait": {
        const ms = Number(p["ms"]);
        this.steps.push({
          kind: "wait",
          step,
          ms: Number.isFinite(ms) && ms > 0 ? ms : 1000,
        });
        return;
      }
      case "wait_for": {
        // 条件等待按**条件本身**录进脚本：回放时重新等同一个条件，而不是把这次等到的时长写死
        // （写死就退化成了 wait，正是这个工具要消灭的东西）。
        const cond = {
          ...(text("text") ? { text: restore(text("text")) } : {}),
          ...(text("selector") ? { selector: text("selector") } : {}),
          ...(text("gone") ? { gone: text("gone") } : {}),
        };
        // 三种条件互斥且必居其一，工具层已校验过；这里再兜一次，避免把空条件写进脚本。
        if (Object.keys(cond).length !== 1) return;
        const ms = Number(p["timeoutMs"]);
        this.steps.push({
          kind: "wait_for",
          step,
          ...cond,
          // 与 download 同一条规则：只有模型明确给过上限才写进脚本，
          // 写死一个默认值会让将来改默认值失效。
          ...(Number.isFinite(ms) && ms > 0 ? { timeoutMs: ms } : {}),
        });
        return;
      }
      case "assert_text": {
        const raw = text("expectation");
        if (!raw) return;
        const expectation = restore(raw);
        this.steps.push({
          kind: "assert_text",
          step,
          expectation,
          ...(expectation !== raw ? { recordedExpectation: raw } : {}),
          // 反向断言（断言页面不包含）必须原样录进脚本：回放若按正向的字符串匹配做，
          // 一条本该通过的断言会必然失败——方向丢了，脚本就跑错了意思。
          ...(p["absent"] === true ? { absent: true } : {}),
          // 靠 Jev 语义复核才成立的断言，回放的字符串匹配必然不成立，
          // 标记出来供回放给出提示（字面命中的断言则无需标记）。
          ...(event.semantic ? { semantic: true } : {}),
        });
        return;
      }
      case "assert_no_console_error": {
        // 录的是**断言条件本身**（要看哪一级、放行哪些噪音），不是这次的结果：
        // 回放时要重新读一遍当时的 console 缓冲，把这次恰好没有报错写成「通过」，
        // 等于把一个会变的判据冻结成一个常数。
        const rawIgnore = p["ignore"];
        const ignore = Array.isArray(rawIgnore)
          ? rawIgnore
              .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
              .map((s) => restore(s.trim()))
          : [];
        this.steps.push({
          kind: "assert_no_console_error",
          step,
          ...(ignore.length > 0 ? { ignore } : {}),
          ...(p["warnings"] === true ? { warnings: true } : {}),
        });
        return;
      }
      case "assert_network": {
        const url = restore(text("url")).trim();
        // 没有 url 这一步就没有判定依据（工具层已拦过，这里再兜一次，避免把空条件写进脚本）。
        if (!url) return;
        const status = text("status").trim();
        // 方法统一大写：协议与工具层都是这么比的，脚本里留小写会让同一个条件看起来不一样。
        const method = text("method").trim().toUpperCase();
        this.steps.push({
          kind: "assert_network",
          step,
          url,
          ...(status ? { status } : {}),
          ...(method ? { method } : {}),
        });
        return;
      }
      default:
        // snapshot 以及未知工具：不进入回放脚本
        return;
    }
  }

  /**
   * 当前已录制的步骤快照。
   *
   * 整场运行一次都没解析到步骤自述时，把步骤号一律留空：
   * 全部指向「第 1 步」是自信的错误，报告会指着用例第一行说「卡在这里」，
   * 比如实留空更误导。
   */
  get recorded(): ReplayStep[] {
    const steps = [...this.steps];
    if (this.sawNarration) return steps;
    return steps.map((s) => ({ ...s, step: null }));
  }
}
