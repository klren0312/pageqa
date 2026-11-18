import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import cp from "node:child_process";
import mod from "node:module";

// 现场（pageqa-2026-11-18.log，21 步的用例跑了 204 轮）：
// - 80 次失败里 67 次是「观察闸门拒绝」（observation_required / strict observation changed）；
// - wait_for 32 次只成 1 次、select_option 10 次全挂 → 模型反复 navigate 重试，白烧 140s。
//
// 这一族失败都发生在调用落到 CDP **之前**，所以只读探针可以安全地 `--unverified` 重放。
// 测的是「自动恢复」这一层：断言最终结论与「真正发出去的 bsk 命令」，而不是内部函数调用。
//
// 用改写 `node:child_process` 的 execFile 代替假 bsk 可执行文件：Windows 的 .cmd 壳会把
// JS 表达式里的 `=>` / `&` 当成重定向，拿它测 evaluate 并不可靠。

/** 假 bsk 的回复表；`calls` 记录真正发出去的命令（用来断言「重放了几次」）。 */
const calls = [];
let obsSeq = 0;
let reply = () => ({ code: 0, stdout: "ok", stderr: "" });

/** 观察闸门拒绝的标准文案（bsk 0.5.0 的 render_error.rs）。 */
const REFUSAL =
  "error: the operation is not permitted on the current target（reason: observation_required）\n" +
  "hint: This action requires an unused strict observation from cooperate sync and nothing was dispatched\n";

before(() => {
  process.env.PAGEQA_BSK_IPC = "0";
  cp.execFile = (file, args, options, callback) => {
    const cb = typeof options === "function" ? options : callback;
    calls.push(args);
    const r = reply(args);
    setImmediate(() => {
      if (r.code === 0) return cb(null, r.stdout, r.stderr);
      cb(
        Object.assign(new Error(`Command failed: bsk ${args.join(" ")}\n${r.stderr}`), {
          code: r.code,
          stdout: r.stdout,
          stderr: r.stderr,
        }),
        r.stdout,
        r.stderr,
      );
    });
    return { kill() {}, on() {} };
  };
  // ESM 的具名导入是内置模块导出对象的快照：改完必须刷新一次，tools.ts 里的
  // `import { execFile }` 才会指向桩。
  mod.syncBuiltinESMExports();
});

const tools = async () => {
  const { createBskTools } = await import("../../dist/bsk/tools.js");
  return createBskTools({ session: "test-session" });
};
const tool = (list, name) => {
  const found = list.find((t) => t.name === name);
  assert.ok(found, `缺少工具 ${name}`);
  return found;
};
const textOf = (result) => (result?.content?.[0]?.text ?? "").toString();

// 现场数据：21 步的用例单独调了 97 次 snapshot，全部紧跟在动作之后——每一次都是
// 「动作 → 一轮 LLM → snapshot → 一轮 LLM」，为的只是拿新 @eN。并进动作结果就少一轮。
const PAGE = (buttons) =>
  [
    "@vom 1",
    "@view 1431x818",
    "@layers 1 focus=L1",
    "L1 page",
    '  RootWebArea "工单管理"',
    ...buttons.map((name, i) => `  @e${i + 1} button "${name}"`),
  ].join("\n");

