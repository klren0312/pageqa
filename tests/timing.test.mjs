import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  TimingCollector,
  avgMs,
  formatMs,
  renderTiming,
} from "../dist/timing.js";

// 纯单元测试：累加器与渲染都是纯逻辑（时间点由调用方注入），不需要浏览器与模型。

const usage = (over = {}) => ({
  input: 1_000,
  output: 200,
  cacheRead: 4_000,
  cacheWrite: 0,
  reasoning: 0,
  total: 5_200,
  calls: 3,
  ...over,
});

describe("TimingCollector：LLM 与工具的时间口径", () => {
  test("一轮 LLM 的耗时要把该轮内的工具耗时减掉", () => {
    const c = new TimingCollector();
    c.noteTurnStart(0);
    c.noteToolStart("t1");
    c.noteCommand("click", 400); // 与真实路径等价：工具耗时也走 noteCommand 累加
    c.noteTurnEnd(1_000);
    const s = c.summary(2_000);
    // 1000ms 的一轮里 400ms 是浏览器时间：算进 LLM 就会把这张表最该看清的一项搞错。
    assert.equal(s.llm.calls, 1);
    assert.equal(s.llm.totalMs, 600);
    assert.equal(s.commands.calls, 1);
    assert.equal(s.commands.totalMs, 400);
    assert.equal(s.otherMs, 1_000); // 2000 - 600 - 400
  });

  test("多次工具的耗时按 toolCallId 配对，配不上的一律忽略", () => {
    const c = new TimingCollector();
    c.noteTurnStart(0);
    c.noteToolStart("a");
    c.noteToolStart("b");
    c.noteToolEnd("a", "snapshot");
    c.noteToolEnd("b", "click");
    c.noteToolEnd("ghost", "click"); // 没有 start：忽略，不产生半条数据
    c.noteTurnEnd(1_000);
    const s = c.summary(1_000);
    assert.equal(s.commands.calls, 2);
    assert.equal(s.commands.byName.map((x) => x.name).sort().join(","), "click,snapshot");
  });

  test("回放路径：命令不在任何轮里，因此不影响 LLM 口径", () => {
    const c = new TimingCollector();
    c.noteCommand("click", 127);
    c.noteCommand("snapshot", 61);
    c.noteCommand("click", 33);
    const s = c.summary(1_000);
    assert.equal(s.llm.calls, 0);
    assert.equal(s.llm.totalMs, 0);
    assert.equal(s.commands.calls, 3);
    assert.equal(s.commands.totalMs, 221);
    assert.equal(s.otherMs, 779);
  });

  test("没有 turn_end 的那一轮不上报（被中止的一轮不该变成半个数字）", () => {
    const c = new TimingCollector();
    c.noteTurnStart(0);
    c.noteToolStart("a");
    c.noteToolEnd("a", "click");
    const s = c.summary(500);
    assert.equal(s.llm.calls, 0);
    assert.equal(s.commands.calls, 1);
  });

  test("失败计数分别记在总数与明细上", () => {
    const c = new TimingCollector();
    c.noteTurnStart(0);
    c.noteToolStart("a");
    c.noteToolEnd("a", "click", true);
    c.noteTurnEnd(100);
    c.noteCommand("assert_text", 10, true);
    c.noteCommand("assert_text", 10);
    const s = c.summary(1_000);
    assert.equal(s.commands.errors, 2);
    const click = s.commands.byName.find((x) => x.name === "click");
    const assertText = s.commands.byName.find((x) => x.name === "assert_text");
    assert.equal(click.errors, 1);
    assert.equal(assertText.calls, 2);
    assert.equal(assertText.errors, 1);
  });

  test("明细按耗时降序；耗时相同时按名字定序（可复现）", () => {
    const c = new TimingCollector();
    c.noteCommand("b", 100);
    c.noteCommand("a", 100);
    c.noteCommand("c", 300);
    const names = c.summary(1_000).commands.byName.map((x) => x.name);
    assert.deepEqual(names, ["c", "a", "b"]);
  });

  test("并行工具让累加值超过墙钟时，「其它」夹到 0 而不是报负数", () => {
    const c = new TimingCollector();
    c.noteTurnStart(0);
    c.noteCommand("a", 900);
    c.noteCommand("b", 900);
    c.noteTurnEnd(1_000);
    const s = c.summary(1_000);
    assert.equal(s.llm.totalMs, 0); // 轮耗时 1000 - 工具 1800 → 夹到 0
    assert.equal(s.otherMs, 0); // 1000 - 0 - 1800 → 夹到 0
  });
});

