import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createSession, defineDocFamily } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import {
  assertSafeId,
  clipText,
  databasePath,
  listArchives,
  MAX_TEXT_CHARS,
  pruneArchives,
  readArchive,
  SessionCollector,
  SESSIONS_DATABASE,
  summarizeMessage,
  writeArchive,
} from "../dist/session-archive.js";

// 纯逻辑 + 临时目录：不碰浏览器、模型，也不写用户真实的 ~/.pageqa。

/** 一份最小的运行参数（只覆盖用例关心的字段）。 */
const params = (over = {}) => ({
  systemPrompt: "sys",
  model: { provider: "pageqa", id: "m1" },
  tools: [
    {
      name: "click",
      label: "Click",
      description: "点击",
      parameters: { type: "object" },
    },
  ],
  prompt: "### 步骤 1：打开页面",
  caseText: "打开页面\n断言标题",
  steps: ["打开页面", "断言标题"],
  vars: [],
  debug: false,
  ...over,
});

/** 临时存档目录（每个用例一个，跑完删掉）。 */
function tempDir() {
  return mkdtempSync(join(tmpdir(), "pageqa-session-"));
}

describe("clipText：超长文本压到上限并报原始长度", () => {
  test("不超限时原样返回、不带截断标记", () => {
    const r = clipText("abc", 10);
    assert.equal(r.text, "abc");
    assert.equal(r.chars, 3);
    assert.equal(r.truncated, undefined);
  });

  test("超限时截断，chars 记的是截断前的长度", () => {
    const r = clipText("0123456789abc", 10);
    assert.equal(r.text, "0123456789");
    assert.equal(r.chars, 13);
    assert.equal(r.truncated, true);
  });
});

describe("summarizeMessage：把一条消息压成可读摘要", () => {
  test("字符串 content 直接取文本", () => {
    const m = summarizeMessage({ role: "user", content: "打开页面" });
    assert.equal(m.role, "user");
    assert.equal(m.text, "打开页面");
    assert.equal(m.chars, 4);
  });

  test("toolCall 块转成一行（入参是排查点错元素的第一手材料，不能丢）", () => {
    const m = summarizeMessage({
      role: "assistant",
      content: [
        { type: "text", text: "我来点击" },
        { type: "toolCall", name: "click", arguments: { target: "@e3" } },
      ],
    });
    assert.match(m.text, /我来点击/);
    assert.match(m.text, /\[toolCall\] click \{"target":"@e3"\}/);
  });

  test("带上工具名与 stopReason（中止/报错轮次的直接证据）", () => {
    const m = summarizeMessage({
      role: "toolResult",
      toolName: "assert_text",
      content: "不成立",
      stopReason: "aborted",
    });
    assert.equal(m.toolName, "assert_text");
    assert.match(m.text, /\[stopReason=aborted\]/);
  });

  test("超长内容被截断，并标出原始长度", () => {
    const m = summarizeMessage({ role: "user", content: "x".repeat(MAX_TEXT_CHARS + 5) });
    assert.equal(m.truncated, true);
    assert.equal(m.chars, MAX_TEXT_CHARS + 5);
    assert.equal(m.text.length, MAX_TEXT_CHARS);
  });
});