describe("动作后自动附带可交互元素清单", () => {
  test("click 不传 showPage 也会附清单（默认 auto）", async () => {
    calls.length = 0;
    reply = (args) => {
      if (args[0] === "snapshot") return { code: 0, stdout: PAGE(["搜索", "新建工单"]), stderr: "" };
      return { code: 0, stdout: "click ok", stderr: "" };
    };
    const list = await tools();
    const result = await textOf(await tool(list, "click").execute("1", { target: "button.搜索" }));
    assert.match(result, /动作后的可交互元素/);
    assert.match(result, /@e1/);
    assert.ok(calls.some((c) => c[0] === "snapshot"), "清单必须是一次真实的快照");
  });

  test("showPage: false 时不附，省掉那一次快照", async () => {
    calls.length = 0;
    reply = (args) =>
      args[0] === "snapshot"
        ? { code: 0, stdout: PAGE(["搜索"]), stderr: "" }
        : { code: 0, stdout: "click ok", stderr: "" };
    const list = await tools();
    const result = await textOf(
      await tool(list, "click").execute("2", { target: "button.搜索", showPage: false }),
    );
    assert.doesNotMatch(result, /可交互元素/);
    assert.equal(calls.filter((c) => c[0] === "snapshot").length, 0);
  });

  test("元素太多时只回一句提示，不把上万字符的清单塞进上下文", async () => {
    calls.length = 0;
    const many = Array.from({ length: 300 }, (_, i) => `按钮编号${i}`);
    reply = (args) =>
      args[0] === "snapshot"
        ? { code: 0, stdout: PAGE(many), stderr: "" }
        : { code: 0, stdout: "click ok", stderr: "" };
    const list = await tools();
    const result = await textOf(await tool(list, "click").execute("3", { target: "button.搜索" }));
    assert.match(result, /元素太多/);
    assert.doesNotMatch(result, /按钮编号299/);
  });
});

describe("观察闸门拒绝的只读恢复", () => {
  test("wait_for 的探针被 observation_required 拒掉后，自动以 --unverified 重跑并给出结论", async () => {
    calls.length = 0;
    reply = (args) => {
      if (args[0] !== "evaluate") return { code: 0, stdout: "ok", stderr: "" };
      if (!args.includes("--unverified")) return { code: 1, stdout: "", stderr: REFUSAL };
      return {
        code: 0,
        stdout: JSON.stringify({
          textPresent: true,
          selectorHit: true,
          selectorVisible: true,
          visibleHit: true,
          excerpt: "工单列表",
        }),
        stderr: "",
      };
    };
    const list = await tools();
    const result = await tool(list, "wait_for").execute("1", {
      text: "工单列表",
      timeoutMs: 1000,
    });
    // 修复前：这里直接抛 `Command failed: bsk evaluate …`，模型只能再 navigate 一遍。
    assert.match(textOf(result), /已达成/);
    const probes = calls.filter((c) => c[0] === "evaluate");
    assert.ok(probes.some((c) => !c.includes("--unverified")), "第一次探针必须按原样发");
    assert.ok(probes.some((c) => c.includes("--unverified")), "被拒后必须走纯读通道");
  });

  test("--unverified 也不被认（旧版 bsk）时抛原始报错，不让参数错误顶替真实原因", async () => {
    calls.length = 0;
    reply = (args) => {
      if (args[0] !== "evaluate") return { code: 0, stdout: "ok", stderr: "" };
      if (args.includes("--unverified")) {
        return {
          code: 2,
          stdout: "",
          stderr: "error: unexpected argument '--unverified' found\n",
        };
      }
      return { code: 1, stdout: "", stderr: REFUSAL };
    };
    const list = await tools();
    await assert.rejects(
      () => tool(list, "wait_for").execute("2", { text: "工单列表", timeoutMs: 500 }),
      /observation_required/,
    );
  });

  test("navigate 缺 observation 被拒后，sync 出一份新的再发一次", async () => {
    calls.length = 0;
    reply = (args) => {
      if (args[0] === "cooperate") {
        return { code: 0, stdout: JSON.stringify({ observation_id: `obs-${++obsSeq}` }), stderr: "" };
      }
      if (args[0] === "navigate") {
        return args.includes("--observation")
          ? { code: 0, stdout: "navigate ok", stderr: "" }
          : {
              code: 1,
              stdout: "",
              stderr:
                "error: this action needs an explicit current observation\n" +
                "hint: pass the sync reply's top-level observation_id explicitly with --observation\n",
            };
      }
      return { code: 0, stdout: "ok", stderr: "" };
    };
    const list = await tools();
    const result = await tool(list, "navigate").execute("3", {
      url: "http://localhost/#/ticket",
    });
    assert.equal(textOf(result).startsWith("已导航到"), true);
    const navs = calls.filter((c) => c[0] === "navigate");
    assert.equal(navs.length, 2, "一次被拒 + 一次带新 observation 的重发");
    assert.equal(navs[0].includes("--observation"), false);
    assert.equal(navs[1].includes("--observation"), true);
  });
});

