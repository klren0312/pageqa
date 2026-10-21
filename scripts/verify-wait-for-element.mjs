/**
 * 真机验证：pageqa 的 wait_for 现在走 bsk wait-for-element（元素类条件）。
 *
 * 覆盖三件事，都是「单测证明不了」的：
 *   1. selector / gone / state 三个条件在真页面上给出正确结论（含 attached / visible 证据）；
 *   2. 元素类条件真的走了原生命令（走不通会静默退回探针：结论一样、收益消失，
 *      所以用 debug 日志里的「原生等待」行来确认，而不是只看返回值）；
 *   3. 关掉原生等待（等价于旧版 bsk 没有这条命令）时结论不变、证据措辞一致。
 *
 * 第 3 项用产品自带的 `PAGEQA_BSK_WAIT_FOR_ELEMENT=0` 开关，**不用假 bsk shim**：
 * Windows 上 execFile 只按 CreateProcess 的规则解析 .exe，放在 PATH 前面的 bsk.cmd
 * 根本不会被命中——那样写出来的「通过」是假的（本脚本初版就踩过这个坑）。
 *
 * 用法：先 `npm run serve:smoke`（18888 端口）或指定 QA_PAGE。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

const PAGE = process.env.QA_PAGE ?? "http://127.0.0.1:18889/smoke-test-page";
const { createBskOps, ensureBskReady, ensureSession, closeSession } = await import(
  "../dist/bsk/tools.js"
);
const { setDebug, setSink } = await import("../dist/shared/log.js");

// 打开 debug 日志：要证明的是「真的走了原生等待 / 真的退回了探针」，
// 而这两件事从返回值上看不出来（结论一样、只有耗时与往返次数不同）。
// sink 换成收集器，同时照旧打到终端。
const debugLines = [];
const terminalSink = (line) => process.stderr.write(line + "\n");
setDebug(true);
setSink((line) => {
  debugLines.push(line);
  terminalSink(line);
});

/** 往页面里注入一段准备代码（BskOps 不暴露 evaluate，这里直接调 bsk）。 */
const evaluate = async (session, expression) => {
  const { stdout } = await run("bsk", ["evaluate", expression, "--session", session, "--quiet"]);
  return stdout;
};

let pass = 0;
const check = (name, ok, detail = "") => {
  if (ok) {
    pass += 1;
    console.log(`PASS  ${name}   ${detail}`);
  } else {
    console.log(`FAIL  ${name}   ${detail}`);
    process.exitCode = 1;
  }
};

await ensureBskReady();
const session = await ensureSession();
const ops = createBskOps(session);
try {
  await ops.navigate(PAGE);

  // T1 selector 默认等可见：页面上真可见的元素立刻满足
  // （注意 #name 在默认隐藏的 route 区块里——bsk 判它「命中但不可见」是对的）
  let out = await ops.waitFor({ selector: "#home h1" }, 5_000);
  check("T1 selector 可见元素立即满足", /已达成/.test(out), out);
  check(
    "T1 走的是原生等待（日志里有「原生等待」）",
    /原生等待/.test(debugLines.join("\n")),
  );

  // T2 在 DOM 但不可见：visible 超时，且证据把两个事实分开写
  await evaluate(
    session,
    `(() => {
      var d = document.createElement("div");
      d.id = "qa-hidden"; d.style.display = "none"; document.body.appendChild(d);
      return "ok";
    })()`,
  );
  out = await ops.waitFor({ selector: "#qa-hidden" }, 1_500);
  check(
    "T2 在但不可见：未达成且证据分开写",
    /未达成/.test(out) && /末次探测：还在 DOM=true，可见=false/.test(out),
    out,
  );

  // T3 state=attached 对同一个元素立刻满足（不要求可见）
  out = await ops.waitFor({ selector: "#qa-hidden", state: "attached" }, 1_500);
  check("T3 state=attached 对隐藏元素也满足", /已达成/.test(out), out);

  // T4 gone（= hidden）：v-show 隐藏的遮罩也算消失
  await evaluate(
    session,
    `(() => {
      var m = document.createElement("div");
      m.id = "qa-mask"; m.textContent = "loading";
      document.body.appendChild(m);
      setTimeout(function () { m.style.display = "none"; }, 500);
      return "ok";
    })()`,
  );
  out = await ops.waitFor({ gone: "#qa-mask" }, 5_000);
  check("T4 gone 等到遮罩隐藏（不必离开 DOM）", /已达成/.test(out), out);

  // T5 state=detached 要求真离开 DOM：被隐藏的元素不该满足
  out = await ops.waitFor({ selector: "#qa-mask", state: "detached" }, 1_200);
  check(
    "T5 state=detached 不把「隐藏」当「移除」",
    /未达成/.test(out) && /末次探测：还在 DOM=true/.test(out),
    out,
  );

  // T6 文本条件仍走页面侧探针（bsk 表达不了），结论照旧
  out = await ops.waitFor({ text: "冒烟测试页面" }, 5_000);
  check("T6 文本条件（探针路径）", /已达成/.test(out), out);
} finally {
  await closeSession(session);
}

// T7 降级路径：强制不用原生等待，结论与证据措辞都必须一致。
process.env.PAGEQA_BSK_WAIT_FOR_ELEMENT = "0";
try {
  const session2 = await ensureSession();
  const ops2 = createBskOps(session2);
  try {
    await ops2.navigate(PAGE);
    const before = debugLines.length;
    const out2 = await ops2.waitFor({ selector: "#home h1" }, 5_000);
    check("T7 关掉原生等待后仍能等到（结论一致）", /已达成/.test(out2), out2);
    const probeLines = debugLines.slice(before).join("\n");
    check(
      "T7 确实走了探针（无「原生等待」行，有探针计数）",
      !/原生等待/.test(probeLines) && /探针 \d+ 次/.test(probeLines),
      probeLines
        .split("\n")
        .find((l) => l.includes("wait_for") && l.includes("已达成")) ?? "",
    );
    // 新 session 是全新页面：探针路径要验的那条证据需要一个「在 DOM 但不可见」的元素，
    // 得在**这个**页面里重新注入（第一段的 #qa-hidden 只存在于上一个 session 的页面）。
    await evaluate(
      session2,
      `(() => {
        var d = document.createElement("div");
        d.id = "qa-hidden"; d.style.display = "none"; document.body.appendChild(d);
        return "ok";
      })()`,
    );
    const hidden = await ops2.waitFor({ selector: "#qa-hidden" }, 1_200);
    check(
      "T7 探针路径的证据措辞与原生一致",
      /未达成/.test(hidden) && /末次探测：还在 DOM=true，可见=false/.test(hidden),
      hidden,
    );
    const gone2 = await ops2.waitFor({ gone: "#qa-nope" }, 3_000);
    check("T7 gone 也走探针", /已达成/.test(gone2), gone2);
  } finally {
    await closeSession(session2);
  }
} finally {
  delete process.env.PAGEQA_BSK_WAIT_FOR_ELEMENT;
}

console.log(`\n结果: ${pass} 项通过`);
