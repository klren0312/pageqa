import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import vm from "node:vm";
import { getLocale, setLocale } from "../dist/shared/i18n.js";
import {
  SessionCollector,
  summarizeArchive,
  writeArchive,
} from "../dist/session/archive.js";
import {
  renderDetailPage,
  renderIndexPage,
  runSessionServer,
} from "../dist/session/server.js";

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

  // 「我的小模型为什么没被当小模型对待」这类问题，只有把**依据**摆在页面上才答得出来：
  // systemPrompt/tools 只显示结果（压缩版还是完整版），看不出窗口从哪来、为什么没压。
  test("详情页给出上下文决策：窗口、来源、预算与固定前缀是否压缩", () => {
    const html = renderDetailPage(
      sampleArchive("20261014-105627-9fef"),
    );
    assert.doesNotMatch(html, /窗口 131072/, "旧记录没有这段，不该凭空出现");

    const withContext = sampleArchive("20261014-110000-aaaa");
    withContext.params.context = {
      window: 131072,
      windowSource: "engine",
      inputBudget: 112395,
      outputReserve: 8192,
      compact: true,
      compactReason: "model",
    };
    const out = renderDetailPage(withContext);
    assert.match(out, /窗口 131072（引擎自报）/);
    assert.match(out, /输入预算 112395/);
    assert.match(out, /固定前缀 已压缩（模型名像小模型）/);
  });

  test("被截断的文本标注原始长度", () => {
    const archive = sampleArchive();
    archive.toolCalls[0].result = "0123456789";
    archive.toolCalls[0].resultChars = 13;
    archive.toolCalls[0].resultTruncated = true;
    assert.match(renderDetailPage(archive), /已截断，原始 13 字符/);
  });

  // 存档是排查工具，删掉一条不该只能去磁盘上删文件——列表页每行都要能删，还要能一次清空。
  test("列表页给出逐条删除按钮与清空全部按钮", () => {
    const html = renderIndexPage([summarizeArchive(sampleArchive())]);
    // 按钮里的 id 是行内脚本的**参数**：单引号字面量经属性转义后是 `&#39;`，浏览器解码回来能对上。
    assert.match(html, /pageqaRemove\(&#39;20260929-120000-abcd&#39;\)/);
    // 按钮在可点的整行里，必须先 stopPropagation，否则「删」会变成「进详情」。
    assert.match(html, /onclick="event\.stopPropagation\(\);pageqaRemove/);
    assert.match(html, /pageqaClearAll\(1\)/);
    assert.match(html, /共 1 条/);
    // 整行导航的 onclick 也要是完整的一条表达式（转义坏了这行脚本就没法执行）。
    assert.match(
      html,
      /<tr onclick="location\.href=&#39;\/s\/20260929-120000-abcd&#39;">/,
    );
  });

  test("列表为空时不给出「清空全部」（没有东西可清就不该有个按钮在那儿）", () => {
    const html = renderIndexPage([]);
    assert.doesNotMatch(html, /pageqaClearAll/);
  });

  test("详情页给出删除按钮，删除后回列表", () => {
    const html = renderDetailPage(sampleArchive());
    assert.match(html, /pageqaRemove\(&#39;20260929-120000-abcd&#39;\)/);
    assert.match(html, /删除这条/);
  });

  test("确认提示里的文案来自 i18n，不会漏到用户面前", () => {
    const html = renderIndexPage([summarizeArchive(sampleArchive())]);
    assert.match(html, /确定删除这条运行记录/);
    assert.match(html, /确定清空全部 \{n\} 条运行记录/);
  });

  // 转义这一层很容易悄悄坏掉：转义坏了页面不会报错，只是按钮点了没反应。
  // 所以这里把生成的脚本与 onclick 表达式都真编译一遍。
  test("行内脚本与 onclick 表达式都是合法 JS", () => {
    for (const html of [
      renderIndexPage([summarizeArchive(sampleArchive())]),
      renderDetailPage(sampleArchive()),
    ]) {
      const script = html.slice(html.indexOf("<script>") + 8, html.lastIndexOf("</script>"));
      assert.doesNotThrow(() => new vm.Script(script), `脚本编译失败：\n${script}`);
      for (const [, attr] of html.matchAll(/onclick="([^"]*)"/g)) {
        // 属性里的 HTML 实体先解码回浏览器看到的那串字符，再当作语句列表编译
        //（删除按钮那条是两句：先 stopPropagation 再删）。
        const code = attr
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&amp;/g, "&");
        assert.doesNotThrow(() => new vm.Script(code), `onclick 编译失败：${code}`);
      }
    }
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

  test("旧格式容器不会让服务起不来：列表按空返回，详情 404", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pageqa-sessions-legacy-"));
    // 早期版本留下的同名容器（表结构不同、没有 durable_schema）：起服务时那次「列表是否为空」
    // 的探读此前会撞在迁移上，整个 runSessionServer 直接失败退出。
    const legacy = new DatabaseSync(join(dir, "sessions.sqlite"));
    try {
      legacy.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, storage_version INTEGER)");
      legacy.exec("CREATE TABLE entries (session_id TEXT, id INTEGER)");
    } finally {
      legacy.close();
    }

    const port = 20_000 + Math.floor(Math.random() * 20_000);
    const { info, done } = await startServer(dir, port);
    try {
      const list = await fetch(`${info.url}api/sessions`);
      assert.equal(list.status, 200);
      assert.deepEqual(await list.json(), []);
      assert.equal((await fetch(`${info.url}s/old-run`)).status, 404);
    } finally {
      process.emit("SIGINT");
      await done;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("DELETE 单条：删掉后列表与详情同时消失，其余记录不受影响", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pageqa-sessions-del-"));
    const keep = sampleArchive("20260929-100000-keep");
    const drop = sampleArchive("20260929-120000-drop");
    await writeArchive(keep, dir);
    await writeArchive(drop, dir);
    const port = 20_000 + Math.floor(Math.random() * 20_000);
    const { info, done } = await startServer(dir, port);
    try {
      const res = await fetch(`${info.url}api/sessions/${drop.id}`, { method: "DELETE" });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { deleted: true });

      const list = await (await fetch(`${info.url}api/sessions`)).json();
      assert.deepEqual(
        list.map((s) => s.id),
        [keep.id],
      );
      assert.equal((await fetch(`${info.url}api/sessions/${drop.id}`)).status, 404);
      // 删掉一条不该顺手带走别的：留下的那条详情还在。
      assert.equal((await fetch(`${info.url}api/sessions/${keep.id}`)).status, 200);

      // 再删一次如实答「没有这条」，而不是假装成功。
      const again = await fetch(`${info.url}api/sessions/${drop.id}`, { method: "DELETE" });
      assert.equal(again.status, 404);
      assert.deepEqual(await again.json(), { deleted: false });

      // 非法 id 是请求本身的问题（400），且绝不碰磁盘上的容器。
      const bad = await fetch(`${info.url}api/sessions/..%2F..%2Fetc%2Fpasswd`, {
        method: "DELETE",
      });
      assert.equal(bad.status, 400);
      assert.deepEqual((await (await fetch(`${info.url}api/sessions`)).json()).map((s) => s.id), [
        keep.id,
      ]);
    } finally {
      process.emit("SIGINT");
      await done;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("DELETE 全部：清空后列表为空，详情也读不回来", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pageqa-sessions-clear-"));
    for (const id of ["run-a", "run-b", "run-c"]) {
      await writeArchive(sampleArchive(id), dir);
    }
    const port = 20_000 + Math.floor(Math.random() * 20_000);
    const { info, done } = await startServer(dir, port);
    try {
      const res = await fetch(`${info.url}api/sessions`, { method: "DELETE" });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { deleted: 3 });
      assert.deepEqual(await (await fetch(`${info.url}api/sessions`)).json(), []);
      assert.equal((await fetch(`${info.url}api/sessions/run-a`)).status, 404);
      // 页面刷新后回到「还没有运行记录」，而不是一张还列着旧记录的表。
      assert.match(await (await fetch(info.url)).text(), /还没有运行记录/);
      // 已经空了再清一次是 0，不报错。
      const again = await fetch(`${info.url}api/sessions`, { method: "DELETE" });
      assert.equal(again.status, 200);
      assert.deepEqual(await again.json(), { deleted: 0 });
    } finally {
      process.emit("SIGINT");
      await done;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("旧格式容器上的删除与清空如实报错，不静默说成功", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pageqa-sessions-legacy-del-"));
    const legacy = new DatabaseSync(join(dir, "sessions.sqlite"));
    try {
      legacy.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, storage_version INTEGER)");
      legacy.exec("CREATE TABLE entries (session_id TEXT, id INTEGER)");
    } finally {
      legacy.close();
    }
    const port = 20_000 + Math.floor(Math.random() * 20_000);
    const { info, done } = await startServer(dir, port);
    try {
      const one = await fetch(`${info.url}api/sessions/any-run`, { method: "DELETE" });
      assert.equal(one.status, 500);
      assert.match((await one.json()).error, /不是 pageqa 当前格式/);
      const all = await fetch(`${info.url}api/sessions`, { method: "DELETE" });
      assert.equal(all.status, 500);
      assert.match((await all.json()).error, /不是 pageqa 当前格式/);
    } finally {
      process.emit("SIGINT");
      await done;
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
