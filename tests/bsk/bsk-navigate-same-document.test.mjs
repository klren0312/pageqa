import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  canonicalUrl,
  cooperationReason,
  isObservationRequiredError,
  isRetryableObservationError,
  isSameDocumentNavigation,
  isStrictObservationRefusal,
  readObservationId,
} from "../../dist/bsk/tools.js";

// 这两条判据决定「navigate 等不到生命周期时该不该改判成功」，所以两个方向都要钉：
// - 判宽了 → 真失败（被重定向、导航没完成）被当成成功，用例在一片「通过」里跑偏；
// - 判窄了 → 同文档 hash / SPA 路由切换继续白等 30s 并判死（钉钉日志用例的实测现场）。

describe("isSameDocumentNavigation：同源 + 同 path/query 才算同文档", () => {
  test("只差 hash：同文档（浏览器不会产生新的文档加载）", () => {
    assert.equal(
      isSameDocumentNavigation("https://a.com/app", "https://a.com/app#/form1"),
      true,
    );
    assert.equal(
      isSameDocumentNavigation("https://a.com/app#/form1", "https://a.com/app#/form2"),
      true,
    );
    // 完全相等也是
    assert.equal(isSameDocumentNavigation("https://a.com/app", "https://a.com/app"), true);
  });

  test("hash 路由里带 query：path/query 相同，仍算同文档", () => {
    assert.equal(
      isSameDocumentNavigation(
        "https://a.com/#/system/messages/dingtalk-log",
        "https://a.com/#/system/messages/dingtalk-log?pageNo=2",
      ),
      true,
    );
  });

  test("path 或 query 不同：不是同文档（必须真等导航）", () => {
    assert.equal(isSameDocumentNavigation("https://a.com/a", "https://a.com/b"), false);
    assert.equal(
      isSameDocumentNavigation("https://a.com/a?x=1", "https://a.com/a?x=2"),
      false,
    );
  });

  test("跨源：不是同文档", () => {
    assert.equal(isSameDocumentNavigation("https://a.com/x", "https://b.com/x"), false);
    assert.equal(
      isSameDocumentNavigation("http://a.com/x", "https://a.com/x"),
      false,
    );
  });

  test("空串一律不算（缺一侧就没法比较，不能猜成同文档）", () => {
    assert.equal(isSameDocumentNavigation("", "https://a.com/x"), false);
    assert.equal(isSameDocumentNavigation("https://a.com/x", ""), false);
    assert.equal(isSameDocumentNavigation("", ""), false);
  });

  test("解析不了的地址退回「去 hash 后字符相等」，而不是直接判否", () => {
    assert.equal(isSameDocumentNavigation("about:blank", "about:blank#x"), true);
    assert.equal(isSameDocumentNavigation("about:blank", "about:srcdoc"), false);
  });
});

describe("canonicalUrl：只归一 `#/` 与空 hash，别的一律原样", () => {
  test("空 hash 与 `#/` 视为同一个地址（SPA 首页最常见的一种）", () => {
    assert.equal(canonicalUrl("https://a.com/app#"), "https://a.com/app");
    assert.equal(canonicalUrl("https://a.com/app#/"), "https://a.com/app");
    assert.equal(
      canonicalUrl("https://a.com/app#"),
      canonicalUrl("https://a.com/app"),
      "不然「导航到 /app」之后核对当前地址 /app# 会一直对不上",
    );
  });

  test("有实义 hash 时原样保留（归一掉就会把 /a#x 与 /a#y 混成一个）", () => {
    assert.equal(canonicalUrl("https://a.com/app#/form1"), "https://a.com/app#/form1");
    assert.equal(canonicalUrl("https://a.com/app#top"), "https://a.com/app#top");
  });

  test("没有 hash 的地址原样返回；首尾空白被剥掉", () => {
    assert.equal(canonicalUrl("https://a.com/app"), "https://a.com/app");
    assert.equal(canonicalUrl("  https://a.com/app  "), "https://a.com/app");
    assert.equal(canonicalUrl(""), "");
  });
});

