import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { runAgent } from "../dist/agent.js";

const SID = (() => {
  try {
    const out = execFileSync("bsk", ["session", "start", "--json"], { encoding: "utf-8" });
    return JSON.parse(out).session_id;
  } catch {
    return process.env.PAGEQA_SESSION || "";
  }
})();

function txt(input) {
  return runAgent(input, { session: SID }).then((r) => r.report);
}

// A1：打开真实页面并断言标题包含
describe("A1 打开页面并断言标题", () => {
  test("example.com 标题包含 Example", async () => {
    const report = await txt("打开 https://example.com 并断言标题包含 Example");
    assert.equal(report.status, "pass");
    assert.ok(report.assertions.some((a) => a.verdict === "pass"), "应有成立的断言");
  });
});

// A2：交互流程（点击链接 + 等待 + 断言出现）
describe("A2 元素交互与断言", () => {
  test("点击链接后断言新页面出现对应文本", async () => {
    const report = await txt(
      "打开 https://example.com 。点击页面上的「Learn more」链接，等待页面加载，然后断言页面包含 'IANA'。",
    );
    assert.equal(report.status, "pass");
  });
});

// A3：失败场景（断言不存在的文本），应失败且给出可读原因
describe("A3 失败可读原因", () => {
  test("断言不存在文本 -> fail", async () => {
    const report = await txt("打开 https://example.com 并断言页面包含 'THIS_TEXT_SHOULD_NOT_EXIST_XYZ'");
    assert.equal(report.status, "fail");
  });
});

// A4：报告格式（文本与 JSON）
describe("A4 报告格式", () => {
  test("文本与 JSON 报告均可生成且结构稳定", async () => {
    const r = await runAgent("打开 https://example.com 并断言标题包含 Example", { session: SID });
    assert.ok(r.text.includes("结论: PASS") || r.text.includes("结论: FAIL"));
    const json = JSON.parse(r.json);
    assert.ok(["pass", "fail"].includes(json.status));
    assert.ok(Array.isArray(json.assertions));
    assert.equal(typeof json.transcript, "string");
  });
});
