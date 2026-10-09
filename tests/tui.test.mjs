import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  KeybindingsManager,
  TUI_KEYBINDINGS,
  sliceByColumn,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { splitScenarios } from "../dist/agent/agent.js";
import { debugLog, info, setDebug, setSink } from "../dist/shared/log.js";
import {
  addUsage,
  buildReport,
  emptyUsage,
  renderSuiteText,
  statusTag,
  summarizeSuite,
} from "../dist/report/report.js";
import { groupRecordingsBySource } from "../dist/agent/replay.js";
import {
  buildPickPrompt,
  displayPath,
  parsePick,
  resolveCaseFile,
} from "../dist/tui/case-source.js";
import { ScenarioQueue } from "../dist/tui/queue.js";
import { combineBatches, snapshotBatch } from "../dist/tui/batches.js";
import {
  arrowKeysBelongToLog,
  KEYBINDINGS,
  WHEEL_SCROLL_LINES,
} from "../dist/tui/keys.js";
import {
  appendScenarioToCaseFile,
  loadCaseScenarios,
  scenarioNameFromBody,
  scenariosFromInput,
} from "../dist/tui/writeback.js";
import {
  MARQUEE_FRAME_MS,
  MARQUEE_GAP_COLUMNS,
  MARQUEE_HOLD_FRAMES,
  MarqueeScroller,
  marqueePeriod,
  marqueeWindow,
} from "../dist/tui/marquee.js";

// 纯单元测试：不依赖浏览器、LLM 与真实 TTY。

/** 队列测试里的用例来源：都当作来自同一个用例文件。 */
const FILE_ORIGIN = { kind: "file", path: "case.md" };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 等队列彻底停下来（跑着的跑完、待办清空）。 */
async function waitIdle(queue, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (queue.running() || queue.waiting().length > 0) {
    if (Date.now() > deadline) throw new Error("队列未在预期时间内结束");
    await sleep(5);
  }
}

describe("追加场景的拆分与命名", () => {
  test("写了 ## 标题就用它，正文是标题之后的部分", () => {
    assert.deepEqual(scenariosFromInput("## 登录\n打开 x\n断言 y"), [
      { name: "登录", body: "打开 x\n断言 y" },
    ]);
  });

  test("没写标题时退回首行摘要（而不是统一叫「场景 1」）", () => {
    const [sc] = scenariosFromInput("打开 https://example.com\n断言标题包含 Example");
    assert.equal(sc.name, "打开 https://example.com");
    assert.equal(sc.body, "打开 https://example.com\n断言标题包含 Example");
  });

  test("一次提交可以带多个 ## 场景", () => {
    const names = scenariosFromInput("## A\n打开 a\n## B\n打开 b").map(
      (s) => s.name,
    );
    assert.deepEqual(names, ["A", "B"]);
  });

  test("空输入不产生场景", () => {
    assert.deepEqual(scenariosFromInput("   \n\n  "), []);
  });

  test("首行过长时截断（免得把整段用例当标题写进文件）", () => {
    const long = "打开很长的页面名称".repeat(10);
    const name = scenarioNameFromBody(long);
    assert.equal(name.length, 41); // 40 + 省略号
    assert.ok(name.endsWith("…"));
  });
});

describe("追加场景写回源用例文件", () => {
  const dir = mkdtempSync(join(tmpdir(), "pageqa-tui-"));

  test("写回后能被 splitScenarios 原样读回（写-读必须一致）", () => {
    const p = join(dir, "case.md");
    writeFileSync(
      p,
      "## 已有场景\n\n打开 https://example.com\n断言标题包含 Example\n",
    );
    const added = {
      name: "新场景",
      body: "打开 https://example.org\n断言页面包含 Hello",
    };
    appendScenarioToCaseFile(p, added);

    const scenarios = splitScenarios(readFileSync(p, "utf8"));
    assert.deepEqual(
      scenarios.map((s) => s.name),
      ["已有场景", "新场景"],
    );
    assert.equal(scenarios[0].body, "打开 https://example.com\n断言标题包含 Example");
    assert.equal(scenarios[1].body, added.body);
  });

  test("占位符原样写回，绝不写展开后的具体值（否则下次运行必撞名）", () => {
    const p = join(dir, "ph.md");
    writeFileSync(p, "## A\n\n打开 x\n");
    appendScenarioToCaseFile(p, {
      name: "B",
      body: "填写产品名称 `${timestamp}` 并断言列表出现它",
    });
    const text = readFileSync(p, "utf8");
    assert.match(text, /\$\{timestamp\}/);
    assert.equal(text.includes("2026"), false);
  });

  test("源文件不以换行结尾时也能正确分隔出一个新场景", () => {
    const p = join(dir, "nonl.md");
    writeFileSync(p, "## A\n\n打开 x"); // 没有结尾换行
    appendScenarioToCaseFile(p, { name: "B", body: "打开 y" });
    const scenarios = splitScenarios(readFileSync(p, "utf8"));
    assert.deepEqual(
      scenarios.map((s) => s.name),
      ["A", "B"],
    );
    assert.equal(scenarios[0].body, "打开 x");
    assert.equal(scenarios[1].body, "打开 y");
  });

  test("空文件也能写入（首次追加）", () => {
    const p = join(dir, "empty.md");
    writeFileSync(p, "");
    appendScenarioToCaseFile(p, { name: "B", body: "打开 y" });
    const scenarios = splitScenarios(readFileSync(p, "utf8"));
    assert.deepEqual(
      scenarios.map((s) => s.name),
      ["B"],
    );
  });
});

