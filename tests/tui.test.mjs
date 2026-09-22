import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { splitScenarios } from "../dist/agent.js";
import { debugLog, info, setDebug, setSink } from "../dist/log.js";
import {
  buildReport,
  emptyUsage,
  statusTag,
  summarizeSuite,
} from "../dist/report.js";
import { ScenarioQueue } from "../dist/tui/queue.js";
import {
  appendScenarioToCaseFile,
  scenarioNameFromBody,
  scenariosFromInput,
} from "../dist/tui/writeback.js";

// 纯单元测试：不依赖浏览器、LLM 与真实 TTY。

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

    q.add("A", "a", false);
    q.add("B", "b", false);
    q.pump();
    await waitIdle(q);

    assert.equal(maxConcurrent, 1, "同一时刻只能有一个场景在跑");
    assert.deepEqual(order, ["start:A", "end:A", "start:B", "end:B"]);
  });

  test("跑到一半追加的场景会在当前场景结束后自动接上（无需再下指令）", async () => {
    const order = [];
    const q = new ScenarioQueue(async (item) => {
      order.push(item.name);
      await sleep(10);
      return "pass";
    }, () => {});

    q.add("A", "a", false);
    q.pump();
    await sleep(2);
    q.add("B", "b", true); // 追加：此时 A 还在跑
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

    q.add("A", "a", false);
    q.add("B", "b", false);
    q.add("C", "c", false);
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

  test("执行抛错不会让队列停摆：记为失败后继续下一个", async () => {
    const order = [];
    const q = new ScenarioQueue(async (item) => {
      order.push(item.name);
      if (item.name === "A") throw new Error("端点不可用");
      return "pass";
    }, () => {});

    q.add("A", "a", false);
    q.add("B", "b", false);
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
