import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  DEFAULT_DOWNLOAD_TIMEOUT_MS,
  cleanupDownloadedFile,
  downloadDestination,
  downloadDir,
  downloadExpectation,
  downloadRetention,
  downloadedFiles,
  flushDownloadCleanup,
  matchFileName,
  recordDownloaded,
  resetDownloadedFiles,
  sanitizeFileName,
} from "../dist/downloads.js";
import { Recorder } from "../dist/record.js";
import {
  executeReplaySteps,
  loadReplayScript,
  replayScenarioStatus,
  REPLAY_FORMAT,
  REPLAY_VERSION,
} from "../dist/replay.js";

// 纯单元测试：只依赖 dist/*，不需要 bsk / LLM、不发起真实下载。

const NOW = new Date(2026, 8, 23, 17, 25, 11); // 2026-09-23 17:25:11

/** 真实的 bsk 快照片段：一个「确 定」按钮。 */
const SNAPSHOT = [
  "@vom 1",
  "@view 1406x834",
  "L1 page",
  '  RootWebArea "报表"',
  '    @e5 button "确 定"',
].join("\n");

describe("下载产物：文件名清洗", () => {
  test("路径分隔符与 Windows 保留字符被替换，防目录穿越", () => {
    // `/` 换成了 `_`，首部的 `..` 又被去掉一层：无论如何都拼不出上一级目录
    assert.equal(sanitizeFileName("../../etc/passwd"), "_.._etc_passwd");
    assert.equal(sanitizeFileName('报表:1<2>|3?.xlsx'), "报表_1_2__3_.xlsx");
  });

  test("首尾的点与空格被去掉（Windows 上不是合法文件名）", () => {
    assert.equal(sanitizeFileName("  .报表.xlsx.  "), "报表.xlsx");
  });

  test("空名、纯空白或纯点号时退回兜底名", () => {
    assert.equal(sanitizeFileName("   "), "download");
    assert.equal(sanitizeFileName("..."), "download");
  });

  test("超长名被截断，避免撞系统路径长度限制", () => {
    assert.equal(sanitizeFileName("x".repeat(300)).length, 120);
  });

  test("正常的中文导出名原样保留", () => {
    assert.equal(sanitizeFileName("报表-20260923.xlsx"), "报表-20260923.xlsx");
  });
});

describe("下载产物：落盘路径", () => {
  test("显式路径原样使用（不加时间戳前缀）", () => {
    const explicit = join(tmpdir(), "pageqa-out", "报表.xlsx");
    assert.equal(downloadDestination({ explicit, now: NOW }), explicit);
  });

  test("显式相对路径按当前工作目录解析", () => {
    const path = downloadDestination({ explicit: "out/报表.xlsx", now: NOW });
    assert.equal(path, resolve("out/报表.xlsx"));
  });

  test("默认路径 = 下载目录/时间戳-服务器建议名", () => {
    const path = downloadDestination({ suggestedName: "报表.xlsx", now: NOW });
    assert.equal(dirname(path), downloadDir());
    assert.equal(basename(path), "20260923-172511-报表.xlsx");
  });

  test("服务器没给建议名时用兜底名，路径依然带时间戳", () => {
    const path = downloadDestination({ now: NOW });
    assert.equal(basename(path), "20260923-172511-download");
  });

  test("建议名里的非法字符在落盘前就被清洗掉", () => {
    const path = downloadDestination({ suggestedName: "../evil.xlsx", now: NOW });
    assert.equal(basename(path), "20260923-172511-_evil.xlsx");
    assert.equal(dirname(path), downloadDir());
  });
});

