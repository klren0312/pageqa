import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  createPageReader,
  isMissingReadCommand,
  isUnsupportedReadFeature,
  isUnsupportedReadFlag,
  parseReadOutput,
  READ_DEFAULT_MAX_CHARS,
  READ_MAX_CHARS_LIMIT,
  readAssertCorpusEnabled,
  renderRead,
} from "../../dist/bsk/read.js";
import { createBskTools } from "../../dist/bsk/tools.js";

// `bsk read` 是可选能力：解析、降级、能力探测三处都必须能单测，
// 因为本机（以及 CI）通常没有 0.5.0 的 bsk，真机路径跑不到。

// 真形态来自 BrowserSkill `crates/bsk-protocol/src/tools/read.rs:74-85` 的 ReadResult：
// 顶层没有 text/url，正文在 items[].values 里。
describe("parseReadOutput：真实 ReadResult（bsk 0.5.0）", () => {
  test("默认 fields：文本在 items[0].values.text，标题/URL 在顶层", () => {
    const r = parseReadOutput(
      JSON.stringify({
        tab_id: 1,
        page_url: "https://example.com/orders",
        frame_url: "https://example.com/orders",
        frame_id: 0,
        title: "订单列表",
        captured_at: "2026-11-10T10:00:00Z",
        scope: "root",
        items: [
          { ref: "@e1", values: { text: "共 12 条\n订单编号 20261110" }, redacted: [] },
        ],
        truncated: false,
      }),
    );
    assert.equal(r.text, "共 12 条\n订单编号 20261110");
    assert.equal(r.title, "订单列表");
    assert.equal(r.url, "https://example.com/orders");
    assert.match(r.details, /scope=root/);
    assert.equal(r.truncated, undefined);
  });

  test("多个 items / 自定义 fields：字符串进语料，布尔数值只进 details，脱敏键跳过", () => {
    const r = parseReadOutput(
      JSON.stringify({
        title: "表单",
        page_url: "https://example.com/form",
        scope: "selector:input",
        truncated: true,
        items: [
          { ref: "@e1", values: { v: "张三", ok: true, n: 3 }, redacted: [] },
          { ref: "@e2", values: { v: "李四", secret: "[REDACTED]" }, redacted: ["secret"] },
        ],
      }),
    );
    assert.equal(r.text, "张三\n李四");
    assert.match(r.details, /ok=true/);
    assert.match(r.details, /n=3/);
    assert.match(r.details, /truncated=true/);
    assert.match(r.details, /redacted=secret/);
    assert.equal(r.truncated, true);
    assert.ok(!r.details.includes("[REDACTED]"));
  });

  test("items 为空但有标题：返回对象（text 为空，不进断言语料）", () => {
    const r = parseReadOutput(
      JSON.stringify({ title: "Example Domain", page_url: "https://example.com", items: [] }),
    );
    assert.equal(r.text, "");
    assert.equal(r.title, "Example Domain");
  });
});

describe("parseReadOutput：JSON 信封（兼容其它版本）", () => {
  test("取明确的文本 / 标题 / 地址 / 结构化字段", () => {
    const r = parseReadOutput(
      JSON.stringify({
        title: "订单列表",
        url: "https://example.com/orders",
        text: "共 12 条\n订单编号 20261110",
        attributes: { "data-status": "paid" },
      }),
    );
    assert.equal(r.text, "共 12 条\n订单编号 20261110");
    assert.equal(r.title, "订单列表");
    assert.equal(r.url, "https://example.com/orders");
    assert.match(r.details, /paid/);
  });

  test("套一层 data 信封也认得", () => {
    const r = parseReadOutput(JSON.stringify({ ok: true, data: { text: "保存成功" } }));
    assert.equal(r.text, "保存成功");
  });

  test("多层信封（result.data.text）也认得", () => {
    const r = parseReadOutput(JSON.stringify({ result: { data: { text: "提交成功" } } }));
    assert.equal(r.text, "提交成功");
  });

  test("字段名不认识的 JSON 返回 null：绝不把键名当页面文本", () => {
    // 断言 "text" 这类词如果命中 JSON 键名就是一条假通过，宁可整次降级。
    assert.equal(parseReadOutput('{"whatever":"页面内容"}'), null);
    assert.equal(parseReadOutput("{}"), null);
  });

  test("只有标题/地址、没有正文时也返回对象（工具可展示，但不进断言语料）", () => {
    const r = parseReadOutput('{"title":"Example Domain","url":"https://example.com"}');
    assert.equal(r.text, "");
    assert.equal(r.title, "Example Domain");
  });
});

