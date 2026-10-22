import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createBskTools,
  isSelectorMiss,
  snapshotLooksLikeNotFound,
  snapshotOnlyHasRoot,
} from "../../dist/bsk/tools.js";

test("浏览器工具全部声明 sequential：一次返回多个调用时不会并行踩页面状态", () => {
  const tools = createBskTools({ session: "test-session" });
  assert.ok(tools.length > 0);
  for (const tool of tools) {
    assert.equal(tool.executionMode, "sequential", tool.name);
  }
});

// 小模型实测：页面还是空白时 snapshot 只回 RootWebArea，模型却继续用猜的 CSS
// 选择器点了一串「did not match any element」。快照层要能识别这种「只有根节点」。
test("snapshotOnlyHasRoot：只有根节点时判空，正常快照与空串都不算", () => {
  assert.equal(
    snapshotOnlyHasRoot(
      [
        "@vom 1",
        "@view 1431x818",
        "@layers 1 focus=L1",
        "L1 page",
        '  RootWebArea "经路云-LTC管理平台"',
      ].join("\n"),
    ),
    true,
  );
  assert.equal(
    snapshotOnlyHasRoot(
      [
        "@vom 1",
        "@view 1431x818",
        "@layers 1 focus=L1",
        "L1 page",
        '  RootWebArea "经路云-LTC管理平台"',
        '  button "搜索"',
      ].join("\n"),
    ),
    false,
  );
  assert.equal(snapshotOnlyHasRoot(""), false);
});

test("isSelectorMiss：只认「选择器没匹配到元素」，不把浏览器断连当成选择器问题", () => {
  assert.equal(
    isSelectorMiss(
      'error: requested resource does not exist | details: selector [data-label="发送渠道"] .el-select__input did not match any element',
    ),
    true,
  );
  assert.equal(isSelectorMiss("the session, tab, or browser may have stopped"), false);
  assert.equal(isSelectorMiss("error: unknown session"), false);
});

test("snapshotLooksLikeNotFound：识别前端 404 兜底页，正常页面不误判", () => {
  assert.equal(
    snapshotLooksLikeNotFound(
      [
        'RootWebArea "经路云-LTC管理平台 - 404"',
        '  StaticText "抱歉，您访问的页面不存在。"',
        '  button "返回首页"',
      ].join("\n"),
    ),
    true,
  );
  assert.equal(
    snapshotLooksLikeNotFound('RootWebArea "经路云-LTC管理平台 - 钉钉日志"'),
    false,
  );
});
