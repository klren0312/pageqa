import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  currentLogFile,
  disableFileLog,
  enableFileLog,
  info,
  pruneLogs,
  setSink,
} from "../../dist/shared/log.js";

// 落盘这一层的两个容易被忽略的点：
// 1. 清理**只清自己写的文件**——同目录还放着 auth.json / startup-trace.log，
//    正则写宽了就是把用户的配置删掉；
// 2. 保留期按**文件名里的日期**算，不是 mtime——复制/解压会改写 mtime。

function tempDir() {
  return mkdtempSync(join(tmpdir(), "pageqa-log-"));
}

/** 今天的 dayKey（与实现同一套本地日期口径）。 */
function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 相对今天平移若干天。 */
function dayOffset(days) {
  const [y, m, d] = today().split("-").map(Number);
  const dt = new Date(y, m - 1, d + days);
  const p = (n) => String(n).padStart(2, "0");
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
}

afterEach(() => {
  disableFileLog();
  // 静音 sink 是各用例自己设的，这里统一恢复成 stderr
  setSink(null);
});

describe("日志落盘：写在哪、写什么", () => {
  test("默认按天一个文件，行首带 HH:mm:ss，信息原样保留", () => {
    const dir = tempDir();
    setSink(() => {}); // 只验证文件，不把测试输出刷到 stderr
    const path = enableFileLog({ dir });
    assert.equal(path, join(dir, `pageqa-${today()}.log`));
    assert.equal(currentLogFile(), path);

    info("[pageqa] ▶ #41 navigate http://localhost/#/a");
    const text = readFileSync(path, "utf8");
    assert.match(text, /^\d{2}:\d{2}:\d{2} \[pageqa\] ▶ #41 navigate http:\/\/localhost\/#\/a$/m);
    rmSync(dir, { recursive: true, force: true });
  });

  test("同一天重复启用是追加，不是覆盖（一次运行里多条路径都会建 run）", () => {
    const dir = tempDir();
    setSink(() => {});
    const path = enableFileLog({ dir });
    info("first");
    // 模拟第二个运行/第二个调用方再次启用
    enableFileLog({ dir });
    info("second");

    const lines = readFileSync(path, "utf8").trimEnd().split("\n");
    assert.ok(lines.some((l) => l.endsWith(" first")));
    assert.ok(lines.some((l) => l.endsWith(" second")));
    rmSync(dir, { recursive: true, force: true });
  });

  test("info(msg, fileMsg)：终端拿单行摘要，文件拿完整原文", () => {
    // 现场：`details: This action req…` 把「requires a valid control context from
    // cooperate sync」切掉了，而那半句才是判据。终端必须压单行（视口一行一条、
    // report 按行首解析），文件不该跟着压。
    const dir = tempDir();
    const shown = [];
    setSink((line) => shown.push(line));
    const path = enableFileLog({ dir });

    const full =
      "error: the page changed under the action; the reference context expired\n" +
      "hint: synchronize the session, then re-snapshot before retrying\n" +
      "details: This action requires a valid control context from cooperate sync";
    info("✗ #6 click：details: This action req…", `✗ #6 click：${full}`);

    const file = readFileSync(path, "utf8");
    assert.ok(file.includes("This action requires a valid control context from cooperate sync"));
    assert.equal(file.includes("…"), false, "落盘不应出现省略号");
    // 换行也留着：三行各占一行——首行带时间戳前缀，续行从行首开始
    assert.match(file, /^hint: synchronize the session/m);
    assert.match(file, /^details: This action requires a valid/m);

    // 终端一份：单行、仍是摘要
    assert.equal(shown.length, 1);
    assert.equal(shown[0].includes("\n"), false);
    assert.ok(shown[0].includes("…"));
    rmSync(dir, { recursive: true, force: true });
  });

  test("PAGEQA_LOG=0 时整体关闭，不建目录也不建文件", () => {
    process.env.PAGEQA_LOG = "0";
    try {
      setSink(() => {});
      const dir = join(tempDir(), "never");
      assert.equal(enableFileLog({ dir }), undefined);
      info("should not land anywhere");
      assert.equal(existsSync(dir), false);
    } finally {
      delete process.env.PAGEQA_LOG;
    }
  });
});

describe("一天一清：保留期与清理范围", () => {
  test("只留今天：昨天的日志在启用时被删掉", () => {
    const dir = tempDir();
    const stale = join(dir, `pageqa-${dayOffset(-1)}.log`);
    writeFileSync(stale, "yesterday\n", "utf8");
    setSink(() => {});
    enableFileLog({ dir });
    assert.equal(existsSync(stale), false);
    rmSync(dir, { recursive: true, force: true });
  });

  test("同目录的其它文件一个都不碰（auth.json / startup-trace.log）", () => {
    const dir = tempDir();
    const keep = ["auth.json", "startup-trace.log", "pageqa-not-a-date.log"];
    for (const name of keep) writeFileSync(join(dir, name), "x", "utf8");
    const stale = join(dir, `pageqa-${dayOffset(-9)}.log`);
    writeFileSync(stale, "old\n", "utf8");
    setSink(() => {});
    enableFileLog({ dir });

    for (const name of keep) assert.equal(existsSync(join(dir, name)), true, name);
    assert.equal(existsSync(stale), false);
    rmSync(dir, { recursive: true, force: true });
  });

  test("keepDays=2 时昨天留着、前天删掉", () => {
    const dir = tempDir();
    const yesterday = join(dir, `pageqa-${dayOffset(-1)}.log`);
    const before = join(dir, `pageqa-${dayOffset(-2)}.log`);
    writeFileSync(yesterday, "y\n", "utf8");
    writeFileSync(before, "b\n", "utf8");

    assert.equal(pruneLogs(dir, 2, today()), 1);
    assert.equal(existsSync(yesterday), true);
    assert.equal(existsSync(before), false);
    rmSync(dir, { recursive: true, force: true });
  });

  test("keepDays 小于 1 时按 1 处理：不会把今天也删掉", () => {
    const dir = tempDir();
    const fileName = `pageqa-${today()}.log`;
    writeFileSync(join(dir, fileName), "today\n", "utf8");
    assert.equal(pruneLogs(dir, 0, today()), 0);
    assert.equal(existsSync(join(dir, fileName)), true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("目录不存在时清理不报错（首次运行的常态）", () => {
    assert.equal(pruneLogs(join(tmpdir(), "pageqa-does-not-exist-xyz"), 1), 0);
  });
});