describe("同一动作连续失败的熔断", () => {
  test("第 3 次起附「别再原样重试」，第 6 次直接拒绝执行且不派发", async () => {
    calls.length = 0;
    reply = (args) =>
      args[0] === "click"
        ? {
            code: 1,
            stdout: "",
            stderr: "error: requested resource does not exist | details: selector x did not match any element\n",
          }
        : { code: 0, stdout: "ok", stderr: "" };
    const list = await tools();
    const click = tool(list, "click");

    for (let i = 1; i <= 5; i++) {
      await assert.rejects(() => click.execute(String(i), { target: "button.不存在" }));
    }
    // 第 3 次起的话术里必须出现「换个做法」的指令，而不是又一条一模一样的报错。
    await assert.rejects(
      () => click.execute("6", { target: "button.不存在" }),
      /已经连续失败 5 次，这次没有执行/,
    );
    assert.equal(calls.filter((c) => c[0] === "click").length, 5, "被熔断的那次不能真的发出去");
  });

  test("换个入参属于换路径：计数不串到新目标上", async () => {
    calls.length = 0;
    reply = (args) =>
      args[0] === "click"
        ? {
            code: 1,
            stdout: "",
            stderr: "error: requested resource does not exist | details: selector x did not match any element\n",
          }
        : { code: 0, stdout: "ok", stderr: "" };
    const list = await tools();
    const click = tool(list, "click");
    for (let i = 0; i < 5; i++) {
      await assert.rejects(() => click.execute(String(i), { target: "button.A" }));
    }
    // 同一个工具、另一个入参：不该被上一个目标的计数连坐。
    await assert.rejects(
      () => click.execute("9", { target: "button.B" }),
      (err) => !/这次没有执行/.test(String(err.message)),
    );
    assert.equal(calls.filter((c) => c[0] === "click").length, 6);
  });
});

// 现场（pageqa-2026-11-18.log）：目标 tab 不在 Agent Window 里时，evaluate 在权限闸门就被
// 拒掉，`--unverified` 重放同样被拒（控制权/归属不因它豁免）。那一刻 snapshot 是通的，
// 但文本 wait_for 只有 evaluate 一条路 → 17 次 wait_for 全灭，31 轮没有业务动作落页面。
// 这一族放在文件末尾：降级标记是进程级的，前面那些用「--unverified 能救回来」的用例
// 必须先在它之前跑完。
describe("evaluate 探针被权限闸门彻底拒绝时，文本等待改读快照", () => {
  const refusalAlways = (args) => {
    if (args[0] === "evaluate") return { code: 1, stdout: "", stderr: REFUSAL };
    if (args[0] === "snapshot") return { code: 0, stdout: PAGE(["工单列表"]), stderr: "" };
    return { code: 0, stdout: "ok", stderr: "" };
  };

  test("探针不可用时用快照文本判定，条件仍能被判为达成", async () => {
    calls.length = 0;
    reply = refusalAlways;
    const list = await tools();
    const result = await tool(list, "wait_for").execute("1", {
      text: "工单列表",
      timeoutMs: 1000,
    });
    assert.match(textOf(result), /已达成/);
    assert.ok(calls.some((c) => c[0] === "snapshot"), "必须真的读了一次快照");
  });

  test("记住这个环境之后，下一次文本等待不再先白付一次 evaluate", async () => {
    calls.length = 0;
    reply = refusalAlways;
    const list = await tools();
    const result = await tool(list, "wait_for").execute("2", {
      text: "工单列表",
      timeoutMs: 1000,
    });
    assert.match(textOf(result), /已达成/);
    assert.equal(
      calls.filter((c) => c[0] === "evaluate").length,
      0,
      "降级已记住：不该再拿一条注定被拒的探针去试",
    );
  });

  test("快照里没有这段文字时如实报未达成，并说明本轮是读快照判断的", async () => {
    calls.length = 0;
    reply = (args) => {
      if (args[0] === "snapshot") return { code: 0, stdout: PAGE(["工单列表"]), stderr: "" };
      return { code: 0, stdout: "ok", stderr: "" };
    };
    const list = await tools();
    const result = await tool(list, "wait_for").execute("3", {
      text: "审批通过",
      timeoutMs: 300,
    });
    const text = textOf(result);
    assert.match(text, /未达成/);
    assert.match(text, /读快照判断/);
  });
});