describe("日志视口的滚动设置", () => {
  const kb = new KeybindingsManager(TUI_KEYBINDINGS, KEYBINDINGS);

  test("逐行滚动绑到 Ctrl+↑/Ctrl+↓（pi-tui 默认没有键位，按了等于没反应）", () => {
    assert.equal(kb.matches("\x1b[1;5A", "tui.altScreen.lineUp"), true);
    assert.equal(kb.matches("\x1b[1;5B", "tui.altScreen.lineDown"), true);
    // 上下方向键仍归编辑器（移动光标/自动补全），滚动不许把它们抢走
    assert.equal(kb.matches("\x1b[A", "tui.altScreen.lineUp"), false);
    assert.equal(kb.matches("\x1b[B", "tui.altScreen.lineDown"), false);
    assert.deepEqual(kb.getKeys("tui.editor.cursorUp"), ["up"]);
    assert.deepEqual(kb.getKeys("tui.editor.cursorDown"), ["down"]);
  });

  test("历史输入挪到 Ctrl+P/Ctrl+N（↑/↓ 要让给日志滚动）", () => {
    assert.equal(kb.matches("\x10", "tui.editor.historyPrevious"), true);
    assert.equal(kb.matches("\x0e", "tui.editor.historyNext"), true);
    assert.equal(kb.matches("\x1b[A", "tui.editor.historyPrevious"), false);
    assert.equal(kb.matches("\x1b[B", "tui.editor.historyNext"), false);
  });

  test("只覆盖 altScreen 与历史键位，编辑器的编辑键（Ctrl+U/Ctrl+D/Ctrl+W…）一个不碰", () => {
    for (const id of Object.keys(KEYBINDINGS)) {
      assert.match(id, /^tui\.(altScreen|editor\.history)/);
    }
    assert.deepEqual(kb.getKeys("tui.editor.deleteToLineStart"), ["ctrl+u"]);
    assert.deepEqual(kb.getKeys("tui.editor.deleteCharForward"), [
      "delete",
      "ctrl+d",
    ]);
    assert.deepEqual(kb.getKeys("tui.editor.deleteWordBackward"), [
      "ctrl+w",
      "alt+backspace",
    ]);
  });

  test("翻页与首尾仍归视口（回归保护：这两个键是「日志能滚」的底线）", () => {
    assert.deepEqual(kb.getKeys("tui.altScreen.pageUp"), ["pageUp"]);
    assert.deepEqual(kb.getKeys("tui.altScreen.pageDown"), ["pageDown"]);
    // 首尾归 Ctrl+Home / Ctrl+End：pi-tui 1.1.0 把它们从 Home/End 挪开了，因为 Home/End
    // 是输入框的光标键，全局绑给视口滚动会让「在输入框里按 End」变得含义不明。
    // 这里跟随上游默认值——它既保住了「跳到首尾」，又不跟编辑器抢键。
    assert.deepEqual(kb.getKeys("tui.altScreen.top"), ["ctrl+home"]);
    assert.deepEqual(kb.getKeys("tui.altScreen.bottom"), ["ctrl+end"]);
  });

  test("我们自己的键位之间不冲突（同键双绑会让按键归属含糊）", () => {
    assert.deepEqual(kb.getConflicts(), []);
  });

  test("滚轮一格不止一行：默认 1 行滚起来像没反应", () => {
    assert.ok(WHEEL_SCROLL_LINES >= 3, `实际 ${WHEEL_SCROLL_LINES}`);
  });
});

/**
 * 「滚轮滚不动日志、反而翻出输入框历史」的根因：一部分终端把滚轮翻译成 ↑/↓ 送进来
 * （VS Code / xterm.js 的全屏缓冲就是这样）。两者字节相同、无法区分，只能按上下文分派。
 */
