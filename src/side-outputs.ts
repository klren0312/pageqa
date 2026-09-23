/**
 * 旁路产物清单：一次运行结束后落盘的东西（测试报告 + 回放脚本）该怎么向用户交代。
 *
 * 三条出口（批处理 / 回放 / 交互）在收尾各调用一次 `emitSideOutputs`，逐行交给 `info()`
 * —— 清单只走 stderr（交互模式下进视口），**绝不进 stdout**：旁路产物的存在不该改变
 * stdout 的报告契约（见 ADR-0011 决策五、ADR-0002 补充一节）。
 *
 * 被 `/setting` 关掉的项要显式说明原因，而不是静默省略：默认是「开」，看不到产物却
 * 不给理由，用户只会以为坏了（见 ADR-0011 决策五）。
 */
import { readSideOutputPrefs, type SideOutputPrefs } from "./config.js";
import { t } from "./i18n.js";
import { info } from "./log.js";
import { writeHtmlReport } from "./report-html.js";
import type { TestReport } from "./report.js";

/** 测试报告的落盘结果。 */
export type ReportOutcome =
  | { kind: "written"; path: string }
  | { kind: "off" }
  /** 本次一条用例都没跑（空会话，或全部未开始就被取消）：没有可报告的东西，不落盘。 */
  | { kind: "skipped" }
  | { kind: "failed"; error: string };

/**
 * 回放脚本的落盘结果。
 *
 * `none` 与 `no-target` 刻意分开：前者是「跑过，但没有任何可录制的动作」（模型一步都没
 * 成功），后者是「这些场景根本没有落点文件」。混成一句，用户就无从判断该改用例还是该
 * 先用 `/run` 打开一个用例文件。
 */
export type ScriptOutcome =
  | {
      kind: "written";
      paths: string[];
      /** 同一次运行里被跳过的「无落点」场景数（多于 0 时清单追加一行说明）。 */
      noTarget?: number;
    }
  | { kind: "off" }
  | { kind: "none" }
  | { kind: "no-target"; count: number }
  | { kind: "failed"; error: string }
  /** 本次运行不使用脚本产物：回放模式用的就是既有脚本，清单不列这一行。 */
  | { kind: "na" };

/** 渲染清单的整行（含 i18n 文案里的 `[pageqa]` 前缀），供 info() 逐行输出。 */
export function renderSideOutputLines(
  report: ReportOutcome,
  script: ScriptOutcome,
): string[] {
  const lines = [t("log.sideOutputsTitle")];

  switch (report.kind) {
    case "written":
      lines.push(t("log.sideOutputReport", { path: report.path }));
      break;
    case "off":
      lines.push(t("log.sideOutputReportOff"));
      break;
    case "skipped":
      lines.push(t("log.sideOutputReportSkipped"));
      break;
    case "failed":
      lines.push(t("log.sideOutputReportFailed", { msg: report.error }));
      break;
  }

  switch (script.kind) {
    case "written":
      for (const path of script.paths) {
        lines.push(t("log.sideOutputScript", { path }));
      }
      if (script.paths.length === 1) {
        // 只有一份脚本时给一条可以直接复制粘贴的命令；多份时给不出唯一答案。
        lines.push(t("log.sideOutputReplay", { path: script.paths[0] }));
      } else if (script.paths.length > 1) {
        lines.push(t("log.sideOutputReplayMany"));
      }
      if (script.noTarget) {
        lines.push(t("log.sideOutputScriptNoTarget", { n: script.noTarget }));
      }
      break;
    case "off":
      lines.push(t("log.sideOutputScriptOff"));
      break;
    case "none":
      lines.push(t("log.sideOutputScriptNone"));
      break;
    case "no-target":
      lines.push(t("log.sideOutputScriptNoTarget", { n: script.count }));
      break;
    case "failed":
      lines.push(t("log.sideOutputScriptFailed", { msg: script.error }));
      break;
    case "na":
      break;
  }

  return lines;
}

/** 打出清单（永不抛错：清单本身出问题也不该改退出码）。 */
export function emitSideOutputs(
  report: ReportOutcome,
  script: ScriptOutcome,
): void {
  try {
    for (const line of renderSideOutputLines(report, script)) info(line);
  } catch (err) {
    info(
      t("log.sideOutputReportFailed", {
        msg: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

/**
 * 这次运行有没有「跑过用例」——没有就不该留下报告文件。
 *
 * - 单场景报告（批处理 / 回放）来自一次真实的用例执行，恒为真。
 * - 套件报告看两点：只要有**一条跑完**（PASS/FAIL）就算跑过；全是「已取消」时再看有没有
 *   真的调用过模型——被中止的场景留下的是半截真实轨迹（还烧了 token），比空会话更有留档
 *   价值；而「一条都没开始就退出」的会话两者皆无。
 */
export function hasRunScenarios(report: TestReport): boolean {
  const scenarios = report.scenarios;
  if (scenarios === undefined) return true;
  if (scenarios.some((s) => s.status !== "cancelled")) return true;
  return (report.usage?.calls ?? 0) > 0;
}

/**
 * 按开关写测试报告并给出结果；**永不抛错**。
 *
 * 与回放脚本不同，报告是「顺手留档」：写失败只该是一条说明，绝不能顶掉 stdout 报告或
 * 改退出码（ADR-0011 决策五）。开关关掉时连 `pageqa-report/` 目录都不创建；一条用例都
 * 没跑过时同样不落盘——空的报告文件只会让人以为「跑过但什么都没发生」。
 */
export function writeReportSideOutput(
  report: TestReport,
  prefs?: SideOutputPrefs,
  baseDir?: string,
): ReportOutcome {
  const enabled = (prefs ?? readSideOutputPrefs()).htmlReport;
  if (!enabled) return { kind: "off" };
  if (!hasRunScenarios(report)) return { kind: "skipped" };
  try {
    const { path } = writeHtmlReport(report, baseDir);
    return { kind: "written", path };
  } catch (err) {
    return {
      kind: "failed",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