describe("页面文本匹配与探针同口径", () => {
  test("原文 / 归一化空白 / 去掉全部空白，三种写法都算命中", async () => {
    const { textHit } = await import("../../dist/bsk/condition.js");
    assert.equal(textHit("工单列表 共 12 条", "工单列表"), true);
    assert.equal(textHit("工单\n列表", "工单 列表"), true, "换行与空格等价");
    assert.equal(textHit("处理中 10 份", "处理中10份"), true, "节点被拆开也要命中");
    assert.equal(textHit("工单列表", "审批通过"), false);
    assert.equal(textHit("任意文本", ""), false, "空条件不算命中");
  });
});

describe("快照里按可见文本找选项", () => {
  const PAGE_WITH_OPTIONS = (...names) =>
    [
      "@vom 1",
      "@view 1431x818",
      "L1 page",
      '  RootWebArea "工单管理"',
      '  @e3 combobox "工单级别"',
      "  @e9 listbox",
      ...names.map((n, i) => `    @e${10 + i} option "${n}"`),
    ].join("\n");

  test("唯一命中时给出该选项的 @eN", async () => {
    const { findSnapshotRefByText } = await import("../../dist/bsk/tools.js");
    const found = findSnapshotRefByText(PAGE_WITH_OPTIONS("二级", "三级"), "二级");
    assert.equal(found.ref, "@e10");
  });

  test("名字重复时不猜，把候选交回去", async () => {
    const { findSnapshotRefByText } = await import("../../dist/bsk/tools.js");
    const found = findSnapshotRefByText(
      PAGE_WITH_OPTIONS("二级", "二级", "三级"),
      "二级",
    );
    assert.equal(found.ref, null, "两个同名项，点错一个后面全在错的页面上通过");
    assert.deepEqual(found.candidates, ["二级"]);
  });

  test("只放宽到「目标文本 + 角标」，不放宽成包含（「二级」不该命中「二级子公司」）", async () => {
    const { findSnapshotRefByText } = await import("../../dist/bsk/tools.js");
    const found = findSnapshotRefByText(PAGE_WITH_OPTIONS("二级子公司"), "二级");
    assert.equal(found.ref, null);
    assert.deepEqual(found.candidates, ["二级子公司"], "候选里能看出差别在哪");
  });

  test("带计数的选项（「二级 (3)」）仍然匹配得到", async () => {
    const { findSnapshotRefByText } = await import("../../dist/bsk/tools.js");
    const found = findSnapshotRefByText(PAGE_WITH_OPTIONS("二级 (3)", "三级"), "二级");
    assert.equal(found.ref, "@e10");
  });
});