describe("↑/↓ 归谁：日志视口还是输入框", () => {
  const state = (over) => ({
    text: "",
    overlayOpen: false,
    autocompleteShowing: false,
    ...over,
  });

  test("输入框为空 → 归日志（滚轮因此能滚）", () => {
    assert.equal(arrowKeysBelongToLog(state({ text: "" })), true);
    assert.equal(arrowKeysBelongToLog(state({ text: "   \n " })), true);
  });

  test("输入框有内容 → 归输入框（Ctrl+P 调出的历史文本同样如此，↑/↓ 继续当历史浏览）", () => {
    assert.equal(arrowKeysBelongToLog(state({ text: "打开 x" })), false);
    assert.equal(arrowKeysBelongToLog(state({ text: "上一次提交的用例" })), false);
  });

  test("浮层/联想列表在等方向键时一律让路（否则选不中条目）", () => {
    assert.equal(
      arrowKeysBelongToLog(state({ overlayOpen: true })),
      false,
    );
    assert.equal(
      arrowKeysBelongToLog(state({ autocompleteShowing: true })),
      false,
    );
  });
});

/**
 * `/new` 开新会话时会把上一批场景归档（见 src/tui/batches.ts）。钉死的是「归档不丢数据」：
 * 退出时的汇总报告与回放脚本都以整个进程跑过的场景为准，静默少几条会让脚本看起来完整、实际缺场景。
 */
describe("会话批次：/new 归档不丢数据", () => {
  const label = (origin) => (origin.kind === "added" ? "追加" : origin.path);
  const queued = (
    id,
    name,
    state,
    origin = { kind: "file", path: "case.md" },
  ) => ({
    id,
    name,
    body: "打开 https://example.com\n断言标题包含 Example",
    origin,
    state,
    abort: new AbortController(),
    ...(state === "cancelled" ? { cancelNote: "已从运行队列中取消" } : {}),
  });
  const ran = (status, recordings = []) => ({
    report: { status, assertions: [], transcript: "" },
    text: "",
    json: "",
    transcript: "",
    usage: addUsage(emptyUsage(), { input: 10, output: 2, totalTokens: 12 }),
    recordings,
  });
  const rec = (name) => ({ name, caseSteps: [], steps: [] });

  test("快照带上场景名、来源与录制，录制带 sourcePath（回放脚本按来源拆分）", () => {
    const batch = snapshotBatch(
      [queued(1, "A", "pass")],
      new Map([[1, ran("pass", [rec("A")])]]),
      label,
    );
    assert.deepEqual(batch.names, [{ name: "A", origin: "case.md" }]);
    assert.equal(batch.members[0].report.status, "pass");
    assert.equal(batch.members[0].origin, "case.md");
    assert.deepEqual(
      batch.recordings.map((r) => [r.name, r.sourcePath]),
      [["A", "case.md"]],
    );
  });

  test("没有结果的场景如实写成「未运行」，不伪装成通过", () => {
    const batch = snapshotBatch(
      [queued(1, "A", "cancelled")],
      new Map(),
      label,
    );
    assert.equal(batch.members[0].report.status, "cancelled");
    assert.deepEqual(batch.members[0].report.assertions, []);
    assert.equal(batch.members[0].usage.calls, 0);
    assert.equal(batch.recordings.length, 0);
  });

  test("已取消的场景不进录制（半截轨迹写进脚本会让回放跑半个用例还可能报 PASS）", () => {
    const batch = snapshotBatch(
      [queued(1, "A", "cancelled"), queued(2, "B", "pass")],
      new Map([
        [1, ran("cancelled", [rec("A")])],
        [2, ran("pass", [rec("B")])],
      ]),
      label,
    );
    assert.deepEqual(
      batch.recordings.map((r) => r.name),
      ["B"],
    );
  });

  test("合并归档批次与当前批次：两批都在且顺序稳定（新队列的场景编号会从头开始）", () => {
    const archived = snapshotBatch(
      [queued(1, "A", "pass")],
      new Map([[1, ran("pass")]]),
      label,
    );
    // `/new` 之后队列是新的，编号又从 1 开始——正是「按 id 存结果」会串数据的地方。
    const current = snapshotBatch(
      [queued(1, "B", "fail")],
      new Map([[1, ran("fail")]]),
      label,
    );
    const total = combineBatches([archived, current]);
    assert.deepEqual(
      total.members.map((m) => `${m.name}:${m.report.status}`),
      ["A:pass", "B:fail"],
    );
    assert.deepEqual(
      total.names.map((n) => n.name),
      ["A", "B"],
    );
    assert.equal(total.members.length, total.names.length);
  });
});

