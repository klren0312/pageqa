/**
 * 剪贴板写入的纯函数单测。
 *
 * 这里只测「通道选择与返回语义」：真实终端里没有 TTY 也没有鼠标（`tests/tui` 的既有约定），
 * 所以拖动→选区→复制这条链路的真机验证靠手工清单；能被断言的只有本模块自己。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createClipboardCopy, osc52Sequence } from "../../dist/tui/clipboard.js";

/** 记一笔「写了什么」，用来断言通道是否被用到。 */
function recorder() {
  const writes = [];
  return {
    writes,
    write: (data) => {
      writes.push(data);
    },
  };
}

const failureText = "no clipboard";

describe("osc52Sequence", () => {
  test("把 UTF-8 内容转成系统剪贴板的 OSC 52 序列", () => {
    const seq = osc52Sequence("场景一\nassert ok");
    assert.ok(seq.startsWith("\x1b]52;c;"));
    assert.ok(seq.endsWith("\x07"));
    const payload = seq.slice("\x1b]52;c;".length, -1);
    assert.equal(Buffer.from(payload, "base64").toString("utf8"), "场景一\nassert ok");
  });
});

describe("createClipboardCopy", () => {
  test("原生通道成功：返回 true，且不再写 OSC 52", async () => {
    const seen = [];
    const writer = recorder();
    let fallbacks = 0;
    const copy = createClipboardCopy({
      setText: async (text) => {
        seen.push(text);
      },
      write: writer.write,
      onFallback: () => {
        fallbacks += 1;
      },
      failureMessage: () => failureText,
    });

    assert.equal(await copy("hello"), true);
    assert.deepEqual(seen, ["hello"]);
    assert.deepEqual(writer.writes, []);
    assert.equal(fallbacks, 0);
  });

  test("原生通道抛错：回退 OSC 52、回调一次、仍报成功", async () => {
    const writer = recorder();
    let fallbacks = 0;
    const copy = createClipboardCopy({
      setText: async () => {
        throw new Error("clipboard busy");
      },
      write: writer.write,
      onFallback: () => {
        fallbacks += 1;
      },
      failureMessage: () => failureText,
    });

    assert.equal(await copy("hello"), true);
    assert.deepEqual(writer.writes, [osc52Sequence("hello")]);
    assert.equal(fallbacks, 1);
  });

  test("平台没有原生实现（setText 缺失）：直接走 OSC 52", async () => {
    const writer = recorder();
    let fallbacks = 0;
    const copy = createClipboardCopy({
      write: writer.write,
      onFallback: () => {
        fallbacks += 1;
      },
      failureMessage: () => failureText,
    });

    assert.equal(await copy("hello"), true);
    assert.equal(writer.writes.length, 1);
    assert.equal(fallbacks, 1);
  });

  test("两条通道都失守：返回失败文案，不抛异常", async () => {
    const copy = createClipboardCopy({
      setText: async () => {
        throw new Error("no native");
      },
      write: () => {
        throw new Error("terminal gone");
      },
      failureMessage: () => failureText,
    });

    assert.equal(await copy("hello"), failureText);
  });

  test("空文本：返回失败文案，且不碰任何通道", async () => {
    const writer = recorder();
    let fallbacks = 0;
    const copy = createClipboardCopy({
      setText: async () => {},
      write: writer.write,
      onFallback: () => {
        fallbacks += 1;
      },
      failureMessage: () => failureText,
    });

    assert.equal(await copy(""), failureText);
    assert.deepEqual(writer.writes, []);
    assert.equal(fallbacks, 0);
  });
});