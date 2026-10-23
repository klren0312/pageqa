import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { BskToolExec } from "../bsk/tools.js";
import { createMiniprogramOps } from "./ops.js";

function ok(text: string) {
  return { content: [{ type: "text", text } as const], details: {} };
}

function paramsOf(
  properties: Record<string, unknown>,
  required: string[] = [],
): AgentTool["parameters"] {
  return { type: "object", properties, required } as AgentTool["parameters"];
}

export interface MiniprogramToolOptions {
  session: string;
  jevClient?: unknown;
  snapshotBudgetChars?: number | (() => number | undefined);
  onExec?: (event: BskToolExec) => void;
}

/**
 * 小程序模式的工具集：只暴露有对应物的 7 个工具（navigate / snapshot / click / fill /
 * assert_text / screenshot / get_html）。未注册的 9 个动作模型根本看不到，避免假失败。
 *
 * 录制接线与 bsk 完全一致：每条工具调用都经 `exec` → `onExec` 写回 ReplayStep，
 * 因此小程序跑出来的用例同样能零模型回放（见 ADR-0020）。
 */
export function createMiniprogramTools(opts: MiniprogramToolOptions): AgentTool[] {
  const ops = createMiniprogramOps(opts.session, {
    jevClient: opts.jevClient,
    snapshotBudgetChars: opts.snapshotBudgetChars,
  });
  const ASSERTION_TOOLS = new Set(["assert_text", "assert_no_console_error"]);

  const exec = async (
    name: string,
    params: Record<string, unknown>,
    fn: (signal?: AbortSignal) => Promise<string>,
    signal?: AbortSignal,
  ): Promise<ReturnType<typeof ok>> => {
    const before = ops.lastSnapshot();
    try {
      const text = await fn(signal);
      const assertion = ASSERTION_TOOLS.has(name) ? ops.lastAssert() : null;
      opts.onExec?.({
        name,
        params,
        ok: true,
        lastSnapshot: before,
        ...(name === "assert_text" ? { semantic: ops.lastAssertSemantic() } : {}),
        ...(assertion ? { assert: assertion } : {}),
      });
      return ok(text);
    } catch (err) {
      opts.onExec?.({ name, params, ok: false, lastSnapshot: before });
      throw err;
    }
  };

  const navigate: AgentTool = {
    name: "navigate",
    label: "Navigate",
    description:
      "在小程序里打开一个页面路由（形如 mp://pages/index/index，可带 ?query）。导航完成后页面就绪。",
    parameters: paramsOf(
      { url: { type: "string", description: "目标页面路由（mp:// 开头）" } },
      ["url"],
    ),
    execute: async (_id, params, signal) => {
      const p = params as { url: string };
      return exec("navigate", { url: p.url }, (s) => ops.navigate(p.url, s), signal);
    },
  };

  const snapshot: AgentTool = {
    name: "snapshot",
    label: "Snapshot",
    description:
      "给小程序页面拍快照，列出所有可见元素（角色 + 文本 + @eN 编号），供后续 click/fill 定位。每次操作后建议重新 snapshot。",
    parameters: paramsOf({}),
    execute: async (_id, _params, signal) =>
      exec("snapshot", {}, (s) => ops.snapshot(s), signal),
  };

  const click: AgentTool = {
    name: "click",
    label: "Click",
    description: "点击小程序元素。target 用快照里的 @eN 编号，或 view/text/button 等选择器。",
    parameters: paramsOf(
      { target: { type: "string", description: "@eN 编号或选择器" } },
      ["target"],
    ),
    execute: async (_id, params, signal) => {
      const p = params as { target: string };
      return exec("click", { target: p.target }, (s) => ops.click(p.target, s), signal);
    },
  };

  const fill: AgentTool = {
    name: "fill",
    label: "Fill",
    description: "在小程序的输入框（input / textarea）里填入文本。target 用 @eN 编号或选择器。",
    parameters: paramsOf(
      {
        target: { type: "string", description: "@eN 编号或选择器" },
        value: { type: "string", description: "要填入的文本" },
      },
      ["target", "value"],
    ),
    execute: async (_id, params, signal) => {
      const p = params as { target: string; value: string };
      return exec(
        "fill",
        { target: p.target, value: p.value },
        (s) => ops.fill(p.target, p.value, s),
        signal,
      );
    },
  };

  const assertText: AgentTool = {
    name: "assert_text",
    label: "Assert Text",
    description: "断言当前小程序页面包含某段文案（absent=true 表示断言不包含）。",
    parameters: paramsOf(
      {
        expectation: { type: "string", description: "期望出现（或不存在）的文案" },
        absent: { type: "boolean", description: "为 true 时断言页面不包含该文案" },
      },
      ["expectation"],
    ),
    execute: async (_id, params, signal) => {
      const p = params as { expectation: string; absent?: boolean };
      return exec(
        "assert_text",
        { expectation: p.expectation, absent: p.absent },
        (s) => ops.assertText(p.expectation, { absent: p.absent }, s),
        signal,
      );
    },
  };

  const screenshot: AgentTool = {
    name: "screenshot",
    label: "Screenshot",
    description: "给当前小程序页面截图（落盘，供报告查看）。",
    parameters: paramsOf({}),
    execute: async (_id, _params, signal) =>
      exec("screenshot", {}, (s) => ops.screenshot({}, s), signal),
  };

  const getHtml: AgentTool = {
    name: "get_html",
    label: "Get HTML",
    description: "读某个小程序元素的 WXML（模板源码）。target 用 @eN 编号或选择器。",
    parameters: paramsOf(
      { target: { type: "string", description: "@eN 编号或选择器" } },
      ["target"],
    ),
    execute: async (_id, params, signal) => {
      const p = params as { target: string };
      return exec(
        "get_html",
        { target: p.target },
        (s) => ops.getHtml({ target: p.target }, s),
        signal,
      );
    },
  };

  return [navigate, snapshot, click, fill, assertText, screenshot, getHtml];
}