describe("运行队列", () => {
  test("场景串行执行，一个结束自动开始下一个", async () => {
    const order = [];
    let concurrent = 0;
    let maxConcurrent = 0;
    const q = new ScenarioQueue(async (item) => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      order.push(`start:${item.name}`);
      await sleep(10);
      order.push(`end:${item.name}`);
      concurrent -= 1;
      return "pass";
    }, () => {});

    q.add("A", "a", FILE_ORIGIN);
    q.add("B", "b", FILE_ORIGIN);
    q.pump();
    await waitIdle(q);

    assert.equal(maxConcurrent, 1, "同一时刻只能有一个场景在跑");
    assert.deepEqual(order, ["start:A", "end:A", "start:B", "end:B"]);
  });

  test("并发上限 2：同时最多两个在跑，且一个场景都不丢", async () => {
    let inFlight = 0;
    let peak = 0;
    const started = [];
    const finished = [];
    const q = new ScenarioQueue(
      async (item) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        started.push(item.name);
        await sleep(25);
        inFlight -= 1;
        finished.push(item.name);
        return "pass";
      },
      () => {},
      () => 2,
    );

    for (const n of ["A", "B", "C", "D"]) q.add(n, n, FILE_ORIGIN);
    q.pump();
    await waitIdle(q);

    assert.equal(peak, 2, "并发度应恰好被限制在 2");
    assert.deepEqual([...started].sort(), ["A", "B", "C", "D"]);
    assert.deepEqual([...finished].sort(), ["A", "B", "C", "D"]);
    assert.equal(q.waiting().length, 0, "不该有漏派的场景");
  });

  test("并发量在跑的过程中调大：立刻补派发（不必等这一批结束）", async () => {
    let limit = 1;
    let inFlight = 0;
    let peak = 0;
    const q = new ScenarioQueue(
      async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await sleep(40);
        inFlight -= 1;
        return "pass";
      },
      () => {},
      () => limit,
    );

    // 5 个场景：起手串行只跑 A；调大之后，A 一结束就该一次补上 3 个（B/C/D），
    // 因此峰值是 3 而不是 1（等价于 /setting 里把并发量从 1 改成 3）。
    for (const n of ["A", "B", "C", "D", "E"]) q.add(n, n, FILE_ORIGIN);
    q.pump();
    await sleep(5);
    assert.equal(inFlight, 1, "起手是串行");
    limit = 3;
    await waitIdle(q);
    assert.equal(peak, 3, "改大之后下一轮就补上了");
  });

  test("并发量调小不掐掉已经在跑的：等它们结束，之后按新的来", async () => {
    let limit = 3;
    let inFlight = 0;
    let peak = 0;
    const q = new ScenarioQueue(
      async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await sleep(30);
        inFlight -= 1;
        return "pass";
      },
      () => {},
      () => limit,
    );

    for (const n of ["A", "B", "C", "D"]) q.add(n, n, FILE_ORIGIN);
    q.pump();
    await sleep(5);
    assert.equal(inFlight, 3);
    limit = 1;
    await waitIdle(q);
    assert.equal(peak, 3, "调小不该中止正在进行的那几个");
    assert.equal(inFlight, 0);
  });

  test("Esc：一次中止全部在跑的（并发时「当前场景」不再唯一）", async () => {
    const q = new ScenarioQueue(
      async (item) => {
        if (!item.abort.signal.aborted) await sleep(60);
        return item.abort.signal.aborted ? "cancelled" : "pass";
      },
      () => {},
      () => 2,
    );

    q.add("A", "a", FILE_ORIGIN);
    q.add("B", "b", FILE_ORIGIN);
    q.pump();
    await sleep(5);
    assert.equal(q.runningAll().length, 2);

    const aborted = q.abortRunning();
    assert.deepEqual(
      aborted.map((i) => i.name),
      ["A", "B"],
      "一次 Esc 要把在跑的全部点上名",
    );
    await waitIdle(q);
    assert.deepEqual(
      q.all().map((i) => i.state),
      ["cancelled", "cancelled"],
    );
  });

  test("并发上限的兜底：坏值退回 1，超界夹到 8", async () => {
    const peakFor = async (limit) => {
      let inFlight = 0;
      let peak = 0;
      const q = new ScenarioQueue(
        async () => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await sleep(5);
          inFlight -= 1;
          return "pass";
        },
        () => {},
        limit,
      );
      for (let i = 0; i < 9; i++) q.add(`S${i}`, "b", FILE_ORIGIN);
      q.pump();
      await waitIdle(q);
      return peak;
    };
    assert.equal(await peakFor(() => Number.NaN), 1, "坏值退回串行，而不是不跑");
    assert.equal(await peakFor(() => 999), 8, "上限就是 8");
  });

  test("跑到一半追加的场景会在当前场景结束后自动接上（无需再下指令）", async () => {
    const order = [];
    const q = new ScenarioQueue(async (item) => {
      order.push(item.name);
      await sleep(10);
      return "pass";
    }, () => {});

    q.add("A", "a", FILE_ORIGIN);
    q.pump();
    await sleep(2);
    q.add("B", "b", { kind: "added", path: "case.md" }); // 追加：此时 A 还在跑
    q.pump();
    await waitIdle(q);

    assert.deepEqual(order, ["A", "B"]);
  });

  test("取消尚未开始的待办：不执行，但如实记为「已取消」（不是悄悄消失）", async () => {
    const ran = [];
    const q = new ScenarioQueue(async (item) => {
      ran.push(item.name);
      await sleep(20);
      return "pass";
    }, () => {});

    q.add("A", "a", false);
    const b = q.add("B", "b", false);
    q.pump();
    await sleep(2);

    assert.equal(q.cancel(b.id)?.state, "cancelled");
    assert.equal(q.cancel(b.id), undefined, "已取消的不能被重复取消");
    await waitIdle(q);

    assert.deepEqual(ran, ["A"]);
    assert.equal(b.state, "cancelled");
  });

  test("Ctrl+C 语义：中止运行中的 + 取消全部待办", async () => {
    const settled = [];
    const q = new ScenarioQueue(async (item) => {
      // 模拟 runAgent：被中止时返回「已取消」
      if (!item.abort.signal.aborted) await sleep(30);
      const state = item.abort.signal.aborted ? "cancelled" : "pass";
      settled.push([item.name, state]);
      return state;
    }, () => {});

    q.add("A", "a", FILE_ORIGIN);
    q.add("B", "b", FILE_ORIGIN);
    q.add("C", "c", FILE_ORIGIN);
    q.pump();
    await sleep(5);

    q.abortRunning();
    assert.equal(q.cancelAllWaiting(), 2);
    await waitIdle(q);

    assert.deepEqual(settled, [["A", "cancelled"]]);
    assert.deepEqual(
      q.all().map((i) => i.state),
      ["cancelled", "cancelled", "cancelled"],
    );
  });

  test("执行器里停掉整条队列：当前记为失败、剩余记为「已取消」，且不再开下一条", async () => {
    // 对应「模型不可达」：这条路必须能真的停下来——继续跑只会把一次配置错误
    // 摊成一堆「用例失败」，每个还要白开一次浏览器。
    const ran = [];
    const q = new ScenarioQueue(async (item) => {
      ran.push(item.name);
      q.cancelAllWaiting("模型不可达，已停止执行");
      return "fail";
    }, () => {});

    q.add("A", "a", FILE_ORIGIN);
    q.add("B", "b", FILE_ORIGIN);
    q.add("C", "c", FILE_ORIGIN);
    q.pump();
    await waitIdle(q);

    assert.deepEqual(ran, ["A"]);
    assert.deepEqual(
      q.all().map((i) => i.state),
      ["fail", "cancelled", "cancelled"],
    );
    assert.equal(q.all()[1].cancelNote, "模型不可达，已停止执行");
  });

  test("执行抛错不会让队列停摆：记为失败后继续下一个", async () => {
    const order = [];
    const q = new ScenarioQueue(async (item) => {
      order.push(item.name);
      if (item.name === "A") throw new Error("端点不可用");
      return "pass";
    }, () => {});

    q.add("A", "a", FILE_ORIGIN);
    q.add("B", "b", FILE_ORIGIN);
    q.pump();
    await waitIdle(q);

    assert.deepEqual(order, ["A", "B"]);
    assert.deepEqual(
      q.all().map((i) => i.state),
      ["fail", "pass"],
    );
  });
});

