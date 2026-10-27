import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createReportDefectTool } from "../../dist/bsk/tools.js";

const valid = {
  title: "保存后列表未刷新",
  severity: "critical",
  kind: "functional",
  expectation: "列表出现新记录",
  actual: "列表仍是旧数据",
  evidence: "截图见本次运行",
};

/** 执行一次工具，返回 { text, reported }。 */
async function run(params, opts = {}) {
  const reported = [];
  const tool = createReportDefectTool({
    ...opts,
    onDefect: (d) => reported.push(d),
  });
  const result = await tool.execute("call-1", params);
  return { text: result.content[0].text, reported };
}

describe("report_defect 工具", () => {
  test("字段齐全时上报一条，并带上当前页址", async () => {
    const { text, reported } = await run(valid, {
      pageUrl: async () => "https://example.com/list",
    });
    assert.equal(reported.length, 1);
    assert.equal(reported[0].title, valid.title);
    assert.equal(reported[0].url, "https://example.com/list");
    assert.ok(text.includes("已记录缺陷"));
  });

  test("缺少证据时不记录，且不抛错（不能把一条通过的用例判红）", async () => {
    const { text, reported } = await run({ ...valid, evidence: "" });
    assert.equal(reported.length, 0);
    assert.ok(text.includes("未记录缺陷"));
    assert.ok(text.includes("evidence"));
  });

  test("非法严重度/类型时不记录", async () => {
    const badSeverity = await run({ ...valid, severity: "blocker" });
    assert.equal(badSeverity.reported.length, 0);
    assert.ok(badSeverity.text.includes("severity"));

    const badKind = await run({ ...valid, kind: "unattributed" });
    assert.equal(badKind.reported.length, 0);
    assert.ok(badKind.text.includes("kind"));
  });

  test("读页址失败不影响缺陷成立", async () => {
    const { reported } = await run(valid, {
      pageUrl: async () => {
        throw new Error("evaluate 被拒");
      },
    });
    assert.equal(reported.length, 1);
    assert.equal("url" in reported[0], false);
  });
});