describe("下载产物：文件名通配匹配", () => {
  test("* 匹配任意后缀，且大小写不敏感", () => {
    assert.equal(matchFileName("*.xlsx", "报表.XLSX"), true);
    assert.equal(matchFileName("*.XLSX", "报表.xlsx"), true);
    assert.equal(matchFileName("*.xlsx", "报表.csv"), false);
  });

  test("? 匹配单个字符，不带通配符即全等", () => {
    assert.equal(matchFileName("报表?.xlsx", "报表1.xlsx"), true);
    assert.equal(matchFileName("报表?.xlsx", "报表12.xlsx"), false);
    assert.equal(matchFileName("报表.xlsx", "报表.xlsx"), true);
    assert.equal(matchFileName("报表.xlsx", "x报表.xlsx"), false);
  });

  test("正则元字符按字面处理（写用例的人不该为转义买单）", () => {
    assert.equal(matchFileName("a+b(1).xlsx", "a+b(1).xlsx"), true);
  });

  test("包含匹配：对带时间戳前缀的落盘名同样成立", () => {
    // 落盘名 = 时间戳 + 服务器建议名，所以「包含」与「后缀」比写死完整名稳
    assert.equal(matchFileName("*报表*", "20260924-101530-报表.xls"), true);
    assert.equal(matchFileName("*.xls", "20260924-101530-报表.xls"), true);
    assert.equal(matchFileName("*报表*", "20260924-101530-其它明细.xls"), false);
    // 写死完整名时只有「服务器建议名」那一侧能对上（工具层会两个名字都试）
    assert.equal(matchFileName("报表.xls", "20260924-101530-报表.xls"), false);
    assert.equal(matchFileName("报表.xls", "报表.xls"), true);
  });

  test("空模式不匹配任何名字", () => {
    assert.equal(matchFileName("", "a.xlsx"), false);
    assert.equal(matchFileName("   ", "a.xlsx"), false);
  });
});

describe("下载产物：本次运行捕获清单", () => {
  test("按捕获顺序记录，返回的是副本（改不动内部状态）", () => {
    resetDownloadedFiles();
    recordDownloaded("C:/dl/a.xlsx");
    recordDownloaded("C:/dl/b.pdf", { cleaned: true });
    const files = downloadedFiles();
    assert.deepEqual(files, [
      { path: "C:/dl/a.xlsx", cleaned: false },
      { path: "C:/dl/b.pdf", cleaned: true },
    ]);
    files.push({ path: "C:/dl/c", cleaned: false });
    assert.equal(downloadedFiles().length, 2);
    resetDownloadedFiles();
    assert.deepEqual(downloadedFiles(), []);
  });

  test("已清理的产物照样进清单，且如实带 cleaned 标记", () => {
    resetDownloadedFiles();
    recordDownloaded("C:/dl/报表.xls", { cleaned: true });
    assert.deepEqual(downloadedFiles(), [
      { path: "C:/dl/报表.xls", cleaned: true },
    ]);
    resetDownloadedFiles();
  });
});

describe("下载产物：通过后清理的规则", () => {
  test("默认路径 + 开关打开 → 清理；显式 out 或开关关掉 → 保留", () => {
    assert.equal(downloadRetention({ cleanupEnabled: true }), "clean");
    assert.equal(
      downloadRetention({ explicit: true, cleanupEnabled: true }),
      "keep",
    );
    assert.equal(downloadRetention({ cleanupEnabled: false }), "keep");
    assert.equal(
      downloadRetention({ explicit: true, cleanupEnabled: false }),
      "keep",
    );
  });

  test("cleanupDownloadedFile 删掉文件返回 true；文件不在返回 false", () => {
    const file = join(mkdtempSync(join(tmpdir(), "pageqa-dl-clean-")), "报表.xls");
    writeFileSync(file, "x", "utf8");
    assert.equal(existsSync(file), true);
    assert.equal(cleanupDownloadedFile(file), true);
    assert.equal(existsSync(file), false);
    assert.equal(cleanupDownloadedFile(file), false);
  });
});