describe("「已取消」是第三种终态", () => {
  test("中止的场景不做完整性校验，也不追加 FAIL 断言", () => {
    const input = "打开 https://example.com\n断言标题包含 Example\n断言页面包含 Nope";
    const report = buildReport(
      input,
      "[tool] navigate\n第 1 步完成：已打开页面\n步骤完成：1/3",
      [],
      { cancelled: true },
    );
    assert.equal(report.status, "cancelled");
    assert.equal(report.assertions.length, 0, "中止不该伪造断言结论");
    assert.match(report.cancelReason, /用户中止/);
    assert.match(report.cancelReason, /1\/3/);
  });

  test("不传 cancelled 时行为与历史一致（跑一半就停仍判失败）", () => {
    const report = buildReport("断言标题包含 Example", "步骤完成：0/1", []);
    assert.equal(report.status, "fail");
  });

  test("套件汇总：已取消不计入失败，也不混进通过", () => {
    const summary = summarizeSuite([
      {
        name: "A",
        report: { status: "pass", assertions: [], transcript: "" },
        usage: emptyUsage(),
      },
      {
        name: "B",
        report: {
          status: "cancelled",
          cancelReason: "用户中止了该场景，剩余步骤未执行",
          assertions: [],
          transcript: "",
        },
        usage: emptyUsage(),
      },
    ]);
    assert.equal(summary.status, "pass");
    assert.match(summary.summary, /通过 1 个/);
    assert.match(summary.summary, /已取消 1 个/);
    assert.deepEqual(
      summary.scenarios.map((s) => s.status),
      ["pass", "cancelled"],
    );
  });

  test("全部被取消时整体是「已取消」，不伪装成通过", () => {
    const summary = summarizeSuite([
      {
        name: "A",
        report: { status: "cancelled", assertions: [], transcript: "" },
        usage: emptyUsage(),
      },
    ]);
    assert.equal(summary.status, "cancelled");
    assert.equal(statusTag(summary.status), "已取消");
  });

  test("任一失败仍整体失败（已取消不掩盖失败）", () => {
    const summary = summarizeSuite([
      {
        name: "A",
        report: { status: "cancelled", assertions: [], transcript: "" },
        usage: emptyUsage(),
      },
      {
        name: "B",
        report: { status: "fail", assertions: [], transcript: "" },
        usage: emptyUsage(),
      },
    ]);
    assert.equal(summary.status, "fail");
  });

  test("没有取消时汇总文案与历史逐字一致", () => {
    const summary = summarizeSuite([
      {
        name: "A",
        report: { status: "pass", assertions: [], transcript: "" },
        usage: emptyUsage(),
      },
      {
        name: "B",
        report: { status: "pass", assertions: [], transcript: "" },
        usage: emptyUsage(),
      },
    ]);
    assert.equal(summary.summary, "共 2 个场景，通过 2 个");
  });
});

