import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "../dist/index.js";
import {
  renderScenarios,
  selectScenario,
  splitScenarios,
} from "../dist/agent.js";
import {
  buildChildArgs,
  ConcurrencySessionConflictError,
  formatUsageLine,
  isConcurrencySessionConflict,
  mapWithConcurrency,
  MAX_CONCURRENCY,
  mergeScripts,
  parseUsageLine,
  resolveCliEntry,
  runScenarioChild,
  runSuiteInChildren,
  USAGE_LINE_PREFIX,
} from "../dist/suite.js";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { emptyUsage, summarizeSuite } from "../dist/report.js";
import { readConcurrency, readScenarioTimeoutMs } from "../dist/config.js";

// 纯单元测试：场景选择、子进程命令行契约、异常归因与场景级上限的解析。
// 都不需要 bsk / LLM —— fork 编排本身要真浏览器，放在冒烟测试里。

const CASE = [
  "# 套件",
  "",
  "## A1 打开页面",
  "打开 https://example.com 并断言标题包含 Example",
  "",
  "## A2 表单填写",
  "打开 https://example.com",
  "断言页面包含 IANA",
].join("\n");

describe("并发与共享 session 的语义冲突", () => {
  test("判定矩阵：只有「多场景 + 并发>1 + 显式 session」才算冲突", () => {
    assert.equal(isConcurrencySessionConflict(2, 2, "s1"), true);
    // 一个场景：并发无从谈起，共享 session 照跑
    assert.equal(isConcurrencySessionConflict(2, 1, "s1"), false);
    // 并发 1：本来就是一个一个跑，共享 session 正是它的用法
    assert.equal(isConcurrencySessionConflict(1, 2, "s1"), false);
    // 没给 session：每个场景自己建 session，这才是并发的前提
    assert.equal(isConcurrencySessionConflict(2, 2, undefined), false);
    assert.equal(isConcurrencySessionConflict(2, 2, ""), false);
  });

  test("命中时在**起浏览器之前**就拒绝：带类型的错 + 可执行的改法", async () => {
    await assert.rejects(
      () =>
        runSuiteInChildren({
          script: CASE,
          input: "case.md",
          sourcePath: null,
          session: "shared-session",
          timeoutMs: 1_000,
          wantScript: false,
          concurrency: 2,
        }),
      (err) => {
        assert.ok(err instanceof ConcurrencySessionConflictError);
        assert.equal(err.concurrency, 2);
        assert.match(err.message, /--session/);
        assert.match(err.message, /并发设为 1/);
        return true;
      },
    );
  });
});

describe("--only 的场景选择", () => {
  test("纯数字按序号（1 起）", () => {
    const scenarios = splitScenarios(CASE);
    assert.equal(scenarios.length, 2);
    assert.equal(selectScenario(scenarios, "2").scenario.name, "A2 表单填写");
    assert.equal(selectScenario(scenarios, "2").index, 2);
  });

  test("非数字按标题精确匹配，大小写不敏感", () => {
    const scenarios = splitScenarios(CASE);
    assert.equal(
      selectScenario(scenarios, "a2 表单填写").scenario.name,
      "A2 表单填写",
    );
    assert.equal(
      selectScenario(scenarios, "  A1 打开页面  ").index,
      1,
    );
  });

  test("不做模糊匹配：部分命中也要报错，并把候选都列出来", () => {
    const scenarios = splitScenarios(CASE);
    assert.throws(
      () => selectScenario(scenarios, "表单"),
      /找不到场景「表单」/,
    );
    assert.throws(
      () => selectScenario(scenarios, "表单"),
      /A1 打开页面/,
    );
  });

  test("序号越界报错，不兜底选最后一个", () => {
    const scenarios = splitScenarios(CASE);
    assert.throws(() => selectScenario(scenarios, "3"), /找不到场景「3」/);
    assert.throws(() => selectScenario(scenarios, "0"), /找不到场景「0」/);
  });

  test("挑出来的场景能拼回一份可再次切分的用例（名字与序号都不变）", () => {
    const scenarios = splitScenarios(CASE);
    const picked = selectScenario(scenarios, "A2 表单填写");
    const again = splitScenarios(renderScenarios([picked.scenario]));
    assert.equal(again.length, 1);
    assert.equal(again[0].name, "A2 表单填写");
    assert.match(again[0].body, /断言页面包含 IANA/);
  });
});