describe("parseReadOutput：human 输出与空值", () => {
  test("非 JSON 的整段输出就是可见文本", () => {
    const out = "标题：Example Domain\n地址：https://example.com\n\nExample Domain\nThis domain is for use in documentation examples.";
    assert.equal(parseReadOutput(out).text, out);
  });

  test("正文里带 JSON 片段不会被误解析成信封", () => {
    const out = '页面显示配置：{"foo":1}，以及一段正常的说明文字。';
    assert.equal(parseReadOutput(out).text, out);
  });

  test("JSON 数组输出返回 null，不把键名当语料", () => {
    assert.equal(parseReadOutput('[{"text":"x"}]'), null);
  });

  test("空输出返回 null", () => {
    assert.equal(parseReadOutput(""), null);
    assert.equal(parseReadOutput("   \n  "), null);
  });
});

describe("renderRead：给模型看的展示", () => {
  test("四块内容都带标签", () => {
    const text = renderRead({
      title: "订单",
      url: "https://example.com",
      text: "共 12 条",
      details: '[{"name":"status","value":"paid"}]',
    });
    assert.match(text, /标题：订单/);
    assert.match(text, /地址：https:\/\/example.com/);
    assert.match(text, /【页面文本】/);
    assert.match(text, /【读取元信息 \/ 结构化字段】/);
  });

  test("超长文本按 maxChars 截断并说明总量", () => {
    const text = renderRead({ text: "页".repeat(5000) }, 512);
    assert.ok(text.length < 600);
    assert.match(text, /已截断，共 \d+ 字符/);
  });

  test("maxChars 超上限会被钳住，非法值回落到默认", () => {
    const long = { text: "x".repeat(READ_MAX_CHARS_LIMIT + 1000) };
    assert.ok(renderRead(long, 10 ** 9).length <= READ_MAX_CHARS_LIMIT + 100);
    assert.ok(renderRead(long, Number.NaN).length <= READ_DEFAULT_MAX_CHARS + 100);
  });
});

describe("能力探测的错误识别", () => {
  test("旧版 bsk：命令不存在", () => {
    assert.equal(isMissingReadCommand({ stderr: "error: unrecognized subcommand 'read'" }), true);
    assert.equal(isMissingReadCommand({ bskCode: "unknown_method" }), true);
    assert.equal(isMissingReadCommand({ message: "unknown command: read" }), true);
  });

  test("--json 不被接受：只认参数错，不认页面故障", () => {
    assert.equal(isUnsupportedReadFlag({ stderr: "unexpected argument '--json' found" }), true);
    assert.equal(isUnsupportedReadFlag(new Error("CDP disconnected")), false);
    assert.equal(isMissingReadCommand(new Error("CDP disconnected")), false);
  });

  test("老 daemon：unsupported_feature / required_protocol / 文案都认得", () => {
    assert.equal(
      isUnsupportedReadFeature({
        stdout: '{"code":"unsupported","data":{"reason":"unsupported_feature","required_protocol":"1.9"}}',
      }),
      true,
    );
    assert.equal(isUnsupportedReadFeature(new Error("read requires daemon protocol 1.9")), true);
    assert.equal(isUnsupportedReadFeature(new Error("CDP disconnected")), false);
  });
});

test("PAGEQA_BSK_READ_ASSERT 只关断言语料合并", () => {
  const prev = process.env.PAGEQA_BSK_READ_ASSERT;
  try {
    delete process.env.PAGEQA_BSK_READ_ASSERT;
    assert.equal(readAssertCorpusEnabled(), true);
    process.env.PAGEQA_BSK_READ_ASSERT = "0";
    assert.equal(readAssertCorpusEnabled(), false);
    process.env.PAGEQA_BSK_READ_ASSERT = "OFF";
    assert.equal(readAssertCorpusEnabled(), false);
  } finally {
    if (prev === undefined) delete process.env.PAGEQA_BSK_READ_ASSERT;
    else process.env.PAGEQA_BSK_READ_ASSERT = prev;
  }
});

