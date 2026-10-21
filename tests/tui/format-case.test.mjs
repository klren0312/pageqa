import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  buildFormatPrompt,
  FORMAT_SYSTEM_PROMPT,
  parseFormattedCase,
} from "../../dist/tui/format-case.js";

// 纯单元测试：只覆盖提示词与模型输出的清洗，不发起任何模型请求。

describe("追加输入的模型格式化", () => {
  test("提示词包含用户原文，并覆盖 pageqa 的三条硬规则", () => {
    const prompt = buildFormatPrompt("打开 http://localhost:18888/a.html，断言标题包含 A");
    assert.match(prompt, /打开 http:\/\/localhost:18888\/a\.html/);
    assert.match(FORMAT_SYSTEM_PROMPT, /## <场景名>/);
    assert.match(FORMAT_SYSTEM_PROMPT, /一个非空行 = 一个步骤/);
    assert.match(FORMAT_SYSTEM_PROMPT, /断言必须单独成行/);
    // 不编造与占位符保真是格式化不改变测试意图的前提。
    assert.match(FORMAT_SYSTEM_PROMPT, /不得编造/);
    assert.match(FORMAT_SYSTEM_PROMPT, /占位符/);
  });

  test("已经是用例格式的回复原样返回", () => {
    const text = "## 登录\n打开 https://example.com\n断言页面包含 Example";
    assert.equal(parseFormattedCase(text), text);
  });

  test("剥掉 markdown 代码围栏", () => {
    const text = "```markdown\n## A\n打开 x\n断言 y\n```";
    assert.equal(parseFormattedCase(text), "## A\n打开 x\n断言 y");
  });

  test("丢掉第一个 ## 之前的开场白", () => {
    const text = "以下是整理后的用例：\n\n## A\n打开 x\n断言 y";
    assert.equal(parseFormattedCase(text), "## A\n打开 x\n断言 y");
  });

  test("统一 CRLF，避免步骤行尾带 \\r", () => {
    assert.equal(
      parseFormattedCase("## A\r\n打开 x\r\n断言 y"),
      "## A\n打开 x\n断言 y",
    );
  });

  test("空回复、只有注释的回复判为不可用", () => {
    assert.equal(parseFormattedCase(""), undefined);
    assert.equal(parseFormattedCase("   \n"), undefined);
    assert.equal(parseFormattedCase("# 标题\n> 前置说明"), undefined);
  });

  test("没有 ## 的纯步骤文本仍然可用", () => {
    assert.equal(
      parseFormattedCase("打开 https://example.com\n断言页面包含 Example"),
      "打开 https://example.com\n断言页面包含 Example",
    );
  });
});