describe("日志落点可注入", () => {
  test("setSink 后日志改道（带时间戳），传 null 恢复默认", () => {
    const captured = [];
    setSink((line) => captured.push(line));
    try {
      info("hello");
      assert.equal(captured.length, 1);
      assert.match(captured[0], /^\d{2}:\d{2}:\d{2} hello$/);
    } finally {
      setSink(null);
    }
  });

  test("debugLog 只在 --debug 时输出", () => {
    const captured = [];
    setSink((line) => captured.push(line));
    try {
      setDebug(false);
      debugLog("细节");
      setDebug(true);
      debugLog("细节");
      assert.equal(captured.length, 1);
      assert.match(captured[0], /\[debug\] 细节/);
    } finally {
      setDebug(false);
      setSink(null);
    }
  });
});

describe("运行时加载用例文件：/run 的候选解析", () => {
  const dir = mkdtempSync(join(tmpdir(), "pageqa-case-"));
  const write = (rel, text) => {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
  };
  write("examples/smoke.md", "## A\n\n打开 x\n");
  write("examples/smoke-mobile.md", "## B\n\n打开 y\n");
  write("examples/order-bom.md", "## C\n\n打开 z\n");
  write("docs/adr/0001-x.md", "## D\n\n打开 d\n");
  write("notes.txt", "## E\n\n打开 e\n");
  write("node_modules/pkg/hidden.md", "## F\n\n打开 f\n");
  write(".private/secret.md", "## G\n\n打开 g\n");

  test("精确路径存在就直接命中，不再自作聪明", () => {
    assert.deepEqual(resolveCaseFile("examples/smoke.md", dir), {
      kind: "one",
      path: join(dir, "examples/smoke.md"),
    });
    // `./` 前缀与反斜杠写法都要认（Windows 上从资源管理器粘过来就是反斜杠）
    assert.equal(resolveCaseFile("./examples/smoke.md", dir).kind, "one");
    assert.equal(resolveCaseFile("examples\\smoke.md", dir).kind, "one");
  });

  test("目录 → 取该目录下的全部用例文件", () => {
    const hit = resolveCaseFile("examples", dir);
    assert.equal(hit.kind, "many");
    assert.deepEqual(
      hit.candidates.map((p) => displayPath(p, dir)).sort(),
      [
        "examples/order-bom.md",
        "examples/smoke-mobile.md",
        "examples/smoke.md",
      ],
    );
  });

  test("关键字唯一命中就直接加载（不必敲全路径）", () => {
    const hit = resolveCaseFile("bom", dir);
    assert.equal(hit.kind, "one");
    assert.equal(displayPath(hit.path, dir), "examples/order-bom.md");
  });

  test("关键字命中多个 → 交给上层挑选，浅层优先且顺序稳定", () => {
    const hit = resolveCaseFile("smoke", dir);
    assert.equal(hit.kind, "many");
    assert.deepEqual(
      hit.candidates.map((p) => displayPath(p, dir)),
      ["examples/smoke-mobile.md", "examples/smoke.md"],
    );
  });

  test(".txt 也算用例文件（与 CLI 的判据一致）", () => {
    const hit = resolveCaseFile("notes", dir);
    assert.equal(hit.kind, "one");
    assert.equal(displayPath(hit.path, dir), "notes.txt");
  });

  test("跳过 node_modules 与点目录，但普通子目录要能找到", () => {
    assert.equal(resolveCaseFile("hidden", dir).kind, "none");
    assert.equal(resolveCaseFile("secret", dir).kind, "none");
    const hit = resolveCaseFile("0001", dir);
    assert.equal(hit.kind, "one");
    assert.equal(displayPath(hit.path, dir), "docs/adr/0001-x.md");
  });

  test("找不到就如实说找不到（不猜）", () => {
    assert.deepEqual(resolveCaseFile("nope-nothing", dir), { kind: "none" });
    assert.deepEqual(resolveCaseFile("   ", dir), { kind: "none" });
  });
});

