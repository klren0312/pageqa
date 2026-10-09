import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent } from "../dist/agent/agent.js";
import { runScenarioInChild } from "../dist/agent/suite.js";

/** 跑一次真的 CLI（子进程），把退出码与 stdout 都拿回来——它抛错时也拿。 */
function runCli(args) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["dist/index.js", ...args],
      { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        resolve({
          status: err ? (typeof err.code === "number" ? err.code : 1) : 0,
          stdout,
          stderr,
        });
      },
    );
  });
}

/**
 * 「尽量复用同一个 session」的起点提示，**首次真的需要时才开**。
 *
 * 模块加载就开会留下一个没人用的**空白浏览器窗口**——用 `--test-name-pattern`
 * 只跑部分用例时尤其明显（2026-09-28 现场就是这么误以为「在循环开窗口」的）。
 * 它只是起点提示：真正跑起来后 runAgent 会关掉它，下一个用例再自己开一个。
 */
let cachedSession = "";
function sid() {
  if (cachedSession) return cachedSession;
  try {
    const out = execFileSync("bsk", ["session", "start", "--json"], { encoding: "utf-8" });
    cachedSession = JSON.parse(out).session_id;
  } catch {
    cachedSession = process.env.PAGEQA_SESSION || "";
  }
  return cachedSession;
}

function txt(input) {
  return runAgent(input, { session: sid() }).then((r) => r.report);
}

// A1：打开真实页面并断言标题包含
describe("A1 打开页面并断言标题", () => {
  test("example.com 标题包含 Example", async () => {
    const report = await txt("打开 https://example.com 并断言标题包含 Example");
    assert.equal(report.status, "pass");
    assert.ok(report.assertions.some((a) => a.verdict === "pass"), "应有成立的断言");
  });
});

// A2：交互流程（点击链接 + 等待 + 断言出现）
describe("A2 元素交互与断言", () => {
  test("点击链接后断言新页面出现对应文本", async () => {
    const report = await txt(
      "打开 https://example.com 。点击页面上的「Learn more」链接，等待页面加载，然后断言页面包含 'IANA'。",
    );
    assert.equal(report.status, "pass");
  });
});

// A3：反向断言（断言页面**不包含**某文本）。它校验的正是「页面确实没有这段文字」，
// 因此页面里没有它就该通过；而页面里真有它时必须失败——否则「不包含」永远成立。
describe("A3 反向断言", () => {
  test("断言页面不包含不存在的文本 -> pass", async () => {
    const report = await txt("打开 https://example.com 并断言页面不包含 'THIS_TEXT_SHOULD_NOT_EXIST_XYZ'");
    assert.equal(report.status, "pass");
    assert.ok(
      report.assertions.some((a) => a.expectation.includes("不包含")),
      "报告里的断言应带上「不包含」的方向",
    );
  });

  test("断言页面不包含实际存在的文本 -> fail", async () => {
    const report = await txt("打开 https://example.com 并断言页面不包含 'Example Domain'");
    assert.equal(report.status, "fail");
  });
});

// A4：报告格式（文本与 JSON）
describe("A4 报告格式", () => {
  test("文本与 JSON 报告均可生成且结构稳定", async () => {
    const r = await runAgent("打开 https://example.com 并断言标题包含 Example", { session: sid() });
    assert.ok(r.text.includes("结论: PASS") || r.text.includes("结论: FAIL"));
    const json = JSON.parse(r.json);
    assert.ok(["pass", "fail"].includes(json.status));
    assert.ok(Array.isArray(json.assertions));
    assert.equal(typeof json.transcript, "string");
  });
});

// A5：套件把每个场景放进**独立子进程**（ADR-0013）——这是进程边界唯一的自动化护栏。
// 一个通过 + 一个失败：既验证「崩一个不牵连别人」的汇总口径与退出码，
// 也验证两份子进程录制被父进程合并成**一份**脚本（--no-side-outputs 下仍要出脚本）。
describe("A5 套件：每个场景一个子进程", () => {
  test("两场景各自 fork，父进程汇总并合并脚本", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pageqa-suite-e2e-"));
    const casePath = join(dir, "case.md");
    writeFileSync(
      casePath,
      [
        "## S1 标题断言（应通过）",
        "打开 https://example.com 并断言标题包含 Example",
        "",
        "## S2 断言不存在的文本（应失败）",
        "打开 https://example.com 并断言页面包含 'THIS_TEXT_SHOULD_NOT_EXIST_XYZ'",
      ].join("\n"),
      "utf8",
    );
    const scriptPath = join(dir, "merged.replay.json");

    const { status, stdout, stderr } = await runCli([
      "--json",
      "--no-side-outputs",
      "--emit-script",
      scriptPath,
      casePath,
    ]);

    // stdout 不是 JSON，几乎总是「压根没跑起来」（模型端点没通、bsk 没连浏览器）：
    // 把 stderr 一起抛出来，否则现场只会看到一句 SyntaxError，还得回去翻日志才知道原因。
    let report;
    try {
      report = JSON.parse(stdout);
    } catch {
      throw new Error(
        `子进程没有产出 JSON 报告（退出码 ${status}）。stderr：\n${stderr.trim() || "(空)"}`,
      );
    }
    assert.equal(report.scenarios.length, 2, "父进程应汇总两个场景");
    assert.equal(report.scenarios[0].name, "S1 标题断言（应通过）");
    assert.equal(report.scenarios[0].status, "pass");
    assert.equal(report.scenarios[1].name, "S2 断言不存在的文本（应失败）");
    assert.equal(report.scenarios[1].status, "fail");
    assert.equal(report.status, "fail", "任一场景失败则整体失败");
    assert.equal(status, 1, "整体失败时退出码为 1");

    const script = JSON.parse(readFileSync(scriptPath, "utf8"));
    assert.equal(script.format, "pageqa-replay");
    assert.equal(script.scenarios.length, 2, "两份子进程录制应合并成一份脚本");
    assert.equal(script.scenarios[0].name, "S1 标题断言（应通过）");
    assert.equal(script.scenarios[1].name, "S2 断言不存在的文本（应失败）");
  });
});

