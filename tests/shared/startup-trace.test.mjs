import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 纯单元测试：启动打点的开关语义、落盘内容与汇总格式。
//
// 打点模块在**加载时**读一次 `PAGEQA_STARTUP_TRACE`（见 startup-trace.ts 的注释），
// 因此每个用例用带随机 query 的动态 import 拿一份全新的模块实例——这样「关掉」与
// 「打开」两种状态才能在同一个进程里各测一遍。

const MODULE_URL = new URL("../../dist/shared/startup-trace.js", import.meta.url).href;

/** 取一份全新的模块实例（env 已由调用方设好）。 */
function freshModule(tag) {
  return import(`${MODULE_URL}?case=${tag}`);
}

function tempTracePath() {
  const dir = mkdtempSync(join(tmpdir(), "pageqa-trace-"));
  return { dir, path: join(dir, "boot.log") };
}

describe("启动打点：开关", () => {
  test("未设置 PAGEQA_STARTUP_TRACE 时完全关闭：不打点、不建文件、无汇总", async () => {
    delete process.env.PAGEQA_STARTUP_TRACE;
    const { markStartup, startupTraceEnabled, startupTraceSummary } = await freshModule("off");

    assert.equal(startupTraceEnabled(), false);
    markStartup("main");
    assert.equal(startupTraceSummary(), undefined);
  });

  test("设为 0 / false 也算关闭（免得手滑以为开了）", async () => {
    for (const value of ["0", "false"]) {
      process.env.PAGEQA_STARTUP_TRACE = value;
      const mod = await freshModule(`off-${value}`);
      assert.equal(mod.startupTraceEnabled(), false, value);
    }
    delete process.env.PAGEQA_STARTUP_TRACE;
  });
});

describe("启动打点：落盘与汇总", () => {
  test("每个打点立刻追加一行，汇总给出相邻差值与累计耗时", async () => {
    const { dir, path } = tempTracePath();
    process.env.PAGEQA_STARTUP_TRACE = path;
    try {
      const { markStartup, startupTraceEnabled, startupTraceSummary } = await freshModule("on");

      assert.equal(startupTraceEnabled(), true);
      markStartup("index-module");
      markStartup("main");

      // 文件里应当有：一行分隔头 + 每个打点一行（进程卡死也留得下证据，这是它存在的理由）。
      const lines = readFileSync(path, "utf8").trimEnd().split("\n");
      assert.match(lines[0], /^--- .* pid=\d+ node=v/);
      assert.match(lines[1], /^\d+ms\tindex-module$/);
      assert.match(lines[2], /^\d+ms\tmain$/);

      const summary = startupTraceSummary();
      assert.match(summary, /^\[trace\] startup \d+ms: index-module=\d+ms · main=\+\d+ms/);
      // 汇总行把落点也带上：截图/贴日志时不用再问一句「文件在哪」。
      assert.ok(summary.includes(path), summary);
    } finally {
      delete process.env.PAGEQA_STARTUP_TRACE;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("文件落在不存在的目录里时会自己建出来", async () => {
    const { dir } = tempTracePath();
    const nested = join(dir, "a", "b", "boot.log");
    process.env.PAGEQA_STARTUP_TRACE = nested;
    try {
      const { markStartup } = await freshModule("nested");
      markStartup("main");
      assert.equal(existsSync(nested), true);
    } finally {
      delete process.env.PAGEQA_STARTUP_TRACE;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("写不进去也不抛：打点不该把启动带崩", async () => {
    const { dir, path } = tempTracePath();
    // 把「文件」变成一个目录：appendFileSync 必然失败。
    process.env.PAGEQA_STARTUP_TRACE = join(path, "sub");
    try {
      const { markStartup } = await freshModule("broken");
      assert.doesNotThrow(() => markStartup("main"));
    } finally {
      delete process.env.PAGEQA_STARTUP_TRACE;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("启动打点：首帧时刻", () => {
  test("第一次写 stdout 记 first-frame 并回调，之后立刻还原不再重复记", async () => {
    const { dir, path } = tempTracePath();
    process.env.PAGEQA_STARTUP_TRACE = path;
    const original = process.stdout.write;
    try {
      const { markFirstStdoutWrite, startupTraceSummary } = await freshModule("first-write");
      let callbacks = 0;
      markFirstStdoutWrite("first-frame", () => {
        callbacks += 1;
      });

      // 空串写入：足以触发包层，但不会往测试输出里塞任何东西。
      process.stdout.write("");
      process.stdout.write("");

      assert.equal(callbacks, 1, "回调只在首帧那一次执行");
      assert.equal(process.stdout.write, original, "记完必须还原，输出行为不能变");

      const summary = startupTraceSummary();
      // 它是第一个打点时给绝对值，否则给与前一点的差值。
      assert.match(summary, /first-frame=(\+\d+|\d+)ms/);
      // 第二次写入不该留下第二个打点。
      assert.equal(summary.split("first-frame").length, 2, summary);
    } finally {
      process.stdout.write = original;
      delete process.env.PAGEQA_STARTUP_TRACE;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