describe("SessionCollector：轮次与工具调用", () => {
  test("一轮 = turn_start → 上下文 → turn_end，耗时与用量落在同一条上", () => {
    let t = 1_000;
    const c = new SessionCollector(params(), { id: "s1", now: () => t });
    c.noteTurnStart();
    t = 1_200;
    c.noteTurnContext(
      [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: [{ type: "toolCall", name: "click", arguments: { target: "@e1" } }],
        },
      ],
      999,
    );
    t = 1_600;
    c.noteTurnEnd({ input: 10, output: 2 });

    const a = c.data;
    assert.equal(a.turns.length, 1);
    assert.equal(a.turns[0].index, 1);
    assert.equal(a.turns[0].durationMs, 600);
    assert.deepEqual(a.turns[0].usage, { input: 10, output: 2 });
    // 裁剪前的字符数单独记下来：它是「这一轮上下文被裁掉了多少」的证据。
    assert.equal(a.turns[0].contextCharsBefore, 999);
    assert.equal(a.turns[0].context.length, 2);
  });

  test("上下文先到、turn_start 后到时不丢已采集的消息", () => {
    let t = 0;
    const c = new SessionCollector(params(), { id: "s2", now: () => t });
    c.noteTurnContext([{ role: "user", content: "只有上下文" }]);
    t = 50;
    c.noteTurnStart();
    t = 100;
    c.noteTurnEnd();
    assert.equal(c.data.turns[0].context.length, 1);
    assert.equal(c.data.turns[0].context[0].text, "只有上下文");
  });

  test("多轮依次编号", () => {
    let t = 0;
    const c = new SessionCollector(params(), { id: "s3", now: () => t });
    c.noteTurnStart();
    t = 10;
    c.noteTurnEnd();
    c.noteTurnStart();
    t = 30;
    c.noteTurnEnd();
    assert.deepEqual(
      c.data.turns.map((x) => [x.index, x.durationMs]),
      [
        [1, 10],
        [2, 20],
      ],
    );
  });

  test("工具调用按 id 配对耗时与成败；配不上的 end 直接忽略", () => {
    let t = 0;
    const c = new SessionCollector(params(), { id: "s4", now: () => t });
    c.noteToolStart("call-1", "click", { target: "@e1" });
    t = 250;
    c.noteToolEnd("call-1", true, "已点击 @e1");
    c.noteToolStart("call-2", "assert_text", { expectation: "标题" });
    t = 300;
    c.noteToolEnd("call-2", false, "元素未找到");
    // 没有对应的 start：不该凭空多出一条记录。
    c.noteToolEnd("ghost", true, "x");

    const calls = c.data.toolCalls;
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0], {
      index: 1,
      toolCallId: "call-1",
      name: "click",
      args: { target: "@e1" },
      ok: true,
      result: "已点击 @e1",
      resultChars: 7,
      startedAt: 0,
      durationMs: 250,
    });
    assert.equal(calls[1].ok, false);
    assert.equal(calls[1].result, "元素未找到");
  });

  test("超长工具结果按上限截断，并标出原始长度", () => {
    const c = new SessionCollector(params(), { id: "s5", maxText: 10 });
    c.noteToolStart("c", "snapshot", {});
    c.noteToolEnd("c", true, "0123456789abc");
    const call = c.data.toolCalls[0];
    assert.equal(call.result, "0123456789");
    assert.equal(call.resultChars, 13);
    assert.equal(call.resultTruncated, true);
  });

  test("finish 写入终态、归因与总用量", () => {
    let t = 0;
    const c = new SessionCollector(params(), { id: "s6", now: () => t });
    t = 5_000;
    const a = c.finish({
      status: "fail",
      note: "模型报错",
      usage: {
        input: 1,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0,
        total: 3,
        calls: 1,
      },
    });
    assert.equal(a.status, "fail");
    assert.equal(a.note, "模型报错");
    assert.equal(a.usage.total, 3);
    assert.equal(a.endedAt, new Date(5_000).toISOString());
    assert.equal(a.format, "pageqa-session");
  });
});

