import { test } from "node:test";
import assert from "node:assert/strict";
import { createBskTools } from "../../dist/bsk/tools.js";

test("浏览器工具全部声明 sequential：一次返回多个调用时不会并行踩页面状态", () => {
  const tools = createBskTools({ session: "test-session" });
  assert.ok(tools.length > 0);
  for (const tool of tools) {
    assert.equal(tool.executionMode, "sequential", tool.name);
  }
});
