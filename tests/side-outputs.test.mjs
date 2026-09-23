import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// config.ts 在模块加载时按 homedir() 定位 ~/.pageqa，所以必须在**动态 import 之前**
// 把 HOME/USERPROFILE 指到临时目录——否则测试会往用户主目录里写 config.json。
const home = mkdtempSync(join(tmpdir(), "pageqa-side-outputs-home-"));
process.env.USERPROFILE = home;
process.env.HOME = home;

const { setLocale } = await import("../dist/i18n.js");
const { setSink } = await import("../dist/log.js");
const {
  CONFIG_PATH,
  ensureConfigDir,
  readSideOutputPrefs,
  saveLocale,
  saveSideOutputPref,
} = await import("../dist/config.js");
const {
  emitSideOutputs,
  hasRunScenarios,
  renderSideOutputLines,
  writeReportSideOutput,
} = await import("../dist/side-outputs.js");

setLocale("zh");

const base = (over = {}) => ({
  status: "pass",
  assertions: [],
  transcript: "",
  ...over,
});

const ALL_ON = { htmlReport: true, replayScript: true };

/** 直接把配置写到隔离的 HOME 下（目录可能还没被创建）。 */
function writeConfig(value) {
  ensureConfigDir();
  writeFileSync(CONFIG_PATH, JSON.stringify(value), "utf8");
}

describe("旁路产物开关（config）", () => {
  test("配置文件不存在时两个开关都视为开", () => {
    rmSync(CONFIG_PATH, { force: true });
    assert.deepEqual(readSideOutputPrefs(), {
      htmlReport: true,
      replayScript: true,
    });
  });

  test("只认布尔值：字符串 \"false\" 不算关", () => {
    writeConfig({ htmlReport: "false" });
    assert.equal(readSideOutputPrefs().htmlReport, true);
  });

  test("关掉后写回文件，且不影响其它字段", () => {
    saveLocale("zh");
    saveSideOutputPref("replayScript", false);
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    assert.equal(raw.replayScript, false);
    assert.equal(raw.locale, "zh");
    assert.equal(readSideOutputPrefs().replayScript, false);
  });

  test("配置文件带 UTF-8 BOM 时仍能读到开关", () => {
    // 记事本 / PowerShell 的 Set-Content -Encoding utf8 都会写 BOM，而 JSON.parse 见 BOM 就抛错。
    ensureConfigDir();
    writeFileSync(
      CONFIG_PATH,
      "\uFEFF" + JSON.stringify({ htmlReport: false, replayScript: false }),
      "utf8",
    );
    assert.deepEqual(readSideOutputPrefs(), {
      htmlReport: false,
      replayScript: false,
    });
    // 带 BOM 时写回也不能丢掉用户已有的字段
    saveLocale("zh");
    assert.equal(readSideOutputPrefs().htmlReport, false);
  });

  test("从没改过的开关不会被写进配置文件", () => {
    writeConfig({ locale: "zh" });
    saveLocale("en");
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    assert.equal("htmlReport" in raw, false);
    assert.equal("replayScript" in raw, false);
  });
});

describe("renderSideOutputLines", () => {
  test("报告与脚本都写出：含路径与可复制的回放命令", () => {
    assert.deepEqual(
      renderSideOutputLines(
        { kind: "written", path: "pageqa-report/report-1.html" },
        { kind: "written", paths: ["examples/smoke.replay.json"] },
      ),
      [
        "[pageqa] 本次产物：",
        "[pageqa]   测试报告: pageqa-report/report-1.html",
        "[pageqa]   回放脚本: examples/smoke.replay.json",
        "[pageqa]   回放方式: pageqa --replay examples/smoke.replay.json",
      ],
    );
  });

  test("多份脚本逐条列出，回放方式退化为占位写法", () => {
    const lines = renderSideOutputLines(
      { kind: "written", path: "pageqa-report/report-1.html" },
      { kind: "written", paths: ["a.replay.json", "b.replay.json"] },
    );
    assert.ok(lines.includes("[pageqa]   回放脚本: a.replay.json"));
    assert.ok(lines.includes("[pageqa]   回放脚本: b.replay.json"));
    assert.ok(
      lines.includes("[pageqa]   回放方式: pageqa --replay <上面任一份脚本路径>"),
    );
    assert.equal(lines.filter((l) => l.includes("回放方式")).length, 1);
  });

  test("关掉、没有可回放动作、没有落点：都显式说明原因", () => {
    const off = renderSideOutputLines({ kind: "off" }, { kind: "off" });
    assert.ok(off.includes("[pageqa]   测试报告: 未生成（/setting 中已关闭）"));
    assert.ok(off.includes("[pageqa]   回放脚本: 未生成（/setting 中已关闭）"));

    const none = renderSideOutputLines({ kind: "written", path: "p" }, { kind: "none" });
    assert.ok(
      none.includes("[pageqa]   回放脚本: 未生成（本次没有可回放的动作）"),
    );

    const noTarget = renderSideOutputLines(
      { kind: "written", path: "p" },
      { kind: "no-target", count: 2 },
    );
    assert.ok(
      noTarget.includes("[pageqa]   回放脚本: 未生成（2 个场景没有落点文件）"),
    );

    const skipped = renderSideOutputLines({ kind: "skipped" }, { kind: "none" });
    assert.ok(
      skipped.includes("[pageqa]   测试报告: 未生成（本次没有执行任何用例）"),
    );
  });

  test("写出了脚本但跳过了无落点场景：追加一行说明", () => {
    const lines = renderSideOutputLines(
      { kind: "written", path: "p" },
      { kind: "written", paths: ["a.replay.json"], noTarget: 1 },
    );
    assert.ok(
      lines.includes("[pageqa]   回放脚本: 未生成（1 个场景没有落点文件）"),
    );
  });

  test("写盘失败如实写出原因，不隐藏", () => {
    const lines = renderSideOutputLines(
      { kind: "failed", error: "EACCES" },
      { kind: "failed", error: "EACCES" },
    );
    assert.ok(lines.includes("[pageqa]   测试报告: 写入失败（EACCES）"));
    assert.ok(lines.includes("[pageqa]   回放脚本: 写入失败（EACCES）"));
  });

  test("回放模式（na）不列脚本行", () => {
    const lines = renderSideOutputLines({ kind: "written", path: "p" }, { kind: "na" });
    assert.ok(lines.includes("[pageqa]   测试报告: p"));
    assert.equal(lines.some((l) => l.includes("回放脚本")), false);
  });
});