describe("子进程命令行契约（ADR-0013 决策二）", () => {
  test("恒定带上 --only / --json / --no-tui / --no-side-outputs，输入永远在最后", () => {
    const args = buildChildArgs({ scenarioIndex: 1, input: "case.md" });
    assert.deepEqual(args.slice(0, 5), [
      "--only",
      "2",
      "--json",
      "--no-tui",
      "--no-side-outputs",
    ]);
    // `--` 必须紧挨着输入，且 `--only` 的序号是「序号 + 1」
    assert.deepEqual(args.slice(-2), ["--", "case.md"]);
    assert.equal(args[args.length - 2], "--");
  });

  test("--usage-stream 按需带上：交互模式要实时用量，批处理不要", () => {
    const withStream = buildChildArgs({
      scenarioIndex: 0,
      input: "case.md",
      usageStream: true,
    });
    assert.equal(withStream.includes("--usage-stream"), true);
    // 必须排在 `--` 之前：`--` 之后的一切都是位置参数
    assert.ok(withStream.indexOf("--usage-stream") < withStream.indexOf("--"));

    const without = buildChildArgs({ scenarioIndex: 0, input: "case.md" });
    assert.equal(without.includes("--usage-stream"), false);
  });

  test("session 与临时脚本按需带上，不给就不出现", () => {
    const plain = buildChildArgs({ scenarioIndex: 0, input: "case.md" });
    assert.equal(plain.includes("--session"), false);
    assert.equal(plain.includes("--emit-script"), false);

    const full = buildChildArgs({
      scenarioIndex: 0,
      input: "case.md",
      session: "abc123",
      scriptPath: "C:\\tmp\\scenario-1.replay.json",
      debug: true,
      locale: "en",
    });
    assert.deepEqual(
      full.slice(full.indexOf("--session"), full.indexOf("--session") + 2),
      ["--session", "abc123"],
    );
    assert.deepEqual(
      full.slice(full.indexOf("--emit-script"), full.indexOf("--emit-script") + 2),
      ["--emit-script", "C:\\tmp\\scenario-1.replay.json"],
    );
    assert.equal(full.includes("--debug"), true);
    assert.deepEqual(
      full.slice(full.indexOf("--locale"), full.indexOf("--locale") + 2),
      ["--locale", "en"],
    );
  });
});

describe("带盘符的临时脚本路径不会被当成用例输入", () => {
  test("--emit-script C:\\... 被识别为输出路径", () => {
    const args = parseArgs([
      "--emit-script",
      "C:\\tmp\\pageqa-suite-1\\scenario-1.replay.json",
      "case.md",
    ]);
    assert.equal(args.error, undefined);
    assert.equal(
      args.emitScriptPath,
      "C:\\tmp\\pageqa-suite-1\\scenario-1.replay.json",
    );
    assert.equal(args.input, "case.md");
  });

  test("--emit-script 用例.md 仍然留给输入位（不被当路径吞掉）", () => {
    const args = parseArgs(["--emit-script", "examples/smoke.md"]);
    assert.equal(args.emitScriptPath, undefined);
    assert.equal(args.input, "examples/smoke.md");
    assert.equal(args.emitScript, true);
  });
});

describe("--only / --no-side-outputs 的参数解析", () => {
  test("--only 收序号与标题两种写法", () => {
    assert.equal(parseArgs(["--only", "2", "case.md"]).only, "2");
    assert.equal(
      parseArgs(["--only", "表单填写测试", "case.md"]).only,
      "表单填写测试",
    );
  });

  test("--only 缺参时报缺参，不吞下一个 flag", () => {
    const args = parseArgs(["--only", "--json", "case.md"]);
    assert.match(args.error ?? "", /--only 需要/);
  });

  test("--usage-stream 默认关，给了才是真", () => {
    assert.equal(parseArgs(["case.md"]).usageStream, false);
    assert.equal(parseArgs(["--usage-stream", "case.md"]).usageStream, true);
  });

  test("--no-side-outputs 默认关，给了才是真", () => {
    assert.equal(parseArgs(["case.md"]).noSideOutputs, false);
    assert.equal(parseArgs(["--no-side-outputs", "case.md"]).noSideOutputs, true);
  });

  test("--only 与 -- -- 之后的输入位互不干扰", () => {
    const args = parseArgs(["--only", "1", "--", "-以减号开头的用例"]);
    assert.equal(args.error, undefined);
    assert.equal(args.only, "1");
    assert.equal(args.input, "-以减号开头的用例");
  });
});

