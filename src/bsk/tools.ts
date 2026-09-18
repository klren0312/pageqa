import { execFileSync } from "node:child_process";
import type { AgentTool } from "@earendil-works/pi-agent-core";

/**
 * browserskill（`bsk`）工具层：把 bsk CLI 命令包装成 pi-agent-core 的 AgentTool。
 *
 * bsk 连接一个已运行的真实浏览器，每个命令都需要 --session <id>。
 * 所有命令以 --quiet 抑制进度输出，仅返回结构化/可读结果。
 */

function bsk(args: string[]): string {
  return execFileSync("bsk", args, { encoding: "utf-8" }).toString();
}

/** 构造 AgentTool 标准的成功返回（含必填 details 字段）。 */
function ok(text: string) {
  return { content: [{ type: "text", text } as const], details: {} };
}

export interface BskToolOptions {
  session: string;
}

interface NavParams { url: string }
interface TargetParams { target: string }
interface FillParams { target: string; value: string }
interface WaitParams { ms?: number }
interface ExpectParams { expectation: string }

/** 构造一组浏览器操作工具，供 page-test agent 调用。 */
export function createBskTools(opts: BskToolOptions): AgentTool[] {
  const s = opts.session;
  const quiet = ["--session", s, "--quiet"];

  const navigate: AgentTool = {
    name: "navigate",
    label: "Navigate",
    description: "在浏览器标签页打开一个 URL（支持 http/https/about: 等）。导航完成后页面 DOM 就绪。",
    parameters: {
      type: "object",
      properties: { url: { type: "string", description: "目标 URL" } },
      required: ["url"],
    } as unknown as AgentTool["parameters"],
    execute: async (_id: string, params: unknown) => {
      const p = params as NavParams;
      const out = bsk(["navigate", p.url, ...quiet, "--wait-until", "domcontentloaded"]);
      return ok(`已导航到 ${p.url}\n${out}`);
    },
  };

  const snapshot: AgentTool = {
    name: "snapshot",
    label: "Snapshot",
    description: "读取当前页面的 aria 语义树与可见文本（标题、段落、链接、按钮等）。用于读取内容、标题、文本并定位元素。",
    parameters: { type: "object", properties: {} } as unknown as AgentTool["parameters"],
    execute: async () => ok(bsk(["snapshot", ...quiet])),
  };

  const click: AgentTool = {
    name: "click",
    label: "Click",
    description: "点击一个元素。可用快照里的 @eN 引用或 CSS 选择器。",
    parameters: {
      type: "object",
      properties: { target: { type: "string", description: "@eN 引用或 CSS 选择器" } },
      required: ["target"],
    } as unknown as AgentTool["parameters"],
    execute: async (_id: string, params: unknown) => {
      const p = params as TargetParams;
      const out = bsk(["click", p.target, ...quiet]);
      return ok(`已点击 ${p.target}\n${out}`);
    },
  };

  const fill: AgentTool = {
    name: "fill",
    label: "Fill",
    description: "在输入框/文本域中填入文本（会先清空原有内容）。",
    parameters: {
      type: "object",
      properties: {
        target: { type: "string", description: "@eN 引用或 CSS 选择器" },
        value: { type: "string", description: "要输入的文本" },
      },
      required: ["target", "value"],
    } as unknown as AgentTool["parameters"],
    execute: async (_id: string, params: unknown) => {
      const p = params as FillParams;
      const out = bsk(["fill", p.target, "--value", p.value, ...quiet]);
      return ok(`已在 ${p.target} 填入文本\n${out}`);
    },
  };

  const hover: AgentTool = {
    name: "hover",
    label: "Hover",
    description: "悬停在一个元素上，用于触发悬停菜单/提示。",
    parameters: {
      type: "object",
      properties: { target: { type: "string", description: "@eN 引用或 CSS 选择器" } },
      required: ["target"],
    } as unknown as AgentTool["parameters"],
    execute: async (_id: string, params: unknown) => {
      const p = params as TargetParams;
      const out = bsk(["hover", p.target, ...quiet]);
      return ok(`已悬停 ${p.target}\n${out}`);
    },
  };

  const scroll: AgentTool = {
    name: "scroll",
    label: "Scroll",
    description: "滚动到指定元素使其进入视口。",
    parameters: {
      type: "object",
      properties: { target: { type: "string", description: "@eN 引用或 CSS 选择器" } },
      required: ["target"],
    } as unknown as AgentTool["parameters"],
    execute: async (_id: string, params: unknown) => {
      const p = params as TargetParams;
      const js = `(() => { const el = document.querySelector(${JSON.stringify(p.target)}); if (el) el.scrollIntoView({block:'center'}); return el ? 'scrolled' : 'element-not-found'; })()`;
      const res = bsk(["evaluate", js, ...quiet]);
      return ok(res);
    },
  };

  const wait: AgentTool = {
    name: "wait",
    label: "Wait",
    description: "等待一段时间（毫秒）或等待页面导航完成。",
    parameters: {
      type: "object",
      properties: { ms: { type: "number", description: "等待毫秒数" } },
      required: [],
    } as unknown as AgentTool["parameters"],
    execute: async (_id: string, params: unknown) => {
      const p = (params as WaitParams) ?? {};
      const ms = p.ms ?? 1000;
      // wait-ms 是 daemon 端 sleep，不接受 --session
      bsk(["wait-ms", String(ms)]);
      return ok(`已等待 ${ms}ms`);
    },
  };

  const assertText: AgentTool = {
    name: "assert_text",
    label: "Assert Text",
    description: "断言当前页面是否包含指定文本。返回「成立」或「不成立」并附上证据（命中片段）。用于校验测试结果。",
    parameters: {
      type: "object",
      properties: { expectation: { type: "string", description: "期望在页面中出现的文本" } },
      required: ["expectation"],
    } as unknown as AgentTool["parameters"],
    execute: async (_id: string, params: unknown) => {
      const p = params as ExpectParams;
      const snap = bsk(["snapshot", ...quiet]);
      const hit = snap.includes(p.expectation);
      const verdict = hit ? "成立" : "不成立";
      const evidence = hit ? `页面中包含「${p.expectation}」` : `页面中未找到「${p.expectation}」`;
      return ok(`断言「${p.expectation}」：${verdict}。${evidence}`);
    },
  };

  return [navigate, snapshot, click, fill, hover, scroll, wait, assertText];
}

/** 创建一个 bsk session；若已提供且仍在活跃列表中则复用，否则新建。 */
export function ensureSession(existing?: string): string {
  if (existing && isActiveSession(existing)) return existing;
  const out = bsk(["session", "start", "--json"]);
  try {
    const json = JSON.parse(out);
    if (json?.session_id) return json.session_id;
  } catch {
    const m = out.match(/session_id["\s:]+([a-z0-9]+)/i);
    if (m) return m[1];
  }
  throw new Error("无法创建 bsk session，请确认 bsk daemon 已连接浏览器。");
}

/** 检查给定 session 是否在 bsk 活跃列表里。 */
function isActiveSession(id: string): boolean {
  try {
    const out = bsk(["session", "list", "--json"]);
    const list = JSON.parse(out);
    if (Array.isArray(list)) return list.some((s) => s?.session_id === id);
  } catch {
    // 忽略解析错误
  }
  return false;
}