describe("下载产物：收尾统一清理（延迟删除）", () => {
  test("登记待清理的文件在 flush 时才删，并如实标记 cleaned", () => {
    const dir = mkdtempSync(join(tmpdir(), "pageqa-dl-flush-"));
    const file = join(dir, "报表.xls");
    writeFileSync(file, "x", "utf8");
    resetDownloadedFiles();
    recordDownloaded(file, { cleanupPending: true });
    // 关键：登记之后文件**还在**——同一场景里后面的断言/步骤可能还要用它
    //（曾经是捕获后立刻删，于是「下载成功了，文件却已经没了」）。
    assert.equal(existsSync(file), true);
    assert.deepEqual(downloadedFiles(), [{ path: file, cleaned: false }]);

    flushDownloadCleanup();
    assert.equal(existsSync(file), false);
    assert.deepEqual(downloadedFiles(), [{ path: file, cleaned: true }]);
    resetDownloadedFiles();
  });

  test("保留的产物不被碰；清理失败如实标记为未清理（不假装删掉了）", () => {
    const dir = mkdtempSync(join(tmpdir(), "pageqa-dl-flush2-"));
    const keep = join(dir, "keep.txt");
    const absent = join(dir, "never-written.txt");
    writeFileSync(keep, "x", "utf8");
    resetDownloadedFiles();
    recordDownloaded(keep);
    recordDownloaded(absent, { cleanupPending: true });

    flushDownloadCleanup();
    assert.equal(existsSync(keep), true);
    assert.deepEqual(downloadedFiles(), [
      { path: keep, cleaned: false },
      { path: absent, cleaned: false },
    ]);
    resetDownloadedFiles();
  });

  test("reset 会连待清理登记一起清掉（同一进程跑多次不串味）", () => {
    const file = join(tmpdir(), "pageqa-dl-reset.txt");
    resetDownloadedFiles();
    recordDownloaded(file, { cleanupPending: true });
    resetDownloadedFiles();
    flushDownloadCleanup(); // 不该有任何动作
    assert.deepEqual(downloadedFiles(), []);
  });
});

describe("下载产物：断言期望文案", () => {
  test("不带文件名期望与实际名字期望是两句不同的期望", () => {
    const plain = downloadExpectation();
    const named = downloadExpectation("*.xlsx");
    assert.notEqual(plain, named);
    assert.match(named, /\*\.xlsx/);
  });
});

describe("录制：download 步骤", () => {
  test("记下语义定位符、文件名期望与显式等待上限", () => {
    const r = new Recorder([]);
    r.noteTool({
      name: "download",
      params: { target: "@e5", expectName: "*.xlsx", timeoutMs: 120000 },
      ok: true,
      lastSnapshot: SNAPSHOT,
    });
    const [step] = r.recorded;
    assert.equal(step.kind, "download");
    assert.equal(step.target, "@e5");
    assert.equal(step.expectName, "*.xlsx");
    assert.equal(step.timeoutMs, 120000);
    assert.equal(step.locator.role, "button");
    assert.equal(step.locator.name, "确 定");
  });

  test("没给等待上限就不写进脚本（将来改默认值才不会失效）", () => {
    const r = new Recorder([]);
    r.noteTool({
      name: "download",
      params: { target: "@e5" },
      ok: true,
      lastSnapshot: SNAPSHOT,
    });
    assert.equal(r.recorded[0].timeoutMs, undefined);
    assert.equal(r.recorded[0].out, undefined);
  });

  test("显式落盘路径被记下；失败的下载不记录", () => {
    const r = new Recorder([]);
    r.noteTool({
      name: "download",
      params: { target: "@e5", out: "D:/out/报表.xlsx" },
      ok: true,
      lastSnapshot: SNAPSHOT,
    });
    assert.equal(r.recorded[0].out, "D:/out/报表.xlsx");

    r.noteTool({
      name: "download",
      params: { target: "@e5" },
      ok: false,
      lastSnapshot: SNAPSHOT,
    });
    // 失败的那次不进脚本：它只是模型试探的一部分
    assert.equal(r.recorded.length, 1);
  });
});