describe("让模型从候选里挑用例文件", () => {
  const dir = mkdtempSync(join(tmpdir(), "pageqa-pick-"));
  const candidates = [
    join(dir, "examples/smoke.md"),
    join(dir, "examples/order-bom.md"),
  ];

  test("提示里只给文件名，不给文件内容", () => {
    const prompt = buildPickPrompt("跑一下 bom 那个长流程", candidates, dir);
    assert.match(prompt, /1\. examples\/smoke\.md/);
    assert.match(prompt, /2\. examples\/order-bom\.md/);
    assert.match(prompt, /只回答/);
  });

  test("只认候选范围内的序号：0、越界、含糊回答一律当作挑不出来", () => {
    assert.equal(parsePick("2", candidates), candidates[1]);
    assert.equal(parsePick("我选第 2 个", candidates), candidates[1]);
    assert.equal(parsePick("0", candidates), undefined);
    assert.equal(parsePick("3", candidates), undefined);
    assert.equal(parsePick("不知道", candidates), undefined);
  });
});

describe("加载用例文件（/run）", () => {
  const dir = mkdtempSync(join(tmpdir(), "pageqa-load-"));

  test("与启动时同一个 splitScenarios：切分与命名完全一致", () => {
    const p = join(dir, "case.md");
    const text = "## A\n\n打开 a\n\n## B\n\n打开 b\n";
    writeFileSync(p, text);
    assert.deepEqual(loadCaseScenarios(p), splitScenarios(text));
    assert.deepEqual(
      loadCaseScenarios(p).map((s) => s.name),
      ["A", "B"],
    );
  });
});

describe("回放脚本按来源拆分", () => {
  const rec = (name, sourcePath) =>
    sourcePath === undefined
      ? { name, caseSteps: [], steps: [] }
      : { name, caseSteps: [], steps: [], sourcePath };

  test("同来源进同一组，无来源的场景单独成组（键为 null）", () => {
    const groups = groupRecordingsBySource([
      rec("A", "examples/smoke.md"),
      rec("B", "examples/order.md"),
      rec("C", "examples/smoke.md"),
      rec("D"),
    ]);
    assert.equal(groups.size, 3);
    assert.deepEqual(
      groups.get("examples/smoke.md").map((r) => r.name),
      ["A", "C"],
    );
    assert.deepEqual(
      groups.get("examples/order.md").map((r) => r.name),
      ["B"],
    );
    assert.deepEqual(
      groups.get(null).map((r) => r.name),
      ["D"],
    );
  });

  test("只有一个来源时与历史行为同构（仍然只出一份脚本）", () => {
    const groups = groupRecordingsBySource([rec("A", "x.md"), rec("B", "x.md")]);
    assert.equal(groups.size, 1);
    assert.equal(groups.get("x.md").length, 2);
  });
});

describe("报告标注场景来源", () => {
  const member = (name, origin) => ({
    name,
    origin,
    report: { status: "pass", assertions: [], transcript: "" },
    usage: emptyUsage(),
  });

  test("文本报告与 JSON 都点出场景来自哪个文件", () => {
    const members = [member("A", "examples/smoke.md"), member("B", "追加")];
    const summary = summarizeSuite(members);
    assert.deepEqual(
      summary.scenarios.map((s) => s.origin),
      ["examples/smoke.md", "追加"],
    );
    const text = renderSuiteText(summary, members, summary.scenarios);
    assert.match(
      text,
      /--- 场景 1\/2：A（来源: examples\/smoke\.md） \[PASS\] ---/,
    );
    assert.match(text, /--- 场景 2\/2：B（来源: 追加） \[PASS\] ---/);
  });

  test("没有来源时报告与历史逐字一致（批处理不受影响）", () => {
    const members = [member("A", undefined)];
    const summary = summarizeSuite(members);
    assert.equal(summary.scenarios[0].origin, undefined);
    const text = renderSuiteText(summary, members, [{ name: "A" }]);
    assert.match(text, /--- 场景 1\/1：A \[PASS\] ---/);
    assert.doesNotMatch(text, /来源/);
  });
});

/**
 * 选择器里选中超长名称时向左循环滚（见 src/tui/marquee.ts）。
 *
 * `/model` 给名字留的那一列只有 30 列宽，而模型 id（`anthropic/claude-3-5-sonnet-20241022`）
 * 常常更长：光标停在某一条上时看不到全名，正是这个功能要解决的问题。
 *
 * 滚动必须**循环**：滚到名字末尾再跳回开头，在屏幕上就是整行瞬间平移几十列——那一下闪动
 * 比看不到全名更烦人。因此这里的断言大多围着「每一帧只错开一列」转。
 * 用真的 pi-tui `sliceByColumn` / `visibleWidth` 当替身，好让「宽度不超过列宽」这条
 * 不变量按真实实现校验。
 */
