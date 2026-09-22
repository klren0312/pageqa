/**
 * 会话批次账本：`/new` 开新会话时把上一批场景**归档**，而不是丢掉。
 *
 * 为什么必须归档：退出时的汇总报告与回放脚本都以「这个进程跑过的全部场景」为准。
 * `/new` 表达的是「我想重新开始」（清视口、清队列），不等于「这些场景没跑过」——
 * 静默丢掉的后果很具体：报告里少几条，而 `--emit-script` 会产出一份**看起来完整、
 * 实际缺场景**的回放脚本，比不写更危险（与 ADR-0005 决策七同一条理由）。
 *
 * 这个模块只有纯函数（输入是队列项与结果表），因此「归档不丢数据」这条不变量可以直接单测。
 */
import type { AgentRunResult } from "../agent.js";
import { emptyUsage, numberSteps, type SuiteMember, type TestReport } from "../report.js";
import type { ScenarioRecording } from "../replay.js";
import type { QueuedScenario, ScenarioOrigin } from "./queue.js";
import { t } from "../i18n.js";

/** 一批场景的快照：退出报告与回放脚本的输入。 */
export interface SessionBatch {
  /** 供套件汇总与文本报告使用的场景明细。 */
  members: SuiteMember[];
  /** 供文本报告标题使用的「场景名 + 来源」（与 `members` 一一对应）。 */
  names: { name: string; origin: string }[];
  /** 本批录制到的可回放步骤（已带来源）。 */
  recordings: ScenarioRecording[];
}

/** 场景来源的短标签由调用方注入（它要读界面语种与路径显示规则）。 */
export type OriginLabel = (origin: ScenarioOrigin) => string;

/**
 * 给「没有结果的场景」造一份最小报告。
 *
 * 典型是排队中被 `/cancel`、或 Ctrl+C 时还没轮到的场景——如实说「未运行」，
 * 而不是伪装成通过（那会让汇总报告说谎）。
 */
function notRunReport(item: QueuedScenario): TestReport {
  return {
    status: "cancelled",
    cancelReason:
      (item.cancelNote ?? t("tui.notExecuted")) + t("tui.notRunSuffix"),
    assertions: [],
    transcript: "",
    steps: numberSteps(item.body).steps,
    usage: emptyUsage(),
  };
}

/** 把当前队列（含已结束的场景）拍成一批快照。 */
export function snapshotBatch(
  items: readonly QueuedScenario[],
  results: ReadonlyMap<number, AgentRunResult>,
  originLabel: OriginLabel,
): SessionBatch {
  const members: SuiteMember[] = items.map((item) => {
    const r = results.get(item.id);
    const origin = originLabel(item.origin);
    return r
      ? { name: item.name, report: r.report, usage: r.usage, origin }
      : {
          name: item.name,
          report: notRunReport(item),
          usage: emptyUsage(),
          origin,
        };
  });
  const names = items.map((i) => ({
    name: i.name,
    origin: originLabel(i.origin),
  }));
  const recordings = items
    .filter((i) => i.state !== "cancelled")
    .flatMap((i) =>
      // 录制带上来源：调用方据此按来源拆回放脚本（见 ADR-0005 决策七）。
      (results.get(i.id)?.recordings ?? []).map((r) => ({
        ...r,
        sourcePath: i.origin.path,
      })),
    );
  return { members, names, recordings };
}

/** 把多批（归档的 + 当前的）合成一批：退出报告覆盖整个进程跑过的全部场景。 */
export function combineBatches(batches: readonly SessionBatch[]): SessionBatch {
  return {
    members: batches.flatMap((b) => b.members),
    names: batches.flatMap((b) => b.names),
    recordings: batches.flatMap((b) => b.recordings),
  };
}
