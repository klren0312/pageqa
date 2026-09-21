/**
 * 录制层：把一次带模型的运行里**成功执行过的浏览器操作**记成可回放的步骤。
 *
 * 两个关键判断：
 * - 只记成功的操作。失败的尝试是模型探索过程的一部分（它随后会重试别的元素），
 *   记下来只会让回放照着踩坑。
 * - 记语义定位符而不是 `@eN`。`@eN` 只在当时那次快照内有效（见 locator.ts）。
 */
import { buildLocator, type Locator } from "./locator.js";
import type { ReplayStep } from "./replay.js";
import { restorePlaceholders, type RunVarValue } from "./vars.js";

/** 工具层上报的一次执行（ok=false 表示 bsk 报错，录制时会被忽略）。 */
export interface ToolExecEvent {
  /** 工具名：navigate / snapshot / click / fill / upload / hover / scroll / wait / assert_text。 */
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
      case "wait": {
        const ms = Number(p["ms"]);
        this.steps.push({
          kind: "wait",
          step,
          ms: Number.isFinite(ms) && ms > 0 ? ms : 1000,
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
          // 靠 Jev 语义复核才成立的断言，回放的字符串匹配必然不成立，
          // 标记出来供回放给出提示（字面命中的断言则无需标记）。
          ...(event.semantic ? { semantic: true } : {}),
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