// A7：并行跑场景（`--concurrency`）。两件必须同时成立的事：
// ① 真的重叠了（墙钟时间小于各场景耗时之和）；② 结果顺序仍按用例原文排。
describe("A7 套件：并行跑场景", () => {
  test("并发 2 时两个场景重叠执行，且报告顺序仍按用例原文", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pageqa-parallel-e2e-"));
    const casePath = join(dir, "case.md");
    // 两条都选最轻、最稳的标题断言：墙钟与「各场景耗时之和」相比才有意义
    // （一条慢一条快时，并行的墙钟由慢的那条决定，比值会贴近 1 而变得不稳定）。
    writeFileSync(
      casePath,
      [
        "## P1 标题断言",
        "打开 https://example.com 并断言标题包含 Example",
        "",
        "## P2 标题断言（第二个场景）",
        "打开 https://example.com 并断言标题包含 Example",
      ].join("\n"),
      "utf8",
    );

    const started = Date.now();
    const { status, stdout, stderr } = await runCli([
      "--json",
      "--no-side-outputs",
      "--concurrency",
      "2",
      casePath,
    ]);
    const wallMs = Date.now() - started;

    let report;
    try {
      report = JSON.parse(stdout);
    } catch {
      throw new Error(
        `子进程没有产出 JSON 报告（退出码 ${status}）。stderr：\n${stderr.trim() || "(空)"}`,
      );
    }

    assert.equal(report.scenarios.length, 2);
    // 顺序按用例原文：P1 在前、P2 在后，与谁先跑完无关
    assert.equal(report.scenarios[0].name, "P1 标题断言");
    assert.equal(report.scenarios[1].name, "P2 标题断言（第二个场景）");
    assert.equal(report.scenarios[0].status, "pass");
    assert.equal(report.scenarios[1].status, "pass");
    assert.equal(status, 0);

    // 真重叠的证据：墙钟时间明显小于两个场景各自的耗时之和。
    // 单看墙钟可能是慢机器，所以比的是「与各场景耗时之和」的比值，而不是绝对秒数。
    const sum = report.scenarios.reduce((n, s) => n + (s.durationMs ?? 0), 0);
    assert.ok(sum > 0, "报告应带上每个场景的耗时");
    assert.ok(
      wallMs < sum,
      `并发 2 的墙钟时间（${wallMs}ms）应小于各场景耗时之和（${sum}ms）——否则说明没真并行`,
    );
  });
});

// A6：交互模式的执行器。TUI 需要真 TTY，没法在测试里端到端，但它的执行器是个纯函数式的
// 入口——直接调它，就能把「报告 / 录制 / 实时用量」这三样在子进程边界上钉住。
describe("A6 交互模式执行器：场景在子进程里跑", () => {
  test("回收报告与录制，并逐次上报实时用量", async () => {
    const usages = [];
    const result = await runScenarioInChild({
      name: "子进程里的场景",
      body: "打开 https://example.com 并断言标题包含 Example",
      debug: false,
      timeoutMs: 0,
      onUsage: (usage) => usages.push(usage),
    });

    assert.equal(result.report.status, "pass");
    assert.equal(result.report.assertions.length, 1, "断言应原样回到父进程");
    assert.ok(usages.length >= 1, "应至少上报一次实时用量");
    assert.ok(result.usage.calls >= 1, "结算用量应带上 LLM 调用次数");
    // 录制：名字用用户给的那个，来源由批次归档补（执行器不猜写回落点）
    assert.equal(result.recordings.length, 1);
    assert.equal(result.recordings[0].name, "子进程里的场景");
    assert.ok(result.recordings[0].steps.length > 0, "应录到可回放的步骤");
    assert.equal("sourcePath" in result.recordings[0], false);
  });
});