describe("hasRunScenarios（没跑用例就不留报告）", () => {
  const scenario = (status) => ({
    name: "s",
    status,
    steps: [],
    trace: [],
    assertions: [],
  });

  test("单场景报告恒为真（批处理 / 回放都来自一次真实执行）", () => {
    assert.equal(hasRunScenarios(base()), true);
  });

  test("空套件（一条都没跑）为假", () => {
    assert.equal(hasRunScenarios({ ...base(), scenarios: [] }), false);
  });

  test("场景全是被取消、且没调用过模型（一条都没开始）为假", () => {
    assert.equal(
      hasRunScenarios({ ...base(), scenarios: [scenario("cancelled")] }),
      false,
    );
  });

  test("有跑完的场景（含失败）为真", () => {
    assert.equal(
      hasRunScenarios({ ...base(), scenarios: [scenario("fail")] }),
      true,
    );
  });

  test("被中止但真调用过模型（有半截轨迹）为真", () => {
    assert.equal(
      hasRunScenarios({
        ...base(),
        scenarios: [scenario("cancelled")],
        usage: {
          input: 10,
          output: 2,
          cacheRead: 0,
          cacheWrite: 0,
          reasoning: 0,
          total: 12,
          calls: 3,
        },
      }),
      true,
    );
  });
});

describe("writeReportSideOutput", () => {
  test("一条用例都没跑过：不写文件、也不建目录", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "pageqa-side-skip-")), "reports");
    const outcome = writeReportSideOutput(
      { ...base(), scenarios: [] },
      ALL_ON,
      dir,
    );
    assert.deepEqual(outcome, { kind: "skipped" });
    assert.equal(existsSync(dir), false);
  });

  test("开关关掉：不写文件、连目录都不建", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "pageqa-side-off-")), "reports");
    const outcome = writeReportSideOutput(
      base(),
      { htmlReport: false, replayScript: true },
      dir,
    );
    assert.deepEqual(outcome, { kind: "off" });
    assert.equal(existsSync(dir), false);
  });

  test("开关打开：写出报告并返回路径", () => {
    const dir = mkdtempSync(join(tmpdir(), "pageqa-side-on-"));
    try {
      const outcome = writeReportSideOutput(base(), ALL_ON, dir);
      assert.equal(outcome.kind, "written");
      assert.ok(existsSync(outcome.path));
      assert.ok(readFileSync(outcome.path, "utf8").includes("PASS"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("写盘失败：返回 failed 而不是抛错（旁路产物不改退出码）", () => {
    const dir = mkdtempSync(join(tmpdir(), "pageqa-side-fail-"));
    try {
      const blocker = join(dir, "blocker");
      writeFileSync(blocker, "not a dir");
      const outcome = writeReportSideOutput(base(), ALL_ON, blocker);
      assert.equal(outcome.kind, "failed");
      assert.ok(outcome.error);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("emitSideOutputs", () => {
  test("清单经 info 输出（stderr sink），一行一项", () => {
    const captured = [];
    setSink((line) => captured.push(line));
    try {
      emitSideOutputs(
        { kind: "written", path: "pageqa-report/report-1.html" },
        { kind: "written", paths: ["examples/smoke.replay.json"] },
      );
    } finally {
      setSink(null);
    }
    assert.ok(captured.some((l) => l.includes("本次产物")));
    assert.ok(captured.some((l) => l.includes("report-1.html")));
    assert.ok(captured.some((l) => l.includes("pageqa --replay")));
  });
});

after(() => {
  rmSync(home, { recursive: true, force: true });
});
