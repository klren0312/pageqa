/**
 * 缺陷的类型定义（见 ADR-0022）。
 *
 * 放在 shared 而不是 report 里：工具层（bsk / miniprogram）要产出缺陷，报告层要渲染它，
 * 两边都依赖 shared 不会把「驱动」与「报告」绑在一起。
 */

/** 缺陷严重度：模型上报时必须给一档；未归因缺陷没有。 */
export type DefectSeverity = "critical" | "normal" | "minor";

/**
 * 缺陷类型。
 *
 * `unattributed` 只出现在确定性兜底生成的缺陷上——没有一个模型判断过它，所以不能借
 * `other` 冒充「已归因」。它的严重度也是空的，渲染成「未定级」。
 */
export type DefectKind =
  | "functional"
  | "ui"
  | "error"
  | "api"
  | "performance"
  | "other"
  | "unattributed";

/**
 * 一条缺陷：**属于被测产品的问题**，与「这次测试没跑成」分开（ADR-0022）。
 *
 * 断言回答「这条用例过没过」，缺陷回答「产品有什么问题」。因此缺陷不参与 PASS/FAIL
 * 判定：一条全部断言通过的用例也可以带缺陷（例如页面在报 console error）。
 */
export interface Defect {
  /** 一句话说清是什么问题。 */
  title: string;
  /** 严重度；未归因缺陷没有（没人判断过）。 */
  severity?: DefectSeverity;
  kind: DefectKind;
  /** 期望的行为或结果。 */
  expectation: string;
  /** 实际观察到的行为或结果。 */
  actual: string;
  /** 证据（页面文本、控制台报错、接口状态等）。 */
  evidence?: string;
  /** 出问题的场景名（套件汇总时补；单场景报告不写）。 */
  scenario?: string;
  /** 对应用例第 k 步（1 起）；对不上时没有。 */
  step?: number;
  /** 报缺陷时的页面地址；读不到时没有。 */
  url?: string;
}

/**
 * 模型通过 `report_defect` 上报的缺陷：场景、步骤、页面地址由工具层与报告层补齐，
 * 因此模型只需给出它能观察到的部分。
 */
export interface DefectDraft {
  title: string;
  severity: DefectSeverity;
  kind: Exclude<DefectKind, "unattributed">;
  expectation: string;
  actual: string;
  evidence: string;
  /** 报缺陷时的页面地址（工具层读不到就不带）。 */
  url?: string;
}

/** 模型可选的严重度取值（工具 schema 的 enum 与校验共用同一份）。 */
export const DEFECT_SEVERITIES: readonly DefectSeverity[] = [
  "critical",
  "normal",
  "minor",
];

/** 模型可选的类型取值；`unattributed` 刻意不在其中（那是兜底专用）。 */
export const DEFECT_KINDS: readonly Exclude<DefectKind, "unattributed">[] = [
  "functional",
  "ui",
  "error",
  "api",
  "performance",
  "other",
];