describe("createPageReader：降级路径", () => {
  const reader = (responses, opts = {}) => {
    const calls = [];
    const run = async (args) => {
      calls.push(args);
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return next;
    };
    return { calls, pageReader: createPageReader({ session: "s1", run, ...opts }) };
  };

  test("正常：只发 --session 与 --json，结果按 JSON 解析", async () => {
    const { calls, pageReader } = reader([JSON.stringify({ text: "保存成功" })]);
    const r = await pageReader.read();
    assert.equal(r.text, "保存成功");
    assert.deepEqual(calls[0], ["read", "--session", "s1", "--json"]);
  });

  test("read 工具透传 --selector / --fields-json / 三个预算参数", async () => {
    const { calls, pageReader } = reader([
      JSON.stringify({ items: [{ values: { v: "张三" } }] }),
    ]);
    const r = await pageReader.read(undefined, {
      selector: "input[name=user]",
      fieldsJson: '[{"key":"v","read":"value"}]',
      maxNodes: 10,
      maxBytes: 2048,
      timeoutMs: 500,
    });
    assert.equal(r.text, "张三");
    assert.deepEqual(calls[0], [
      "read", "--session", "s1",
      "--selector", "input[name=user]",
      "--fields-json", '[{"key":"v","read":"value"}]',
      "--max-nodes", "10",
      "--max-bytes", "2048",
      "--timeout-ms", "500",
      "--json",
    ]);
  });

  test("命令不存在：本次返回 null，之后不再重复试探", async () => {
    const { calls, pageReader } = reader([
      Object.assign(new Error("unrecognized subcommand 'read'"), {
        stderr: "unrecognized subcommand 'read'",
      }),
    ]);
    assert.equal(await pageReader.read(), null);
    assert.equal(await pageReader.read(), null);
    assert.equal(calls.length, 1);
  });

  test("daemon 协议 < 1.9：unsupported_feature 也永久关闭", async () => {
    const { calls, pageReader } = reader([
      Object.assign(new Error("read requires daemon protocol 1.9"), {
        stdout: '{"code":"unsupported","data":{"reason":"unsupported_feature","required_protocol":"1.9"}}',
      }),
    ]);
    assert.equal(await pageReader.read(), null);
    assert.equal(await pageReader.read(), null);
    assert.equal(calls.length, 1);
  });

  test("--json 不认：改发不带 flag 的命令；成功输出仍是 JSON", async () => {
    const { calls, pageReader } = reader([
      Object.assign(new Error("unexpected argument '--json'"), {
        stderr: "unexpected argument '--json' found",
      }),
      JSON.stringify({ items: [{ values: { text: "第一次读取的页面文本" } }] }),
      JSON.stringify({ items: [{ values: { text: "第二次读取的页面文本" } }] }),
    ]);
    assert.match((await pageReader.read()).text, /第一次读取/);
    assert.match((await pageReader.read()).text, /第二次读取/);
    assert.deepEqual(calls[0], ["read", "--session", "s1", "--json"]);
    assert.deepEqual(calls[1], ["read", "--session", "s1"]);
    assert.deepEqual(calls[2], ["read", "--session", "s1"]);
  });

  test("一次性失败（CDP 断开）不缓存，下次仍会重试", async () => {
    const { calls, pageReader } = reader([
      new Error("CDP disconnected"),
      JSON.stringify({ text: "恢复之后的页面文本" }),
    ]);
    assert.equal(await pageReader.read(), null);
    assert.equal((await pageReader.read()).text, "恢复之后的页面文本");
    assert.equal(calls.length, 2);
  });

  test("连续三次失败后冷却：第 4 次不再发命令", async () => {
    const { calls, pageReader } = reader([
      new Error("CDP disconnected"),
      new Error("CDP disconnected"),
      new Error("CDP disconnected"),
    ]);
    for (let i = 0; i < 3; i++) assert.equal(await pageReader.read(), null);
    assert.equal(await pageReader.read(), null);
    assert.equal(calls.length, 3);
  });

  test("输出形状不认识时返回 null，不抛错", async () => {
    const { pageReader } = reader(["{}"]);
    assert.equal(await pageReader.read(), null);
  });

  test("PAGEQA_BSK_READ 开关：关掉后一条命令都不发", async () => {
    const { calls, pageReader } = reader([], { enabled: () => false });
    assert.equal(await pageReader.read(), null);
    assert.equal(calls.length, 0);
  });

  test("用户中止（signal 已 aborted）必须原样抛出，不能被降级吞掉", async () => {
    const ac = new AbortController();
    const run = async () => {
      ac.abort();
      throw new Error("aborted by user");
    };
    const pageReader = createPageReader({ session: "s1", run });
    await assert.rejects(() => pageReader.read(ac.signal), /aborted by user/);
  });
});

test("read 工具已注册进 bsk 工具集，且没有必填参数", () => {
  const tool = createBskTools({ session: "test-session" }).find((x) => x.name === "read");
  assert.ok(tool, "read 工具应当存在");
  assert.equal(tool.executionMode, "sequential");
  assert.deepEqual(tool.parameters.required ?? [], []);
  for (const name of ["selector", "fieldsJson", "maxChars", "maxNodes", "maxBytes", "timeoutMs"]) {
    assert.ok(tool.parameters.properties[name], `read 应声明 ${name} 参数`);
  }
});
