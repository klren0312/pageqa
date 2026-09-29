import { test, describe } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BskIpcAbortError,
  BskIpcRpcError,
  BskIpcTransportError,
  ipcCall,
  readDaemonEndpoint,
  resetIpcPool,
} from "../dist/bsk/ipc.js";
import {
  extractDialogs,
  ipcErrorToCliError,
  ipcTimeoutToCliError,
  isProtocolDrift,
  looksLikeRef,
  parseDurationMs,
  planIpcCall,
  renderCliErrorText,
  renderDialogs,
  withCliTrailingNewline,
} from "../dist/bsk/ipc-commands.js";

// 纯单元测试：用一个假 IPC daemon 顶替 bsk，不需要浏览器。
// bsk 侧的协议来自 BrowserSkill 源码（crates/bsk-cli/src/daemon/ipc.rs、crates/bsk-protocol/src/frame.rs）：
// 一行一个 JSON，`{id,method,params}` → `{id,result}` 或 `{id,error:{code,message,data}}`。

let seq = 0;

/** 起一个只管 JSON-line 的假 daemon；`reply(frame, conn)` 返回要回写的帧（undefined = 不回）。 */
function startFakeDaemon(reply) {
  const id = `${process.pid}-${seq++}`;
  const pipePath =
    process.platform === "win32"
      ? `\\\\.\\pipe\\bsk-pageqa-test-${id}`
      : join(tmpdir(), `bsk-pageqa-test-${id}.sock`);
  const frames = [];
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.setEncoding("utf8");
    let buffer = "";
    // 一条连接上严格串行处理：与真 daemon 的 handle_connection 一致。
    let queue = Promise.resolve();
    socket.on("data", (chunk) => {
      buffer += chunk;
      for (;;) {
        const nl = buffer.indexOf("\n");
        if (nl < 0) break;
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        const frame = JSON.parse(line);
        frames.push({ frame, socket });
        queue = queue.then(async () => {
          const body = await reply(frame, socket, frames);
          if (body === undefined) return;
          socket.write(JSON.stringify({ id: frame.id, ...body }) + "\n");
        });
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(pipePath, () => {
      resolve({
        pipePath,
        frames,
        close: () =>
          new Promise((done) => {
            for (const s of sockets) s.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}

/** 造一个指向假 daemon 的 BSK_HOME（daemon.json 的 pid 用本进程，判活才过得去）。 */
function useHome(pipePath) {
  const home = mkdtempSync(join(tmpdir(), "pageqa-ipc-home-"));
  writeFileSync(
    join(home, "daemon.json"),
    JSON.stringify({ pid: process.pid, sock_path: pipePath, ws_port: 1, version: "test" }),
  );
  process.env.BSK_HOME = home;
  return () => {
    delete process.env.BSK_HOME;
    resetIpcPool();
    rmSync(home, { recursive: true, force: true });
  };
}

describe("planIpcCall：argv → RPC", () => {
  test("snapshot 只读，参数与 CLI 的 --session/--max-tokens 对齐", () => {
    const plan = planIpcCall([
      "snapshot",
      "--session",
      "s1",
      "--quiet",
      "--max-tokens",
      "4000",
      "--max-depth",
      "8",
    ]);
    assert.equal(plan.method, "tool.snapshot");
    assert.deepEqual(plan.params, { session_id: "s1", max_tokens: 4000, max_depth: 8 });
    assert.equal(plan.sessionKey, "s1");
    assert.equal(plan.mutating, false);
  });

  test("click 区分引用与选择器，并标记为改动型", () => {
    const byRef = planIpcCall(["click", "@e3", "--session", "s1", "--quiet"]);
    assert.equal(byRef.method, "tool.click");
    assert.deepEqual(byRef.params, { session_id: "s1", ref: "@e3" });
    assert.equal(byRef.mutating, true);

    const bySelector = planIpcCall(["click", "#submit", "--session", "s1"]);
    assert.deepEqual(bySelector.params, { session_id: "s1", selector: "#submit" });
  });

  test("fill 带上 --value 与 --tab-id", () => {
    const plan = planIpcCall([
      "fill",
      "@e9",
      "--value",
      "自动化测试",
      "--session",
      "s1",
      "--tab-id",
      "7",
      "--quiet",
    ]);
    assert.equal(plan.method, "tool.fill");
    assert.deepEqual(plan.params, {
      session_id: "s1",
      value: "自动化测试",
      ref: "@e9",
      tab_id: 7,
    });
    assert.equal(plan.mutating, true);
  });

  test("hover 默认补上 CLI 的 200ms settle", () => {
    const plan = planIpcCall(["hover", "@e5", "--session", "s1"]);
    assert.equal(plan.method, "tool.hover");
    assert.equal(plan.params.settle_ms, 200);
  });

  test("scroll-to 与 wait-ms（后者不需要 session）", () => {
    const scroll = planIpcCall(["scroll-to", "@e2", "--session", "s1"]);
    assert.equal(scroll.method, "tool.scroll_to");
    assert.equal(scroll.mutating, true);

    const wait = planIpcCall(["wait-ms", "1500"]);
    assert.equal(wait.method, "tool.wait_ms");
    assert.deepEqual(wait.params, { duration_ms: 1500 });
    assert.equal(wait.sessionKey, "@daemon");
    assert.equal(wait.mutating, false);
  });

  test("evaluate：表达式走位置参数，超时透传，归为改动型（不因失败重跑脚本）", () => {
    const plan = planIpcCall([
      "evaluate",
      "(() => 1 + 1)()",
      "--session",
      "s1",
      "--timeout",
      "2800ms",
    ]);
    assert.equal(plan.method, "tool.evaluate");
    assert.deepEqual(plan.params, {
      session_id: "s1",
      expression: "(() => 1 + 1)()",
      timeout_ms: 2800,
    });
    assert.equal(plan.sessionKey, "s1");
    assert.equal(plan.mutating, true);

    const withFlags = planIpcCall([
      "evaluate",
      "1",
      "--session",
      "s1",
      "--await-promise",
      "false",
      "--return-by-value",
      "true",
    ]);
    assert.equal(withFlags.params.await_promise, false);
    assert.equal(withFlags.params.return_by_value, true);

    assert.equal(planIpcCall(["evaluate", "--session", "s1"]), null); // 缺表达式
    assert.equal(planIpcCall(["evaluate", "1"]), null); // 缺 --session
  });

  test("press：键名走位置参数，聚焦目标走 --ref/--selector", () => {
    const plan = planIpcCall(["press", "Enter", "--session", "s1", "--quiet"]);
    assert.equal(plan.method, "tool.press");
    assert.deepEqual(plan.params, { session_id: "s1", key: "Enter" });
    assert.equal(plan.mutating, true);

    // 修饰键与 CLI 的 parse_modifiers 同义：大小写无关、保序、别名归一
    const focused = planIpcCall([
      "press",
      "Escape",
      "--ref",
      "@e3",
      "--modifiers",
      "Ctrl,shift",
      "--hold-ms",
      "800",
      "--session",
      "s1",
    ]);
    assert.deepEqual(focused.params, {
      session_id: "s1",
      key: "Escape",
      ref: "@e3",
      modifiers: ["ctrl", "shift"],
      hold_ms: 800,
    });

    const bySelector = planIpcCall(["press", "Tab", "--selector", "#kw", "--session", "s1"]);
    assert.deepEqual(bySelector.params, { session_id: "s1", key: "Tab", selector: "#kw" });
  });

  test("press 的行格式与 CLI 一致（含修饰键）", () => {
    const plan = planIpcCall(["press", "Enter", "--session", "s1"]);
    assert.equal(
      plan.render({ tab_id: 4, key: "Enter", code: "Enter" }),
      "press ok tab=4 key=Enter code=Enter",
    );
    assert.equal(
      plan.render({ tab_id: 4, key: "a", code: "KeyA", modifiers: ["ctrl"] }),
      "press ok tab=4 key=a code=KeyA modifiers=[ctrl]",
    );
  });

  test("press 认不出的形状一律退回 CLI（不改写、不猜）", () => {
    assert.equal(planIpcCall(["press", "--session", "s1"]), null); // 缺键名
    assert.equal(planIpcCall(["press", "Enter"]), null); // 缺 --session
    assert.equal(planIpcCall(["press", "Enter", "Extra", "--session", "s1"]), null); // 多给位置参数
    assert.equal(
      planIpcCall(["press", "Enter", "--modifiers", "garbage", "--session", "s1"]),
      null,
    );
    assert.equal(
      planIpcCall(["press", "Enter", "--ref", "@e1", "--selector", "#a", "--session", "s1"]),
      null,
    );
    assert.equal(
      planIpcCall(["press", "Enter", "--hold-ms", "1s", "--session", "s1"]),
      null,
    );
  });

  test("wheel：增量走 --delta-x/--delta-y，落点是可选的位置参数", () => {
    const plan = planIpcCall(["wheel", "@e3", "--delta-y", "600", "--session", "s1"]);
    assert.equal(plan.method, "tool.wheel");
    assert.deepEqual(plan.params, { session_id: "s1", ref: "@e3", delta_y: 600 });
    assert.equal(plan.mutating, true);

    // 不给落点是**合法**用法（滚视口中心）：params 里不该出现任何 target 字段
    const center = planIpcCall([
      "wheel",
      "--delta-y",
      "-120",
      "--delta-x",
      "40.5",
      "--session",
      "s1",
    ]);
    assert.deepEqual(center.params, { session_id: "s1", delta_y: -120, delta_x: 40.5 });

    const bySelector = planIpcCall([
      "wheel",
      "--selector",
      "#panel",
      "--delta-y",
      "600",
      "--modifiers",
      "Shift",
      "--session",
      "s1",
    ]);
    assert.deepEqual(bySelector.params, {
      session_id: "s1",
      selector: "#panel",
      delta_y: 600,
      modifiers: ["shift"],
    });
  });

  test("wheel 的行格式与 CLI 一致（取不到落点时是 viewport-center，不是共用的 ?）", () => {
    const plan = planIpcCall(["wheel", "--delta-y", "600", "--session", "s1"]);
    assert.equal(
      plan.render({ tab_id: 4, x: 700, y: 400, delta_x: 0, delta_y: 600 }),
      "wheel ok tab=4 target=viewport-center at=(700, 400) delta=(0, 600)",
    );
    assert.equal(
      plan.render({ tab_id: 4, used_ref: "@e3", x: 10, y: 20, delta_x: 0, delta_y: -120 }),
      "wheel ok tab=4 target=@e3 at=(10, 20) delta=(0, -120)",
    );
  });

  test("wheel 认不出的形状一律退回 CLI（由 bsk 报它自己那句）", () => {
    // 两个增量都是 0：bsk 的 validate_deltas 明确拒绝
    assert.equal(planIpcCall(["wheel", "--delta-y", "0", "--session", "s1"]), null);
    assert.equal(planIpcCall(["wheel", "--session", "s1"]), null);
    assert.equal(planIpcCall(["wheel", "--delta-y", "abc", "--session", "s1"]), null);
    assert.equal(planIpcCall(["wheel", "--delta-y", "", "--session", "s1"]), null);
    // 落点给了两个
    assert.equal(
      planIpcCall(["wheel", "@e1", "--selector", "#a", "--delta-y", "600", "--session", "s1"]),
      null,
    );
    assert.equal(
      planIpcCall(["wheel", "--delta-y", "600", "--modifiers", "garbage", "--session", "s1"]),
      null,
    );
    assert.equal(planIpcCall(["wheel", "--delta-y", "600"]), null);
  });

  test("focus / blur：目标是必需的，行格式与 CLI 一致", () => {
    const f = planIpcCall(["focus", "@e3", "--session", "s1"]);
    assert.equal(f.method, "tool.focus");
    assert.deepEqual(f.params, { session_id: "s1", ref: "@e3" });
    assert.equal(f.mutating, true);
    assert.equal(
      f.render({ tab_id: 4, used_ref: "@e3", focused: true }),
      "focus ok tab=4 target=@e3 focused=true",
    );

    const b = planIpcCall(["blur", "#kw", "--session", "s1"]);
    assert.equal(b.method, "tool.blur");
    assert.deepEqual(b.params, { session_id: "s1", selector: "#kw" });
    assert.equal(
      b.render({ tab_id: 4, used_selector: "#kw", was_focused: true, focused: false }),
      "blur ok tab=4 target=#kw was_focused=true focused=false",
    );
  });

  test("focus / blur：缺目标退回 CLI，结果缺字段算传输问题（不编默认值）", () => {
    assert.equal(planIpcCall(["focus", "--session", "s1"]), null);
    assert.equal(planIpcCall(["blur", "--session", "s1"]), null);
    assert.equal(planIpcCall(["focus", "--ref", "", "--session", "s1"]), null);
    assert.equal(planIpcCall(["focus", "@e1", "--session", "s1"]) !== null, true);

    const f = planIpcCall(["focus", "@e3", "--session", "s1"]);
    assert.throws(() => f.render({ tab_id: 4 }), /focused/);
    const b = planIpcCall(["blur", "@e3", "--session", "s1"]);
    assert.throws(() => b.render({ tab_id: 4, focused: false }), /was_focused/);
  });

  test("不认识的形状一律拒绝（退回 CLI），绝不猜", () => {
    assert.equal(planIpcCall(["navigate", "https://example.com", "--session", "s1"]), null);
    assert.equal(planIpcCall(["snapshot", "--session", "s1", "--json"]), null);
    assert.equal(planIpcCall(["click", "@e3", "--session", "s1", "--click-count", "2"]), null);
    assert.equal(planIpcCall(["click", "@e3", "--session", "s1", "--bogus"]), null);
    assert.equal(planIpcCall(["click", "@e3"]), null); // 缺 --session
    assert.equal(planIpcCall(["click", "--session", "s1"]), null); // 缺目标
    assert.equal(planIpcCall(["fill", "@e3", "--session", "s1"]), null); // 缺 --value
    assert.equal(planIpcCall(["wait-ms", "abc"]), null);
  });
});

describe("结果渲染与 CLI 文本一致", () => {
  const render = (plan, result) => plan.render(result);

  test("snapshot：空快照给 CLI 的提示语而不是空行", () => {
    const plan = planIpcCall(["snapshot", "--session", "s1"]);
    assert.equal(render(plan, { text: "L1 page\n  @e1 button" }), "L1 page\n  @e1 button");
    assert.equal(
      render(plan, { text: "" }),
      "(empty snapshot — page may still be loading)",
    );
  });

  test("click / hover / scroll-to / fill / wait-ms 的行格式", () => {
    assert.equal(
      render(planIpcCall(["click", "@e3", "--session", "s1"]), {
        tab_id: 9,
        used_ref: "e3",
        x: 10,
        y: 20.5,
      }),
      "click ok tab=9 target=@e3 at=(10, 20.5)",
    );
    assert.equal(
      render(planIpcCall(["hover", ".menu", "--session", "s1"]), {
        tab_id: 9,
        used_selector: ".menu",
        x: 1,
        y: 2,
      }),
      "hover ok tab=9 target=.menu at=(1, 2)",
    );
    assert.equal(
      render(planIpcCall(["scroll-to", "@e4", "--session", "s1"]), {
        tab_id: 3,
        used_ref: "e4",
        x: 0,
        y: 100,
        width: 200,
        height: 40,
      }),
      "scroll-to ok tab=3 target=@e4 bounds=(0, 100, 200, 40)",
    );
    assert.equal(
      render(planIpcCall(["fill", "@e5", "--value", "abc", "--session", "s1"]), {
        tab_id: 3,
        used_ref: "e5",
        value_length: 3,
      }),
      "fill ok tab=3 target=@e5 length=3",
    );
    assert.equal(render(planIpcCall(["wait-ms", "50"]), { waited_ms: 50 }), "waited_ms=50");
  });

  test("evaluate：对象值按紧凑 JSON 回显；脚本抛异常时 stdout 为空（与 CLI 同形）", () => {
    const plan = planIpcCall(["evaluate", "1", "--session", "s1"]);
    assert.equal(plan.render({ ok: true, value: { reason: "settled", waitedMs: 0 } }), '{"reason":"settled","waitedMs":0}');
    assert.equal(plan.render({ ok: true, value: "已等待" }), "已等待");
    assert.equal(plan.render({ ok: true, value: null }), "null");
    // CLI 把 throw 文本写 stderr、退出码仍是 0：这里 stdout 同样留空。
    assert.equal(plan.render({ ok: false, error: { text: "boom" } }), "");
  });

  test("取不到坐标的动作照常渲染（动作已生效，不该因为读数缺失就报错）", () => {
    const plan = planIpcCall(["click", "@e3", "--session", "s1"]);
    assert.equal(plan.render({ unexpected: true }), "click ok tab=? target=? at=(?, ?)");
  });

  test("快照缺正文 → 传输错误且 sent=true（只读命令，上层退回 CLI 重读是安全的）", () => {
    const plan = planIpcCall(["snapshot", "--session", "s1"]);
    assert.throws(
      () => plan.render({ ref_count: 3 }),
      (err) => err instanceof BskIpcTransportError && err.sent === true,
    );
  });
});

describe("错误文本与 CLI 对齐", () => {
  test("已知错误码用人话摘要，原因留在 details", () => {
    const text = renderCliErrorText("not_found", "ref @e99 unknown for tab 7");
    assert.match(text, /^error: requested resource does not exist$/m);
    assert.match(text, /^hint: .*bsk browsers/m);
    assert.match(text, /^details: ref @e99 unknown for tab 7$/m);
  });

  test("未收录的错误码不编摘要，原话进 error:", () => {
    const text = renderCliErrorText("some_new_code", "brand new failure");
    assert.match(text, /^error: brand new failure$/m);
    assert.doesNotMatch(text, /^details:/m);
  });

  test("RPC 错误 → 与 CLI 失败同形（stderr 文本 + stdout 空）", () => {
    const err = ipcErrorToCliError(
      new BskIpcRpcError("permission_denied", "element not visible (no content quads)", {
        reason: "element_not_visible",
      }),
    );
    assert.match(err.stderr, /^error: operation denied by the Agent Window sandbox$/m);
    assert.match(err.stderr, /^details: element not visible/m);
    assert.equal(err.stdout, "");
    assert.equal(err.bskCode, "permission_denied");
  });

  test("超时失败明确劝阻重发（动作可能已生效）", () => {
    const err = ipcTimeoutToCliError("tool.click", "IPC 调用超时");
    assert.match(err.stderr, /^error: operation timed out$/m);
    assert.match(err.stderr, /不要盲目重发/);
    assert.equal(err.bskCode, "timeout");
  });

  test("只有 unknown_method 算协议漂移", () => {
    assert.equal(isProtocolDrift(new BskIpcRpcError("unknown_method", "x")), true);
    // invalid_params 可能是真实的工具错误（例如 fill 到不可填的元素），
    // 当成漂移会导致同一动作重发一次——改动型命令最不能发生的事。
    assert.equal(isProtocolDrift(new BskIpcRpcError("invalid_params", "x")), false);
  });

  test("成功输出补上 CLI 的换行（与子进程 stdout 逐字节一致）", () => {
    assert.equal(withCliTrailingNewline("click ok tab=9"), "click ok tab=9\n");
  });

  test("小工具函数", () => {
    assert.equal(looksLikeRef("@e12"), true);
    assert.equal(looksLikeRef("e12"), true);
    assert.equal(looksLikeRef("#btn"), false);
    assert.equal(parseDurationMs("30s"), 30_000);
    assert.equal(parseDurationMs("1500ms"), 1500);
    assert.equal(parseDurationMs("250"), 250);
    assert.equal(parseDurationMs("nope"), null);
  });
});

describe("原生对话框透传", () => {
  test("结果里的 dialogs → 追加文本块；没有对话框时给空串", () => {
    assert.equal(renderDialogs(undefined), "");
    assert.equal(renderDialogs([]), "");
    const text = renderDialogs([
      {
        type: "confirm",
        handled: "accepted",
        message: "确定要删除吗？",
        url: "https://example.com/list",
      },
      { type: "prompt", handled: "dismissed", message: "输入名称", default_prompt: "" },
    ]);
    assert.match(text, /\ndialog: type=confirm handled=accepted message=确定要删除吗？/);
    assert.match(text, /\n {2}url=https:\/\/example\.com\/list/);
    assert.match(text, /\ndialog: type=prompt handled=dismissed message=输入名称/);
    // default_prompt 为空串时不出那一行（与 bsk 的 write_dialog_summaries 同规则）
    assert.doesNotMatch(text, /default_prompt/);
  });

  test("CLI stderr 里的摘要被提取出来，别的行不受影响", () => {
    const stderr = [
      "warning: observation truncated (refs=12, tab=3).",
      "dialog: type=alert handled=accepted message=保存成功",
      "  url=https://example.com/form",
      "some other noise",
    ].join("\n");
    const block = extractDialogs(stderr);
    assert.match(block, /dialog: type=alert handled=accepted message=保存成功/);
    assert.match(block, /\n {2}url=https:\/\/example\.com\/form/);
    // 截断告警、以及对话框块之后的无关行，都不该被卷进来
    assert.doesNotMatch(block, /truncated/);
    assert.doesNotMatch(block, /other noise/);
  });

  test("没有对话框时提取结果为空（不给成功输出添空白）", () => {
    assert.equal(extractDialogs(""), "");
    assert.equal(extractDialogs("click ok tab=3 target=@e1 at=(1, 2)\n"), "");
  });

  test("两条路径形状一致：result.dialogs 与 CLI stderr 得到同一段文本", () => {
    const dialogs = [
      { type: "confirm", handled: "accepted", message: "确定要删除吗？" },
      { type: "prompt", handled: "dismissed", message: "输入名称", default_prompt: "默认值" },
    ];
    // bsk 的 write_dialog_summaries 打出来的就是这三行（cli/dialogs.rs）
    const stderr = [
      "dialog: type=confirm handled=accepted message=确定要删除吗？",
      "dialog: type=prompt handled=dismissed message=输入名称",
      "  default_prompt=默认值",
    ].join("\n");
    assert.equal(extractDialogs(stderr), renderDialogs(dialogs));
  });
});

describe("IPC 往返（假 daemon）", () => {
  test("端点发现 + 握手 + 一条命令一次往返", async () => {
    const daemon = await startFakeDaemon((frame) => {
      if (frame.method === "system.ping") return { result: { pong: true } };
      return { result: { text: "L1 page", ref_count: 1, tab_id: 3, truncated: false } };
    });
    const cleanup = useHome(daemon.pipePath);
    try {
      const result = await ipcCall("s1", "tool.snapshot", { session_id: "s1" }, 2_000);
      assert.equal(result.text, "L1 page");
      const methods = daemon.frames.map((f) => f.frame.method);
      assert.deepEqual(methods, ["system.ping", "tool.snapshot"]);
      assert.deepEqual(daemon.frames[1].frame.params, { session_id: "s1" });
      assert.ok(typeof daemon.frames[1].frame.id === "string" && daemon.frames[1].frame.id);
      // 同一个 session 复用一条连接：握手只做一次。
      await ipcCall("s1", "tool.snapshot", { session_id: "s1" }, 2_000);
      assert.deepEqual(
        daemon.frames.map((f) => f.frame.method),
        ["system.ping", "tool.snapshot", "tool.snapshot"],
      );
    } finally {
      cleanup();
      await daemon.close();
    }
  });

  test("daemon 的结构化错误 → BskIpcRpcError（含 code 与 data）", async () => {
    const daemon = await startFakeDaemon((frame) => {
      if (frame.method === "system.ping") return { result: { pong: true } };
      return {
        error: {
          code: "not_found",
          message: "selector .nope did not match",
          data: { reason: "selector_not_found" },
        },
      };
    });
    const cleanup = useHome(daemon.pipePath);
    try {
      await assert.rejects(
        () => ipcCall("s1", "tool.click", { session_id: "s1", selector: ".nope" }, 2_000),
        (err) => {
          assert.ok(err instanceof BskIpcRpcError);
          assert.equal(err.code, "not_found");
          assert.deepEqual(err.data, { reason: "selector_not_found" });
          return true;
        },
      );
    } finally {
      cleanup();
      await daemon.close();
    }
  });

  test("超时 → 传输错误且 sent=true（请求已发出）", async () => {
    const daemon = await startFakeDaemon((frame) =>
      frame.method === "system.ping" ? { result: { pong: true } } : undefined,
    );
    const cleanup = useHome(daemon.pipePath);
    try {
      await assert.rejects(
        () => ipcCall("s1", "tool.click", { session_id: "s1", ref: "@e3" }, 150),
        (err) => {
          assert.ok(err instanceof BskIpcTransportError);
          assert.equal(err.sent, true);
          return true;
        },
      );
    } finally {
      cleanup();
      await daemon.close();
    }
  });

  test("中止 → 另开一条连接发 cancel {rpc_id}", async () => {
    let clicked = null;
    const daemon = await startFakeDaemon((frame) => {
      if (frame.method === "system.ping") return { result: { pong: true } };
      if (frame.method === "cancel") return { result: { cancelled: true } };
      clicked = frame;
      return undefined; // tool.click 永不返回：等调用方中止
    });
    const cleanup = useHome(daemon.pipePath);
    try {
      const ac = new AbortController();
      const pending = ipcCall(
        "s1",
        "tool.click",
        { session_id: "s1", ref: "@e3" },
        5_000,
        ac.signal,
      );
      await new Promise((r) => setTimeout(r, 80));
      ac.abort();
      await assert.rejects(pending, (err) => err instanceof BskIpcAbortError);
      // cancel 必须带的是那条点击的 rpc_id：daemon 才知道要 trip 谁。
      for (let i = 0; i < 40 && !daemon.frames.some((f) => f.frame.method === "cancel"); i++) {
        await new Promise((r) => setTimeout(r, 25));
      }
      const cancel = daemon.frames.find((f) => f.frame.method === "cancel");
      assert.ok(cancel, "没有收到 cancel 帧");
      assert.equal(cancel.frame.params.rpc_id, clicked.id);
    } finally {
      cleanup();
      await daemon.close();
    }
  });

  test("端点读不到 / 连不上 → 传输错误且 sent=false（可安全退回 CLI）", async () => {
    // 没有 daemon.json
    const emptyHome = mkdtempSync(join(tmpdir(), "pageqa-ipc-empty-"));
    process.env.BSK_HOME = emptyHome;
    resetIpcPool();
    assert.equal(readDaemonEndpoint(), null);
    await assert.rejects(
      () => ipcCall("s1", "tool.snapshot", {}, 500),
      (err) => err instanceof BskIpcTransportError && err.sent === false,
    );

    // daemon.json 指向一条不存在的管道
    const deadPipe =
      process.platform === "win32"
        ? `\\\\.\\pipe\\bsk-pageqa-missing-${process.pid}`
        : join(tmpdir(), `bsk-pageqa-missing-${process.pid}.sock`);
    const cleanup = useHome(deadPipe);
    try {
      await assert.rejects(
        () => ipcCall("s1", "tool.snapshot", {}, 500),
        (err) => err instanceof BskIpcTransportError && err.sent === false,
      );
    } finally {
      cleanup();
      rmSync(emptyHome, { recursive: true, force: true });
    }
  });

  test("对面不是 bsk daemon（握手不是 pong）→ 传输错误且 sent=false", async () => {
    const daemon = await startFakeDaemon(() => ({ result: { hello: "not bsk" } }));
    const cleanup = useHome(daemon.pipePath);
    try {
      await assert.rejects(
        () => ipcCall("s1", "tool.snapshot", {}, 1_000),
        (err) => err instanceof BskIpcTransportError && err.sent === false,
      );
    } finally {
      cleanup();
      await daemon.close();
    }
  });
});