describe("选中项超长时向左循环滚（跑马灯）", () => {
  const LONG = "anthropic/claude-3-5-sonnet-20241022";
  const win = (text, width, offset) =>
    marqueeWindow(text, width, offset, visibleWidth, sliceByColumn);
  const cycleOf = (text) => text + " ".repeat(MARQUEE_GAP_COLUMNS);

  test("放得下就原样返回：不滚（一轮列数为 0）", () => {
    assert.equal(win("gpt-4o", 30, 0), "gpt-4o");
    assert.equal(marqueePeriod(6, 30), 0);
  });

  test("offset 为 0 时与普通截断逐字同形（未选中项不因这次改动变样）", () => {
    assert.equal(win(LONG, 20, 0), sliceByColumn(LONG, 0, 20, true));
  });

  test("循环无缝：任意偏移都是「名字 + 空隙」长串上的滑窗，相邻帧只错开一列", () => {
    const width = 20;
    const period = marqueePeriod(visibleWidth(LONG), width);
    assert.equal(period, visibleWidth(LONG) + MARQUEE_GAP_COLUMNS);
    const rep = cycleOf(LONG) + cycleOf(LONG);
    for (let offset = 0; offset < period; offset++) {
      assert.equal(
        win(LONG, width, offset),
        sliceByColumn(rep, offset, width, true),
        `offset=${offset} 不是滑窗`,
      );
      assert.ok(visibleWidth(win(LONG, width, offset)) <= width);
    }
    // 滚过一轮的边界与滚到中间没有区别：不会「跳回开头」——那一下就是闪动
    assert.equal(win(LONG, width, period), win(LONG, width, 0));
    assert.equal(
      win(LONG, width, period - 1).slice(1),
      sliceByColumn(rep, period, width - 1, true),
      "跨过一轮边界时只该错开一列",
    );
  });

  test("滚一整圈，名字的结尾总会露出来（不会永远留在窗外）", () => {
    const width = 20;
    const period = marqueePeriod(visibleWidth(LONG), width);
    const frames = Array.from({ length: period }, (_, offset) =>
      win(LONG, width, offset),
    );
    assert.ok(frames.some((f) => f.includes(LONG.slice(-10))));
    assert.ok(frames.some((f) => f.includes(" ".repeat(MARQUEE_GAP_COLUMNS))));
  });

  test("宽字符（CJK）不会被切半格，也不顶破列宽", () => {
    const text = "模型名称".repeat(6);
    const width = 11;
    const period = marqueePeriod(visibleWidth(text), width);
    for (let offset = 0; offset < period; offset++) {
      assert.ok(
        visibleWidth(win(text, width, offset)) <= width,
        `offset=${offset} 顶破了列宽`,
      );
    }
  });

  test("推进器：起点先停几帧，之后一圈一圈地绕，换一条重新开始", () => {
    const m = new MarqueeScroller(() => {});
    try {
      m.setSelection("a", 3);
      // 选中项刚出现时不立刻滚走：否则用户看到的第一眼是名字中段
      for (let i = 0; i < MARQUEE_HOLD_FRAMES; i++) m.advance();
      assert.equal(m.offset, 0);
      m.advance();
      assert.equal(m.offset, 1);
      m.advance();
      assert.equal(m.offset, 2);
      m.advance();
      assert.equal(m.offset, 0, "一轮走完接下一轮：不停顿、也不回头");
      // 换一条（哪怕还是超长）也从起点重新开始
      m.advance();
      m.setSelection("b", 3);
      assert.equal(m.offset, 0);
    } finally {
      m.dispose();
    }
  });

  test("不需要滚就不开表：一轮列数为 0 时不推进、也不请求重绘", () => {
    let frames = 0;
    const m = new MarqueeScroller(() => frames++);
    try {
      m.setSelection("short", 0);
      for (let i = 0; i < 10; i++) m.advance();
      assert.equal(m.offset, 0);
      assert.equal(frames, 0);
    } finally {
      m.dispose();
    }
  });

  test("定时器只在需要滚的时候请求重绘，dispose 之后彻底停掉", () => {
    mock.timers.enable({ apis: ["setInterval"] });
    try {
      let frames = 0;
      const m = new MarqueeScroller(() => frames++);
      m.setSelection("long", 5);
      mock.timers.tick(MARQUEE_FRAME_MS * (MARQUEE_HOLD_FRAMES + 1));
      assert.ok(frames >= 1, "停顿结束后应该请求重绘");
      m.dispose();
      const settled = frames;
      mock.timers.tick(MARQUEE_FRAME_MS * 20);
      assert.equal(frames, settled, "dispose 之后不该再有帧（否则进程退不出去）");
    } finally {
      mock.timers.reset();
    }
  });
});