describe("存档落盘与读取（SQLite 单容器）", () => {
  test("writeArchive 往返：参数、轮次、工具调用与摘要都能读回", async () => {
    const dir = tempDir();
    try {
      const c = new SessionCollector(params(), { id: "20260101-000000-abcd" });
      c.noteTurnStart();
      c.noteTurnContext([{ role: "user", content: "hi" }], 42);
      c.noteTurnEnd({ input: 1 });
      c.noteToolStart("t1", "click", { target: "@e1" });
      c.noteToolEnd("t1", true, "已点击 @e1");
      const file = await writeArchive(c.finish({ status: "pass" }), dir);
      assert.equal(file, databasePath(dir));
      assert.ok(existsSync(file), "容器文件应已创建");

      const back = await readArchive("20260101-000000-abcd", dir);
      assert.equal(back.format, "pageqa-session");
      assert.equal(back.params.systemPrompt, "sys");
      assert.equal(back.params.tools.length, 1);
      assert.equal(back.turns.length, 1);
      assert.equal(back.turns[0].context[0].text, "hi");
      assert.equal(back.turns[0].contextCharsBefore, 42);
      assert.equal(back.toolCalls.length, 1);
      assert.equal(back.toolCalls[0].args.target, "@e1");
      assert.equal(back.toolCalls[0].result, "已点击 @e1");
      assert.equal(back.status, "pass");

      const list = await listArchives(dir);
      assert.equal(list.length, 1);
      assert.equal(list[0].id, "20260101-000000-abcd");
      assert.equal(list[0].model, "pageqa/m1");
      assert.equal(list[0].turns, 1);
      assert.equal(list[0].steps, 2);
      assert.equal(list[0].called, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("写完即关、随用随开：另一次打开也能读到（句柄没有漏出去）", async () => {
    const dir = tempDir();
    try {
      const c = new SessionCollector(params(), { id: "reopen-me", now: () => 1 });
      c.noteTurnStart();
      c.noteTurnEnd({ input: 5 });
      await writeArchive(c.finish({ status: "cancelled", note: "用户中止" }), dir);
      // 每次读写都各自开/关一次仓库：句柄没关的话第二次就会失败。
      const first = await readArchive("reopen-me", dir);
      const second = await readArchive("reopen-me", dir);
      assert.equal(first.status, "cancelled");
      assert.equal(second.note, "用户中止");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("所有运行共用一个容器文件", async () => {
    const dir = tempDir();
    try {
      for (const id of ["a", "b"]) {
        await writeArchive(
          new SessionCollector(params(), { id, now: () => 1 }).finish({ status: "pass" }),
          dir,
        );
      }
      // 忽略 SQLite 的 -wal/-shm 边车文件：它们随连接的出现与关闭而生灭。
      const names = readdirSync(dir)
        .filter((n) => !n.endsWith("-wal") && !n.endsWith("-shm"))
        .sort();
      assert.deepEqual(names, [SESSIONS_DATABASE]);
      assert.deepEqual(
        (await listArchives(dir)).map((s) => s.id).sort(),
        ["a", "b"],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("列表按开始时间倒序（同一时刻按 id 兜底）", async () => {
    const dir = tempDir();
    try {
      const mk = (id, at) =>
        new SessionCollector(params(), { id, now: () => at }).finish({ status: "pass" });
      await writeArchive(mk("old", 1_000), dir);
      await writeArchive(mk("new", 2_000), dir);
      assert.deepEqual(
        (await listArchives(dir)).map((s) => s.id),
        ["new", "old"],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("pruneArchives 只留最近 N 条，并返回删掉的条数", async () => {
    const dir = tempDir();
    try {
      for (let i = 1; i <= 3; i++) {
        await writeArchive(
          new SessionCollector(params(), { id: `s-${i}`, now: () => i * 1_000 }).finish({
            status: "pass",
          }),
          dir,
        );
      }
      assert.equal(await pruneArchives(dir, 2), 1);
      assert.deepEqual(
        (await listArchives(dir)).map((s) => s.id),
        ["s-3", "s-2"],
      );
      // 被清理的档案是**真的没了**（详情也读不回来），而不是只从列表里隐藏。
      await assert.rejects(() => readArchive("s-1", dir), /找不到运行存档/);
      // 没到上限时一条都不删。
      assert.equal(await pruneArchives(dir, 5), 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("目录不存在时列表为空、清理返回 0，且不在磁盘上留下容器", async () => {
    // 用一个必然不存在的子目录：父目录存在不算数——「看一眼列表」不该建出数据库文件。
    const parent = tempDir();
    const dir = join(parent, "not-yet");
    try {
      assert.deepEqual(await listArchives(dir), []);
      assert.equal(await pruneArchives(dir, 5), 0);
      assert.equal(existsSync(dir), false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("不是 pageqa 写的存档文档会被列表跳过、也读不出来（同一容器里的其它写入者）", async () => {
    const dir = tempDir();
    try {
      // 直接用 durable 写一份「别人的」存档文档：同样的 kind，但不是 pageqa 的形状，
      // 也没进 pageqa.index。列表不该把它算成一次运行，详情也不该把形状对不上的东西返回。
      const ForeignDoc = defineDocFamily({
        kind: "pageqa.archive",
        version: 1,
        family: true,
        scope: "session",
        initial: (seed) => seed,
      });
      const storage = await openNodeSqliteStorage(databasePath(dir));
      const session = createSession(storage);
      try {
        await session.commit(
          async (tx) => {
            await tx.doc(ForeignDoc, "foreign", { format: "someone-else" });
          },
          BACKGROUND_CONTEXT,
        );
      } finally {
        await session.close(BACKGROUND_CONTEXT);
      }

      await writeArchive(
        new SessionCollector(params(), { id: "ours", now: () => 1 }).finish({ status: "pass" }),
        dir,
      );
      assert.deepEqual(
        (await listArchives(dir)).map((s) => s.id),
        ["ours"],
      );
      await assert.rejects(() => readArchive("foreign", dir), /找不到运行存档/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("未知 id 一律抛错（不会凭空造一条出来）", async () => {
    const dir = tempDir();
    try {
      await assert.rejects(
        () => readArchive("does-not-exist", dir),
        /找不到运行存档/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("id 不放行目录穿越（它是 Session id，也是 URL 的一部分）", async () => {
    assert.throws(() => assertSafeId("../etc/passwd"));
    assert.throws(() => assertSafeId("a/b"));
    assert.throws(() => assertSafeId(".."));
    assert.equal(assertSafeId("20260101-000000-abcd"), "20260101-000000-abcd");
    // 非法 id 连仓库都不该去开。
    await assert.rejects(() => readArchive("../etc/passwd"), /非法的 session id/);
  });
});
