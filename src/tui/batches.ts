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
import type { AgentRunResult } from "../agent/agent.js";
import { emptyUsage, numberSteps, type SuiteMember, type TestReport } from "../report/report.js";
import type { ScenarioRecording } from "../agent/replay.js";
import type { QueuedScenario, ScenarioOrigin } from "./queue.js";
import { t } from "../shared/i18n.js";

/** 一批场景的快照：退出报告与回放脚本的输入。 */
export interface SessionBatch {
  /** 供套件汇总与文本报告使用的场景明细。 */
  members: SuiteMember[];
  /** 供文本报告标题使用的「场景名 + 来源」（与 `members` 一一对应）。 */
  names: { name: string; origin: string }[];
  /** 本批录制到的可回放步骤（已带来源）。 */
  recordings: ScenarioRecording[];
  /**
   * 本批场景**实际执行**的墙钟（毫秒，{@link executionSpanMs}）。
   *
   * 交互模式的总耗时要的是它，而不是「从进会话到退出」那一段：后者把用户打字、
   * 思考、等 `/run` 的空闲全算成了测试耗时（一次会话动辄挂着几十分钟）。
   */
  executionMs: number;
}

/**
 * 一批场景**实际执行**的墙钟（毫秒）：各场景 `[startedAt, finishedAt]` 区间的**并集**长度。
 *
 * 为什么不能把各场景的 `durationMs` 相加：并发时它们的墙钟互相重叠，相加会把重叠部分
 * 算两遍。而用户体感是「同时跑的」——并在 2 个场景时最多等于两者之和、最少等于最长那个，
 * 真实值落在中间。并集正是那个真实值：从「第一个场景开跑」到「最后一个跑完」中间
 * 真正有场景在跑的时长。
 *
 * 空闲时段（用户打字、思考、等 `/run`）天然不在任何区间里，因此自动被排除——
 * 交互会话动辄挂着几十分钟，把发呆算成测试耗时对自己解释不了。
 *
 * 队列里一条都没跑（全在排队中被取消）时返回 0：没有执行就没有耗时，
 * 调用方据此显示「未记录」而不是一个看起来测过的 `0ms`。
 */
export function executionSpanMs(
  items: readonly Pick<QueuedScenario, "startedAt" | "finishedAt">[],
  now: number = Date.now(),
): number {
  // 只要**起止都齐**的区间：还在跑的用 now 补一个右端，跑过的才是完整事实。
  // 没有起点的（还在排队）整条跳过——它没占过任何时间。
  const spans: [number, number][] = [];
  for (const item of items) {
    const start = item.startedAt;
    if (typeof start !== "number") continue;
    const end = typeof item.finishedAt === "number" ? item.finishedAt : now;
    if (end > start) spans.push([start, end]);
  }
  if (spans.length === 0) return 0;
  spans.sort((a, b) => a[0] - b[0]);
  let covered = 0;
  let [curStart, curEnd] = spans[0];
  for (let i = 1; i < spans.length; i++) {
    const [start, end] = spans[i];
    if (start > curEnd) {
      // 与当前区间不重叠：结算前一段，从这段重新起算。
      covered += curEnd - curStart;
      curStart = start;
      curEnd = end;
      continue;
    }
    // 重叠（或首尾相接）：并集只向右延伸，重叠部分不重复计数。
    if (end > curEnd) curEnd = end;
  }
  covered += curEnd - curStart;
  return covered;
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
  return { members, names, recordings, executionMs: executionSpanMs(items) };
}

/** 把多批（归档的 + 当前的）合成一批：退出报告覆盖整个进程跑过的全部场景。 */
export function combineBatches(batches: readonly SessionBatch[]): SessionBatch {
  // 执行墙钟按批相加，**不做跨批去重**：`/new` 只在队列空闲时允许归档（见 app.ts 的
  // newSession），因此各批的执行区间互不重叠，相加就是并集。
  return {
    members: batches.flatMap((b) => b.members),
    names: batches.flatMap((b) => b.names),
    recordings: batches.flatMap((b) => b.recordings),
    executionMs: batches.reduce((n, b) => n + b.executionMs, 0),
  };
}