describe("evaluate 探针不可用时，select_option 改走快照定位", () => {
  const OPTION_PAGE = [
    "@vom 1",
    "@view 1431x818",
    "L1 page",
    '  RootWebArea "工单管理"',
    '  @e3 combobox "工单级别"',
    "  @e9 listbox",
    '    @e10 option "二级"',
    '    @e11 option "三级"',
  ].join("\n");

  test("点开控件后在快照里找到唯一选项并点它", async () => {
    reply = (args) => {
      if (args[0] === "evaluate") return { code: 1, stdout: "", stderr: REFUSAL };
      if (args[0] === "snapshot") return { code: 0, stdout: OPTION_PAGE, stderr: "" };
      return { code: 0, stdout: "ok", stderr: "" };
    };
    const list = await tools();
    // 先跑一次文本等待，把「这个环境里 evaluate 不可用」确立下来（与生产同一条判定）。
    await tool(list, "wait_for").execute("0", { text: "工单列表", timeoutMs: 100 });
    // 引用闸门要求先有本会话的快照。
    await tool(list, "snapshot").execute("s", {});
    calls.length = 0;

    const result = await tool(list, "select_option").execute("1", {
      target: "@e3",
      option: "二级",
    });
    const text = textOf(result);
    assert.match(text, /已选择「二级」/);
    assert.ok(
      calls.some((c) => c[0] === "click" && c.includes("@e10")),
      "应当点在快照里定位到的 @e10 上",
    );
    assert.equal(
      calls.filter((c) => c[0] === "evaluate").length,
      0,
      "探针已知不可用，不该再拿一条注定被拒的 evaluate 去试",
    );
  });
});

// 现场（pageqa-2026-11-18.log 第二次运行）：14 次 click 失败里 9 次是 target_covered，
// 而紧接着的那次同样的 click 往往就成功——遮挡是抽屉/浮层收尾时的瞬时状态。
// bsk 的命中测试在派发前，`effect_state: none`，所以「同步 + 重试一次」不会点两次。
describe("点击点被遮挡（target_covered）时自动同步并重试一次", () => {
  const COVERED =
    "error: the operation is not permitted on the current target（reason: target_covered）\n" +
    "hint: The pointer target is covered or unavailable; synchronize before clicking\n";

  test("第一次被遮挡、sync 后重试成功——不把这次失败交给模型", async () => {
    let clicks = 0;
    calls.length = 0;
    reply = (args) => {
      if (args[0] === "snapshot") {
        return { code: 0, stdout: PAGE(["确定"]), stderr: "" };
      }
      if (args[0] === "click") {
        clicks += 1;
        return clicks === 1
          ? { code: 1, stdout: "", stderr: COVERED }
          : { code: 0, stdout: "click ok", stderr: "" };
      }
      return { code: 0, stdout: "ok", stderr: "" };
    };
    const list = await tools();
    const text = textOf(await tool(list, "click").execute("1", { target: "button.确定" }));
    assert.equal(clicks, 2, "被遮挡后应当只重试一次");
    assert.match(text, /click ok/);
  });

  test("仍被遮挡时不无限重试，把失败交回上层", async () => {
    calls.length = 0;
    reply = (args) => {
      if (args[0] === "snapshot") {
        return { code: 0, stdout: PAGE(["确定"]), stderr: "" };
      }
      if (args[0] === "click") return { code: 1, stdout: "", stderr: COVERED };
      return { code: 0, stdout: "ok", stderr: "" };
    };
    const list = await tools();
    await assert.rejects(
      () => tool(list, "click").execute("1", { target: "button.确定" }),
      /target_covered/i,
    );
    assert.equal(
      calls.filter((c) => c[0] === "click").length,
      2,
      "最多只重试一次，不能自旋",
    );
  });

  test("IPC 结构化 reason 与 CLI 文本两条路都认得出来", async () => {
    const { isCoveredTargetError } = await import("../../dist/bsk/tools.js");
    const byText = new Error(COVERED);
    assert.equal(isCoveredTargetError(byText), true, "CLI 路径只能看文案");
    const byData = Object.assign(new Error("error: something"), {
      bskData: { reason: "target_covered" },
    });
    assert.equal(isCoveredTargetError(byData), true, "IPC 路径看结构化 reason");
    assert.equal(isCoveredTargetError(new Error("error: nope")), false);
  });
});