// target policy 下 navigate 属于「无目标动作」，必须带一个未消耗的 observation_id，
// 而 CLI 从不替我们补。这两个判据决定「要不要补一份再试」，判断错了要么死锁
// （永远不带、永远被拒），要么空烧往返（白 sync）。
describe("readObservationId：只认顶层 observation_id", () => {
  test("pretty JSON（sync 的真实输出形状）也能取到", () => {
    const reply = `{
  "context_id": "c-1",
  "observation_id": "obs-uuid-1",
  "observation": { "observation_id": "inner-should-not-win" }
}`;
    assert.equal(readObservationId(reply), "obs-uuid-1");
  });

  test("只有嵌套的 observation.observation_id 时返回 undefined（那是 VOM 正文的）", () => {
    assert.equal(
      readObservationId('{"observation":{"observation_id":"inner"}}'),
      undefined,
    );
  });

  test("解析不了 / 空值 / 非字符串一律 undefined，绝不猜一个 id 出来", () => {
    assert.equal(readObservationId(""), undefined);
    assert.equal(readObservationId("not json"), undefined);
    assert.equal(readObservationId("{}"), undefined);
    assert.equal(readObservationId('{"observation_id":"   "}'), undefined);
    assert.equal(readObservationId('{"observation_id":42}'), undefined);
  });
});

describe("isObservationRequiredError：IPC 与 CLI 两条路径判一致", () => {
  test("IPC 路径：bskData.reason 就是答案", () => {
    const err = Object.assign(new Error("whatever"), {
      bskData: { reason: "observation_required" },
    });
    assert.equal(isObservationRequiredError(err), true);
  });

  test("CLI 子进程路径：按 bsk 渲染出的 details 行认（实测原文）", () => {
    const err = Object.assign(new Error("Command failed: bsk navigate ..."), {
      stderr:
        "Command failed: bsk navigate http://x/#/a\n" +
        "error: this action needs an explicit current observation\n" +
        "hint: pass the sync reply's top-level observation_id explicitly with --observation\n" +
        "details: This action requires an unused strict observation from cooperate sync\n",
    });
    assert.equal(isObservationRequiredError(err), true);
  });

  test("别的权限拒绝不能被误认成缺 observation（否则每次失败都白 sync 一次）", () => {
    const err = Object.assign(new Error("nope"), {
      stderr:
        "error: the operation is not permitted on the current target\n" +
        "details: A page frame changed; synchronize before choosing this action",
    });
    assert.equal(isObservationRequiredError(err), false);
    assert.equal(isObservationRequiredError(new Error("boom")), false);
    assert.equal(isObservationRequiredError(undefined), false);
  });
});

// navigate 这一类失败（56ms、一次 CDP 都没到）此前在 pageqa 侧完全救不回来：
// IPC 路径漏了 document_changed，CLI 路径压根拿不到 reason。
describe("cooperationReason：IPC 认 reason，CLI 认固定文案", () => {
  test("document_changed 与 control_context_invalid 同一处置（bsk 侧就是同一分支）", () => {
    const at = (reason) => Object.assign(new Error("x"), { bskData: { reason } });
    assert.equal(cooperationReason(at("document_changed")), "document_changed");
    assert.equal(cooperationReason(at("control_context_invalid")), "control_context_invalid");
  });

  test("CLI 路径没有 bskData：按 render_error.rs 的固定文案认出来", () => {
    const err = Object.assign(
      new Error("Command failed: bsk navigate http://localhost/#/a --session aecd --quiet"),
      {
        stderr:
          "Command failed: bsk navigate http://localhost/#/a --session aecd --quiet\n" +
          "error: the control context no longer belongs to the current document or control state\n" +
          "hint: run `bsk sync` to synchronize this tab and reconsider the action using the current page\n",
      },
    );
    assert.equal(cooperationReason(err), "control_context_invalid");
  });

  test("A page frame changed 与普通失败都不算协作上下文失效", () => {
    const frameChanged = Object.assign(new Error("x"), {
      stderr:
        "error: the operation is not permitted on the current target\n" +
        "details: A page frame changed; synchronize before choosing this action",
    });
    assert.equal(cooperationReason(frameChanged), undefined);
    assert.equal(cooperationReason(Object.assign(new Error("x"), { bskData: { reason: "page_load_failed" } })), undefined);
    assert.equal(cooperationReason(new Error("boom")), undefined);
    assert.equal(cooperationReason(undefined), undefined);
  });
});