describe("格式化", () => {
  test("avgMs：次数为 0 时给 0（不产生 NaN/Infinity）", () => {
    assert.equal(avgMs(0, 0), 0);
    assert.equal(avgMs(100, 3), 33);
  });

  test("formatMs：1 秒以下保留毫秒", () => {
    assert.equal(formatMs(0), "0ms");
    assert.equal(formatMs(61), "61ms");
    assert.equal(formatMs(999), "999ms");
    assert.equal(formatMs(1_000), "1.0s");
    assert.equal(formatMs(12_340), "12.3s");
    assert.equal(formatMs(65_000), "1m5s");
  });
});

describe("renderTiming", () => {
  test("录制场景：标题 + LLM + 工具明细 + 其它 + token", () => {
    const c = new TimingCollector();
    c.noteTurnStart(0);
    c.noteCommand("snapshot", 61);
    c.noteTurnEnd(1_061); // 这一轮 LLM = 1000ms
    c.noteCommand("click", 127);
    const lines = renderTiming(c.summary(3_190, usage()));
    const text = lines.join("\n");
    assert.match(lines[0], /^耗时构成（墙钟 3\.2s）$/);
    assert.match(text, /LLM 调用 1 次，1\.0s（31%），平均 1\.0s/);
    assert.match(text, /工具调用 2 次，188ms（6%），平均 94ms/);
    assert.match(text, /click\s+1 次\s+127ms\s+平均 127ms/);
    assert.match(text, /其它（编排\/等待\/收尾）2\.0s（63%）/);
    assert.match(text, /token：输入 1000，输出 200，缓存读取 4000/);
  });

  test("回放场景：没有 LLM 行，也不该出现 token 行", () => {
    const c = new TimingCollector();
    c.noteCommand("navigate", 700);
    c.noteCommand("click", 130);
    const text = renderTiming(c.summary(2_000)).join("\n");
    assert.doesNotMatch(text, /LLM 调用/);
    assert.doesNotMatch(text, /token：/);
    assert.match(text, /工具调用 2 次，830ms（42%）/);
  });

  test("明细只列前 6 条，其余折成一行", () => {
    const c = new TimingCollector();
    for (let i = 0; i < 9; i++) c.noteCommand(`tool${i}`, (9 - i) * 10);
    const lines = renderTiming(c.summary(1_000));
    const detail = lines.filter((l) => l.startsWith("    tool"));
    assert.equal(detail.length, 6);
    assert.equal(detail[0], "    tool0      1 次  90ms  平均 90ms");
    assert.match(lines.join("\n"), /另有 3 种更快的工具未列出/);
  });

  test("失败次数只在非零时出现", () => {
    const c = new TimingCollector();
    c.noteCommand("click", 100, true);
    const text = renderTiming(c.summary(1_000)).join("\n");
    assert.match(text, /工具调用 1 次，100ms（10%），平均 100ms，其中失败 1 次/);
    assert.match(text, /click\s+1 次\s+100ms\s+平均 100ms\s+失败 1 次/);

    const clean = new TimingCollector();
    clean.noteCommand("click", 100);
    assert.doesNotMatch(renderTiming(clean.summary(1_000)).join("\n"), /失败/);
  });

  test("墙钟为 0 时占比不产生 NaN", () => {
    const c = new TimingCollector();
    const text = renderTiming(c.summary(0)).join("\n");
    assert.doesNotMatch(text, /NaN|Infinity/);
    assert.match(text, /其它（编排\/等待\/收尾）0ms（0%）/);
  });
});