// `reference context expired` 与 `observation_required` 由 render_error.rs 的同一个权限分支
// 渲染，都在**落到 CDP 之前**返回。原来只给前者 sync、不重放，模型只能自己「失败 →
// snapshot → 再点」，白付两轮往返；现场这类失败 ~10 次。
describe("控制上下文失效（未派发）时自动 sync 并重发一次", () => {
  const EXPIRED =
    "error: the page changed under the action; the reference context expired\n" +
    "hint: synchronize the session, then re-snapshot before retrying\n" +
    "details: This action requires a valid control context from cooperate sync\n";

  test("第一次失效、sync 后重发成功", async () => {
    let clicks = 0;
    calls.length = 0;
    reply = (args) => {
      if (args[0] === "snapshot") {
        return { code: 0, stdout: PAGE(["确定"]), stderr: "" };
      }
      if (args[0] === "click") {
        clicks += 1;
        return clicks === 1
          ? { code: 1, stdout: "", stderr: EXPIRED }
          : { code: 0, stdout: "click ok", stderr: "" };
      }
      return { code: 0, stdout: "ok", stderr: "" };
    };
    const list = await tools();
    const text = textOf(await tool(list, "click").execute("1", { target: "button.确定" }));
    assert.equal(clicks, 2, "应当 sync 之后重发一次");
    assert.match(text, /click ok/);
  });

  test("重发仍失效时不自旋，把失败交回", async () => {
    calls.length = 0;
    reply = (args) => {
      if (args[0] === "snapshot") {
        return { code: 0, stdout: PAGE(["确定"]), stderr: "" };
      }
      if (args[0] === "click") return { code: 1, stdout: "", stderr: EXPIRED };
      return { code: 0, stdout: "ok", stderr: "" };
    };
    const list = await tools();
    await assert.rejects(
      () => tool(list, "click").execute("1", { target: "button.确定" }),
      /reference context expired/i,
    );
    assert.equal(calls.filter((c) => c[0] === "click").length, 2, "最多重发一次");
  });
});

// 现场（pageqa-2026-11-18.log 第二次运行的前 21 轮）：navigate 同一 URL 成功 5 次、
// wait_for 6 次、snapshot 4 次，**全部成功**，于是失败熔断一次都没触发，52 秒耗在
// 「原地确认页面」上。成功重复需要单独一道闸。
describe("同一动作连续成功多次时拦住原地打转", () => {
  test("同一动作第 4 次不再执行", async () => {
    calls.length = 0;
    reply = (args) =>
      args[0] === "snapshot"
        ? { code: 0, stdout: PAGE(["确定"]), stderr: "" }
        : { code: 0, stdout: "click ok", stderr: "" };
    const list = await tools();
    const click = tool(list, "click");
    for (let i = 0; i < 3; i += 1) {
      await click.execute(`${i}`, { target: "button.确定", showPage: false });
    }
    const before = calls.filter((c) => c[0] === "click").length;
    await assert.rejects(
      () => click.execute("4", { target: "button.确定", showPage: false }),
      /连续成功|already succeeded/i,
    );
    assert.equal(
      calls.filter((c) => c[0] === "click").length,
      before,
      "被拦下的那次不该真的发出去",
    );
  });

  test("只读工具多看几眼不算打转", async () => {
    reply = (args) =>
      args[0] === "snapshot"
        ? { code: 0, stdout: PAGE(["搜索"]), stderr: "" }
        : { code: 0, stdout: "ok", stderr: "" };
    const list = await tools();
    const snapshot = tool(list, "snapshot");
    for (let i = 0; i < 5; i += 1) {
      await snapshot.execute(`${i}`, {});
    }
  });
});