describe("子进程入口解析：绝不能是 process.argv[1]", () => {
  test("默认入口是与 suite.js 同目录的 index.js，而不是当前进程的 argv[1]", () => {
    const entry = resolveCliEntry();
    assert.equal(basename(entry), "index.js");
    assert.equal(
      existsSync(join(dirname(entry), "suite.js")),
      true,
      "应与 suite.js 同目录",
    );
    assert.equal(existsSync(entry), true, "入口必须真实存在");

    // 这条断言记录的是一次真实事故：测试进程的 argv[1] 是**测试文件**，
    // 早期实现拿它当子进程入口 → 子进程重跑一遍用例 → 每个子进程再各开一层
    // → 自我复制的死循环，浏览器窗口成串开出来（2026-09-28）。
    assert.match(process.argv[1] ?? "", /suite\.test\.mjs$/);
    assert.notEqual(entry, process.argv[1]);
  });
});

describe("子进程用量通道（ADR-0013 第二步）", () => {
  const usage = {
    input: 1200,
    output: 340,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    total: 1540,
    calls: 3,
  };

  test("一行一带，能原样往返", () => {
    const line = formatUsageLine(usage);
    assert.equal(line.startsWith(USAGE_LINE_PREFIX), true);
    assert.deepEqual(parseUsageLine(line), usage);
  });

  test("普通日志行不会被误判成用量行", () => {
    assert.equal(parseUsageLine("17:04:11 [pageqa] 场景 1/3"), null);
    assert.equal(parseUsageLine(""), null);
    assert.equal(parseUsageLine("[pageqa:usagex] {}"), null);
  });

  test("半截行/坏 JSON 不抛错，也不假装读到了数字", () => {
    assert.equal(parseUsageLine(USAGE_LINE_PREFIX + "{"), null);
    assert.equal(parseUsageLine(USAGE_LINE_PREFIX + '"abc"'), null);
    // 字段缺失按 0 补：宁可少算，也不要让状态栏显示 NaN
    const partial = parseUsageLine(USAGE_LINE_PREFIX + '{"total":10}');
    assert.equal(partial.total, 10);
    assert.equal(partial.calls, 0);
    assert.equal(partial.input, 0);
  });
});

/**
 * 父进程侧的子进程执行器：用一个**假子进程**（entry 指向临时脚本）把协议钉死。
 * 这一段完全不需要浏览器，因此能进单测；真正驱动浏览器的那段留给冒烟测试。
 */