// 现场：snapshot 823ms 报 `Document changed during observation`，下一次 snapshot 586ms
// 就成功了——中间只隔了一次模型往返。只读动作本可以在本地把这一趟省掉。
describe("isRetryableObservationError：观察期间文档变了就直接重跑", () => {
  test("observation.ts 回的是 ref_not_found，不是 document_changed", () => {
    const at = (reason) => Object.assign(new Error("x"), { bskData: { reason } });
    assert.equal(isRetryableObservationError(at("ref_not_found")), true);
    assert.equal(isRetryableObservationError(at("observation_changed")), true);
  });

  test("协作上下文失效不算「直接重跑」——那类要先 sync", () => {
    // 同一个 ref_not_found 之外的原因必须走 sync 分支，混在一起会让 context 永远不自愈。
    const at = (reason) => Object.assign(new Error("x"), { bskData: { reason } });
    assert.equal(isRetryableObservationError(at("control_context_invalid")), false);
    assert.equal(isRetryableObservationError(at("cooperation_sync_required")), false);
  });

  test("CLI 路径没有 reason：按 bsk 渲染的原文也能认（实测 #3 的文案）", () => {
    const cli = Object.assign(new Error("Command failed: bsk snapshot --session aecd --quiet"), {
      stderr:
        "Command failed: bsk snapshot --session aecd --quiet\n" +
        "error: the referenced element no longer exists\n" +
        "hint: rerun snapshot to get fresh refs\n" +
        "details: Document changed during observation; observe again\n",
    });
    assert.equal(isRetryableObservationError(cli), true);
  });

  test("真失败一律不重跑", () => {
    assert.equal(isRetryableObservationError(new Error("boom")), false);
    assert.equal(isRetryableObservationError(undefined), false);
    assert.equal(
      isRetryableObservationError(
        Object.assign(new Error("x"), { bskData: { reason: "page_load_failed" } }),
      ),
      false,
    );
  });
});

// 现场（pageqa-2026-11-18.log）：一次运行里 80 次失败有 67 次是「观察闸门拒绝」——
// wait_for 32 次只成 1 次、select_option 10 次全挂，模型于是反复 navigate 重试，白烧 140s。
// 这一族失败的共同点是「一次 CDP 都没到」，所以只读探针可以安全地 --unverified 重放。
describe("isStrictObservationRefusal：观察闸门拒绝的四种文案", () => {
  test("observation_required：本次调用需要一份还没被消耗的 strict observation", () => {
    const err = Object.assign(new Error("x"), {
      bskData: { reason: "observation_required" },
    });
    assert.equal(isStrictObservationRefusal(err), true);
    const cli = Object.assign(new Error("Command failed: bsk evaluate ..."), {
      stderr:
        "error: the operation is not permitted on the current target（reason: observation_required）\n" +
        "hint: This action requires an unused strict observation from cooperate sync and nothing was dispatched\n",
    });
    assert.equal(isStrictObservationRefusal(cli), true);
  });

  test("带了但已过期：needs an explicit current observation / strict observation changed", () => {
    const cli = Object.assign(new Error("Command failed: bsk navigate ..."), {
      stderr:
        "error: this action needs an explicit current observation\n" +
        "hint: pass the sync reply's top-level observation_id explicitly with --observation\n" +
        "details: The strict observation changed before this action\n",
    });
    assert.equal(isStrictObservationRefusal(cli), true);
  });

  test("控制上下文不属于当前文档：page changed under the action", () => {
    const cli = Object.assign(new Error("Command failed: bsk click ..."), {
      stderr:
        "error: the page changed under the action; the reference context expired\n" +
        "details: This action requires a valid control context from cooperate sync\n",
    });
    assert.equal(isStrictObservationRefusal(cli), true);
  });

  test("真故障一律不算：会话失效、页面加载失败、A page frame changed", () => {
    assert.equal(isStrictObservationRefusal(new Error("boom")), false);
    assert.equal(isStrictObservationRefusal(undefined), false);
    assert.equal(
      isStrictObservationRefusal(
        Object.assign(new Error("x"), { bskData: { reason: "page_load_failed" } }),
      ),
      false,
    );
    // 与 isObservationRequiredError 保持同口径：这条不是「没派发」，不能当成可重放。
    assert.equal(
      isStrictObservationRefusal(
        Object.assign(new Error("x"), {
          stderr:
            "error: the operation is not permitted on the current target\n" +
            "details: A page frame changed; synchronize before choosing this action",
        }),
      ),
      false,
    );
  });
});
