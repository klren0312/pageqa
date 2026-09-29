import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getLocale, setLocale } from "../dist/i18n.js";
import {
  SessionCollector,
  summarizeArchive,
  writeArchive,
} from "../dist/session-archive.js";
import {
  renderDetailPage,
  renderIndexPage,
  runSessionServer,
} from "../dist/session-server.js";

// 渲染是纯函数；HTTP 用真实监听 + fetch 跑一遍（不碰浏览器与模型）。

const params = (over = {}) => ({
  systemPrompt: "你是页面测试 agent",
  model: { provider: "pageqa", id: "hunyuan" },
  tools: [
    {
      name: "click",
      label: "Click",
      description: "点击元素",
      parameters: { type: "object", properties: { target: { type: "string" } } },
    },
  ],
  prompt: "### 步骤 1：打开页面",
  caseText: "打开页面并断言标题",
  steps: ["打开页面并断言标题"],
  vars: [{ name: "timestamp", placeholder: "${timestamp}", value: "202609291200" }],
  debug: false,
  scenarioName: "冒烟",
  bskSession: "abc123",
  ...over,
});

function sampleArchive(id = "20260929-120000-abcd") {
  const c = new SessionCollector(params(), { id });
  c.noteTurnStart();
  c.noteTurnContext([{ role: "user", content: "打开页面并断言标题" }], 120);
  c.noteTurnEnd({ input: 10, output: 3 });
  c.noteToolStart("call-1", "click", { target: "@e1" });
  c.noteToolEnd("call-1", true, "已点击 @e1");
  return c.finish({
    status: "pass",
    usage: {
      input: 10,
      output: 3,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      total: 13,
      calls: 1,
    },
  });
}

describe("列表页与详情页渲染", () => {
  test("空列表给出「还没有记录」而不是一张空表", () => {
    const html = renderIndexPage([]);
    assert.match(html, /还没有运行记录/);
    assert.doesNotMatch(html, /<table/);
  });

  test("列表页列出条目并链接到详情", () => {
    const html = renderIndexPage([summarizeArchive(sampleArchive())]);
    assert.match(html, /20260929-120000-abcd/);
    assert.match(html, /pageqa\/hunyuan/);
    assert.match(html, /冒烟/);
    assert.match(html, /PASS/);
  });

  test("详情页包含「传给 agent 的参数」、工具 schema 与轮次/工具调用", () => {
    const html = renderDetailPage(sampleArchive());
    assert.match(html, /传给 agent 的参数/);
    assert.match(html, /你是页面测试 agent/);
    // 工具的 parameters schema 原样给出（JSON 里的引号在 HTML 里被转义）。
    assert.match(html, /&quot;target&quot;/);
    assert.match(html, /LLM 轮次/);
    assert.match(html, /工具调用/);
    assert.match(html, /@e1/);
    assert.match(html, /abc123/);
  });

  test("用例与页面内容里的 HTML 一律转义（存档内容来自被测页面，不能打破结构）", () => {
    const archive = sampleArchive();
    archive.params.caseText = "<script>alert(1)</script>";
    archive.params.scenarioName = '"><img src=x onerror=1>';
    const html = renderDetailPage(archive);
    assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.doesNotMatch(html, /onerror=1>/);
  });

  test("被截断的文本标注原始长度", () => {
    const archive = sampleArchive();
    archive.toolCalls[0].result = "0123456789";
    archive.toolCalls[0].resultChars = 13;
    archive.toolCalls[0].resultTruncated = true;
    assert.match(renderDetailPage(archive), /已截断，原始 13 字符/);
  });
});

/** 起一个服务并等它就绪；返回实际端口与「关闭它」用的 Promise。 */
async function startServer(dir, port) {
  let readyResolve;
  const ready = new Promise((r) => (readyResolve = r));
  const done = runSessionServer({ port, dir, open: false, onReady: readyResolve });
  const info = await Promise.race([
    ready,
    done.then((code) => {
      throw new Error(`服务未能启动（退出码 ${code}）`);
    }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("服务未在 5s 内就绪")), 5_000),
    ),
  ]);
  // 等 runSessionServer 走到注册 SIGINT 监听那一步，否则 finally 里关不掉它。
  await new Promise((r) => setImmediate(r));
  return { info, done };
}

describe("session 查询服务（HTTP）", () => {
  test("列表 / 详情 / 404 与目录穿越都被正确处理", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pageqa-sessions-http-"));
    const archive = sampleArchive();
    await writeArchive(archive, dir);
    const previous = getLocale();
    setLocale("zh");
    const port = 20_000 + Math.floor(Math.random() * 20_000);
    const { info, done } = await startServer(dir, port);
    try {
      const list = await fetch(`${info.url}api/sessions`);
      assert.equal(list.status, 200);
      const body = await list.json();
      assert.equal(body.length, 1);
      assert.equal(body[0].id, archive.id);

      const detail = await fetch(`${info.url}api/sessions/${archive.id}`);
      assert.equal(detail.status, 200);
      assert.equal((await detail.json()).params.systemPrompt, "你是页面测试 agent");

      const page = await fetch(`${info.url}s/${archive.id}`);
      assert.equal(page.status, 200);
      assert.match(await page.text(), /传给 agent 的参数/);

      const index = await fetch(info.url);
      assert.equal(index.status, 200);
      assert.match(await index.text(), /pageqa 运行存档/);

      assert.equal((await fetch(`${info.url}s/no-such-run`)).status, 404);
      assert.equal((await fetch(`${info.url}api/sessions/no-such-run`)).status, 404);
      // URL 编码过的目录穿越必须撞在 id 校验上（否则查询服务会变成任意文件读取）。
      assert.equal(
        (await fetch(`${info.url}api/sessions/..%2F..%2Fetc%2Fpasswd`)).status,
        404,
      );
      assert.equal((await fetch(`${info.url}nope`)).status, 404);
    } finally {
      process.emit("SIGINT");
      await done;
      setLocale(previous);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("端口被占用时向上顺延，并把实际端口告诉调用方", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pageqa-sessions-port-"));
    const port = 20_000 + Math.floor(Math.random() * 20_000);
    const first = await startServer(dir, port);
    let second;
    try {
      // 同一个端口再起一个：必须顺延，而不是报错退出（用户不该因为端口撞车而用不了）。
      second = await startServer(dir, port);
      assert.equal(first.info.port, port);
      assert.ok(second.info.port > port, `应顺延到更大端口，实际 ${second.info.port}`);
    } finally {
      // 一次 SIGINT 会同时触发两个服务各自的 shutdown。
      process.emit("SIGINT");
      await Promise.all([first.done, second?.done]);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