describe("子进程执行器：父进程侧", () => {
  const usage = {
    input: 10,
    output: 20,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    total: 30,
    calls: 2,
  };
  const REPORT = {
    status: "pass",
    assertions: [{ expectation: "假断言", verdict: "pass" }],
    transcript: "假记录",
    scenarios: [
      { name: "假场景", status: "pass", steps: ["打开页面"], trace: [], assertions: [] },
    ],
  };

  /** 写一个假子进程：按约定打日志、打用量行、吐报告、写临时脚本。 */
  function makeFixture(dir, { report = REPORT, usageLine = formatUsageLine(usage) } = {}) {
    const path = join(dir, "fake-child.mjs");
    writeFileSync(
      path,
      [
        'import { writeFileSync } from "node:fs";',
        "const argv = process.argv.slice(2);",
        'const i = argv.indexOf("--emit-script");',
        "const scriptPath = i >= 0 ? argv[i + 1] : null;",
        'process.stderr.write("17:00:00 [pageqa] 假子进程启动\\n");',
        `process.stderr.write(${JSON.stringify(usageLine)} + "\\n");`,
        'process.stderr.write("17:00:01 [pageqa] 假子进程跑完\\n");',
        "if (scriptPath) writeFileSync(scriptPath, JSON.stringify({",
        '  format: "pageqa-replay", version: 1, recordedAt: "2026-09-28T00:00:00.000Z",',
        '  source: { path: null, hash: null },',
        '  scenarios: [{ name: "假场景", caseSteps: ["打开页面"],',
        '    steps: [{ kind: "navigate", step: 1, url: "https://example.com" }] }],',
        "}));",
        report === null
          ? 'process.stdout.write("这不是 JSON\\n");'
          : `process.stdout.write(${JSON.stringify(JSON.stringify(report))} + "\\n");`,
        "",
      ].join("\n"),
      "utf8",
    );
    return path;
  }

  /** 一次调用的参数（入口与额外项由各用例决定）。 */
  const opts = (entry, extra = {}) => ({
    entry,
    scenarioIndex: 0,
    total: 1,
    input: "## 假场景\n打开页面",
    timeoutMs: 0,
    emitLog: () => {},
    ...extra,
  });

  test("用量行被吞掉、其余日志原样转发、报告与临时脚本都取回", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pageqa-fakechild-"));
    try {
      const entry = makeFixture(dir);
      const logs = [];
      const usages = [];
      const scriptPath = join(dir, "out.replay.json");

      const result = await runScenarioChild(
        opts(entry, {
          scriptPath,
          usageStream: true,
          emitLog: (line) => logs.push(line),
          onUsage: (u) => usages.push(u),
        }),
      );

      // 用量：回调拿到解析后的对象，且它**没有**混进日志（状态栏自己会渲染）
      assert.deepEqual(usages, [usage]);
      assert.deepEqual(logs, [
        "17:00:00 [pageqa] 假子进程启动",
        "17:00:01 [pageqa] 假子进程跑完",
      ]);
      assert.equal(
        logs.some((l) => l.includes("pageqa:usage")),
        false,
      );
      // 报告与临时脚本
      assert.equal(result.report.status, "pass");
      assert.equal(result.script.scenarios.length, 1);
      assert.equal(result.script.scenarios[0].name, "假场景");
      assert.equal(result.how, "exit code 0");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("子进程没吐报告时如实说「没有」，并把退出方式带回来", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pageqa-fakechild-"));
    try {
      const entry = makeFixture(dir, { report: null });
      const result = await runScenarioChild(opts(entry));
      assert.equal(result.report, undefined);
      assert.equal(result.stopped, undefined);
      assert.match(result.how, /exit code 0/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("超过上限：终止子进程并标记为 timeout（而不是等它自己结束）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pageqa-fakechild-"));
    try {
      const entry = join(dir, "hang.mjs");
      writeFileSync(entry, "setTimeout(() => {}, 60_000);\n", "utf8");
      const started = Date.now();
      const result = await runScenarioChild(opts(entry, { timeoutMs: 1200 }));
      assert.equal(result.stopped, "timeout");
      assert.ok(Date.now() - started < 20_000, "不该等到自然结束");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("用户按 Esc：终止子进程并标记为 abort（该场景随后记「已取消」）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pageqa-fakechild-"));
    try {
      const entry = join(dir, "hang.mjs");
      writeFileSync(entry, "setTimeout(() => {}, 60_000);\n", "utf8");
      const controller = new AbortController();
      const pending = runScenarioChild(opts(entry, { abortSignal: controller.signal }));
      setTimeout(() => controller.abort(), 300);
      const result = await pending;
      assert.equal(result.stopped, "abort");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("套件汇总保留异常归因", () => {
  test("成员报告带 reason 时逐场景明细带 reason", () => {
    const summary = summarizeSuite([
      {
        name: "崩了的场景",
        report: {
          status: "fail",
          reason: "crash",
          summary: "子进程异常结束",
          assertions: [],
          transcript: "",
        },
        usage: emptyUsage(),
      },
      {
        name: "断言没过的场景",
        report: {
          status: "fail",
          assertions: [
            { expectation: "标题包含 X", verdict: "fail", evidence: "实际是 Y" },
          ],
          transcript: "",
        },
        usage: emptyUsage(),
      },
    ]);
    assert.equal(summary.scenarios[0].reason, "crash");
    // 断言失败不带归因字段：它由 assertions 自己说明，多一个字段只会让 CI 多一次判断
    assert.equal("reason" in summary.scenarios[1], false);
    assert.equal(summary.status, "fail");
  });
});

describe("并发调度（ADR-0013 决策三）", () => {
  test("结果按下标归位：谁先跑完不影响顺序", async () => {
    const out = await mapWithConcurrency([3, 1, 2], 3, async (n) => {
      await new Promise((r) => setTimeout(r, n * 20));
      return n * 10;
    });
    assert.deepEqual(out, [30, 10, 20]);
  });

  test("同时最多只有 limit 个在跑，且不会漏跑", async () => {
    const items = [1, 2, 3, 4, 5, 6];
    let inFlight = 0;
    let peak = 0;
    const seen = [];
    const out = await mapWithConcurrency(items, 2, async (n) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      seen.push(n);
      await new Promise((r) => setTimeout(r, 10));
      inFlight -= 1;
      return n;
    });
    assert.equal(peak, 2, "并发度应恰好被限制在 2");
    assert.deepEqual([...seen].sort((a, b) => a - b), items, "每个任务都要跑到");
    assert.deepEqual(out, items);
  });

  test("limit 比任务数大时按任务数开；limit < 1 也至少跑得动", async () => {
    let peak = 0;
    let inFlight = 0;
    const track = async (n) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return n;
    };
    assert.deepEqual(await mapWithConcurrency([1, 2, 3], 8, track), [1, 2, 3]);
    assert.equal(peak, 3);
    peak = 0;
    assert.deepEqual(await mapWithConcurrency([1, 2, 3], 0, track), [1, 2, 3]);
    assert.equal(peak, 1, "limit 非法时退回一个一个跑，而不是一个都不跑");
  });

  test("空输入不发车也不报错", async () => {
    assert.deepEqual(await mapWithConcurrency([], 4, async () => 1), []);
  });

  test("shouldStop 之后不再派发：在跑的跑完，没派发的留空", async () => {
    const started = [];
    const out = await mapWithConcurrency(
      [1, 2, 3, 4, 5, 6],
      2,
      async (n) => {
        started.push(n);
        await new Promise((r) => setTimeout(r, 20));
        return n;
      },
      () => started.length >= 2,
    );
    assert.deepEqual(started, [1, 2], "第三个及以后都不该被派发");
    assert.deepEqual(out, [1, 2, undefined, undefined, undefined, undefined]);
  });

  test("上限常量就是 8（超过由 CLI 报错，不静默截断）", () => {
    assert.equal(MAX_CONCURRENCY, 8);
  });
});

// 合并脚本的顺序：并行时**谁先跑完谁先交脚本**，若按交卷顺序合并，
// `--replay` 就会把「创建 → 编辑 → 删除」演成乱序（实测 S2 排在 S1 之前）。
describe("子进程脚本合并顺序", () => {
  const childScript = (name) => ({
    format: "pageqa-replay",
    version: 1,
    recordedAt: "2026-09-29T00:00:00.000Z",
    source: { path: "case.md", hash: "abc" },
    scenarios: [
      {
        name,
        caseSteps: ["打开页面"],
        steps: [{ kind: "navigate", step: 1, url: "https://example.com" }],
      },
    ],
  });

  test("按场景序号排，不按交卷先后", () => {
    // Map 的插入顺序故意是「后一个场景先完成」
    const merged = mergeScripts(
      new Map([
        [1, childScript("S2 删除")],
        [0, childScript("S1 创建")],
      ]),
    );
    assert.deepEqual(
      merged.scenarios.map((s) => s.name),
      ["S1 创建", "S2 删除"],
    );
    assert.equal(merged.source.path, "case.md", "source 取序号最小那份");
  });

  test("中间场景缺失（子进程没交回脚本）时不塞空位", () => {
    const merged = mergeScripts(
      new Map([
        [2, childScript("S3")],
        [0, childScript("S1")],
      ]),
    );
    assert.deepEqual(merged.scenarios.map((s) => s.name), ["S1", "S3"]);
  });

  test("一条脚本都没交回 → null（与「不产出脚本」的历史行为一致）", () => {
    assert.equal(mergeScripts(new Map()), null);
  });
});

describe("并发上限的解析", () => {
  test("PAGEQA_CONCURRENCY 只认正整数，坏值一律回落 1（默认逐个跑）", () => {
    const previous = process.env.PAGEQA_CONCURRENCY;
    try {
      process.env.PAGEQA_CONCURRENCY = "3";
      assert.equal(readConcurrency(), 3);
      // 坏值不猜：猜错的代价是同时开出一堆浏览器窗口
      for (const bad of ["0", "-2", "abc", "2.5", ""]) {
        process.env.PAGEQA_CONCURRENCY = bad;
        assert.equal(readConcurrency(), 1, `坏值 ${JSON.stringify(bad)} 应回落 1`);
      }
    } finally {
      if (previous === undefined) delete process.env.PAGEQA_CONCURRENCY;
      else process.env.PAGEQA_CONCURRENCY = previous;
    }
  });

  test("--concurrency 收正整数，缺参/坏值当场报错", () => {
    assert.equal(parseArgs(["--concurrency", "4", "case.md"]).concurrency, 4);
    assert.equal(parseArgs(["--concurrency", "1", "case.md"]).concurrency, 1);
    assert.match(parseArgs(["--concurrency"]).error ?? "", /--concurrency 需要/);
    assert.match(
      parseArgs(["--concurrency", "--json", "case.md"]).error ?? "",
      /--concurrency 需要/,
    );
    for (const bad of ["0", "2.5", "两个"]) {
      assert.match(
        parseArgs(["--concurrency", bad, "case.md"]).error ?? "",
        /只收正整数/,
        `坏值 ${bad} 应报错而不是静默回落`,
      );
    }
    // `-1` 走的是「以 - 开头的值当成下一个选项」那条：报缺参而不是当数字解析
    // （与 --session / --locale 同一套判据）。
    assert.match(
      parseArgs(["--concurrency", "-1", "case.md"]).error ?? "",
      /--concurrency 需要/,
    );
  });
});

describe("场景级执行上限的解析（ADR-0013 决策八）", () => {
  test("环境变量优先，正数才生效", () => {
    const previous = process.env.PAGEQA_SCENARIO_TIMEOUT;
    try {
      process.env.PAGEQA_SCENARIO_TIMEOUT = "120000";
      assert.equal(readScenarioTimeoutMs(), 120000);
      process.env.PAGEQA_SCENARIO_TIMEOUT = "1500.7";
      assert.equal(readScenarioTimeoutMs(), 1501);
      // 坏值一律按「不限」：宁可不管，也不要因为一个坏值把长流程半路掐死
      process.env.PAGEQA_SCENARIO_TIMEOUT = "abc";
      assert.equal(readScenarioTimeoutMs(), 0);
      process.env.PAGEQA_SCENARIO_TIMEOUT = "0";
      assert.equal(readScenarioTimeoutMs(), 0);
      process.env.PAGEQA_SCENARIO_TIMEOUT = "-5";
      assert.equal(readScenarioTimeoutMs(), 0);
    } finally {
      if (previous === undefined) delete process.env.PAGEQA_SCENARIO_TIMEOUT;
      else process.env.PAGEQA_SCENARIO_TIMEOUT = previous;
    }
  });

  test("没配时给的是数字（默认不限），不会返回 NaN", () => {
    const previous = process.env.PAGEQA_SCENARIO_TIMEOUT;
    try {
      delete process.env.PAGEQA_SCENARIO_TIMEOUT;
      const value = readScenarioTimeoutMs();
      assert.equal(typeof value, "number");
      assert.equal(Number.isNaN(value), false);
      assert.ok(value >= 0);
    } finally {
      if (previous !== undefined) process.env.PAGEQA_SCENARIO_TIMEOUT = previous;
    }
  });
});
