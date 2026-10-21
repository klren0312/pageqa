import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { isMissingWaitForElement, parseNativeWait } from "../../dist/bsk/tools.js";

// 纯单元测试：`bsk wait-for-element` 的接入面（结果行解析 + 旧版降级判定）。
//
// 这两件事都**不能靠真浏览器测**：
// - 结果行的形状来自 bsk CLI 的 human 输出（`crates/bsk-cli/src/cli/waits.rs`），
//   是稳定契约，用样本钉住比起 daemon 便宜；
// - 降级判定判错的两种后果都不报错——把真故障当「旧版本」会把一次失败拖成一次慢，
//   把旧版本当真故障会让用例直接红。所以两个方向都要钉。

describe("parseNativeWait：解析 CLI 的 human 行", () => {
  const line = (extra) =>
    `wait-for-element ok tab=9 target=#mask state=hidden satisfied=false${extra}`;

  test("满足时读 satisfied / 证据 / 耗时", () => {
    assert.deepEqual(
      parseNativeWait(
        "wait-for-element ok tab=9 target=#mask state=visible satisfied=true attached=true visible=true elapsed_ms=7\n",
      ),
      { satisfied: true, attached: true, visible: true, elapsedMs: 7 },
    );
  });

  test("超时（退出码 0）照旧解析出证据：attached 与 visible 是两个独立事实", () => {
    assert.deepEqual(
      parseNativeWait(line(" attached=true visible=false elapsed_ms=10004")),
      { satisfied: false, attached: true, visible: false, elapsedMs: 10004 },
    );
    assert.deepEqual(
      parseNativeWait(line(" attached=false visible=false elapsed_ms=10001")),
      { satisfied: false, attached: false, visible: false, elapsedMs: 10001 },
    );
  });

  test("一次探测都没完成时 attached/visible 是 unknown（bsk 打的是字面 unknown）", () => {
    // CLI 的 format_observed：Some(true) → true、Some(false) → false、None → unknown。
    // 认成 false 会凭空说「元素确实不在」，而事实是「没观测到」。
    assert.deepEqual(
      parseNativeWait(line(" attached=unknown visible=unknown elapsed_ms=100")),
      { satisfied: false, attached: null, visible: null, elapsedMs: 100 },
    );
  });

  test("认不出来的输出返回 null（调用方退回探针，而不是编一个结论）", () => {
    assert.equal(parseNativeWait(""), null);
    assert.equal(parseNativeWait("   \n"), null);
    // 缺 satisfied 就不是这条命令的结果行
    assert.equal(parseNativeWait("wait-for-element ok tab=9 target=#mask"), null);
    // 纯 JSON 不认：pageqa 不加 --json，认它等于默认了一个没被验证过的信封
    assert.equal(parseNativeWait('{"satisfied":true}'), null);
  });

  test("混进 stderr 的对话框摘要不影响解析（结果行在前）", () => {
    const out =
      "wait-for-element ok tab=1 target=@e3 state=visible satisfied=true attached=true visible=true elapsed_ms=3\n" +
      "\ndialog: type=alert handled=accept message=hi";
    const parsed = parseNativeWait(out);
    assert.equal(parsed.satisfied, true);
    assert.equal(parsed.elapsedMs, 3);
  });
});

describe("isMissingWaitForElement：只认「当前 bsk 没有这条命令」", () => {
  test("IPC 快路径的协议漂移：unknown_method", () => {
    assert.equal(isMissingWaitForElement({ bskCode: "unknown_method" }), true);
  });

  test("旧版 CLI 的 clap 报错（子进程路径，退出码非零）", () => {
    // 旧版 bsk 没有这个子命令 / 没有这些 flag，clap 的原话：
    assert.equal(
      isMissingWaitForElement({
        stderr: "error: unexpected argument '--state' found\n\nUsage: bsk wait-for-element ...",
      }),
      true,
    );
    assert.equal(
      isMissingWaitForElement({ stderr: "error: unexpected argument '--poll-ms' found" }),
      true,
    );
    assert.equal(
      isMissingWaitForElement({ stderr: "error: unrecognized subcommand 'wait-for-element'" }),
      true,
    );
  });

  test("真故障不算「命令不存在」——否则会把一次失败静默拖成一次慢", () => {
    // CDP 断开、ref 失效、页面没连上：这些都是真错误，必须上抛
    for (const err of [
      { bskCode: "cdp_failed", stderr: "error: browser rejected the underlying CDP call" },
      { bskCode: "not_found", stderr: "error: requested resource does not exist" },
      { stderr: "error: no browser is connected to the daemon" },
      { message: "Command failed: bsk wait-for-element #a --session s1" },
      {},
    ]) {
      assert.equal(isMissingWaitForElement(err), false, JSON.stringify(err));
    }
    assert.equal(isMissingWaitForElement(null), false);
    assert.equal(isMissingWaitForElement(undefined), false);
  });
});