describe("回放：download 步骤", () => {
  /** 假的操作层：记录调用、可注入下载结局，避免依赖真实浏览器。 */
  function makeOps({ snapshot = "", result = { pass: true, evidence: "已落盘" } } = {}) {
    const calls = [];
    let assertOutcome = null;
    return {
      calls,
      session: "fake",
      lastSnapshot: () => "",
      snapshot: () => snapshot,
      download: async (target, out, expectName, timeoutMs) => {
        calls.push({ target, out, expectName, timeoutMs });
        assertOutcome = {
          expectation: downloadExpectation(expectName),
          pass: result.pass,
          evidence: result.evidence,
        };
        return "断言文本";
      },
      wait: () => "已等待",
      lastAssert: () => assertOutcome,
      lastAssertSemantic: () => false,
    };
  }

  const run = (ops, steps, options = {}) =>
    executeReplaySteps(
      ops,
      { name: "S", caseSteps: ["点击导出并确认下载"], steps },
      { expand: (t) => t, jevActive: false, ...options },
    );

  const downloadStep = {
    kind: "download",
    step: 1,
    target: "#export-confirm",
    locator: null,
    expectName: "*.xlsx",
  };

  test("捕获成功 → 一条成立的断言，等待上限用默认值", async () => {
    const ops = makeOps();
    const out = await run(ops, [downloadStep]);
    assert.equal(out.assertions.length, 1);
    assert.equal(out.assertions[0].verdict, "pass");
    assert.equal(out.failed, 0);
    assert.equal(out.skipped.length, 0);
    assert.equal(ops.calls[0].target, "#export-confirm");
    assert.equal(ops.calls[0].expectName, "*.xlsx");
    assert.equal(ops.calls[0].timeoutMs, DEFAULT_DOWNLOAD_TIMEOUT_MS);
    assert.equal(replayScenarioStatus(out), "pass");
  });

  test("文件名不符 → 不成立断言（失败结论，不是跳过）", async () => {
    const ops = makeOps({
      result: { pass: false, evidence: "下载的文件名不符合期望 *.xlsx：实际是 报表.csv" },
    });
    const out = await run(ops, [downloadStep]);
    assert.equal(out.assertions.length, 1);
    assert.equal(out.assertions[0].verdict, "fail");
    assert.match(out.assertions[0].evidence, /报表\.csv/);
    assert.equal(out.skipped.length, 0);
    assert.equal(replayScenarioStatus(out), "fail");
  });

  test("触发元素找不到 → 也是 FAIL 断言，绝不按「元素未找到」跳过", async () => {
    // 定位符要求 button「确 定」，而当前快照里没有它
    const ops = makeOps({ snapshot: '  @e1 button "取 消"' });
    const out = await run(ops, [
      {
        ...downloadStep,
        target: "@e9",
        locator: { role: "button", name: "确 定", nth: 0, target: "@e9" },
      },
    ]);
    assert.equal(out.skipped.length, 0);
    assert.equal(out.assertions.length, 1);
    assert.equal(out.assertions[0].verdict, "fail");
    assert.match(out.assertions[0].evidence, /找不到下载的触发元素/);
    assert.equal(ops.calls.length, 0); // 没有去点任何东西
    assert.equal(replayScenarioStatus(out), "fail");
  });

  test("显式落盘路径与等待上限按脚本回放，占位符重新展开", async () => {
    const ops = makeOps();
    await run(
      ops,
      [{ ...downloadStep, out: "/out/${date}/报表.xlsx", timeoutMs: 90000 }],
      { expand: (t) => t.replace("${date}", "20260923") },
    );
    assert.equal(ops.calls[0].out, "/out/20260923/报表.xlsx");
    assert.equal(ops.calls[0].timeoutMs, 90000);
  });
});

describe("回放脚本：download 步骤的读写", () => {
  const script = (steps) => ({
    format: REPLAY_FORMAT,
    version: REPLAY_VERSION,
    recordedAt: NOW.toISOString(),
    source: { path: null, hash: null },
    scenarios: [{ name: "S", caseSteps: ["点击导出并确认下载"], steps }],
  });

  const writeScript = (data) => {
    const path = join(mkdtempSync(join(tmpdir(), "pageqa-dl-")), "s.replay.json");
    writeFileSync(path, JSON.stringify(data, null, 2), "utf8");
    return path;
  };

  test("download 是已知步骤类型，正常加载", () => {
    const path = writeScript(
      script([
        {
          kind: "download",
          step: 1,
          target: "#export-confirm",
          locator: null,
          expectName: "*.xlsx",
          timeoutMs: 120000,
        },
      ]),
    );
    const loaded = loadReplayScript(path);
    assert.equal(loaded.scenarios[0].steps[0].kind, "download");
    assert.equal(loaded.scenarios[0].steps[0].expectName, "*.xlsx");
  });

  test("不认识的步骤类型仍然被拒绝（带病脚本不许加载）", () => {
    const path = writeScript(
      script([{ kind: "download_all", step: 1, target: "#x", locator: null }]),
    );
    assert.throws(() => loadReplayScript(path), /download_all/);
  });
});
