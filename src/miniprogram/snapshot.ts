import { getCurrentPage } from "./connection.js";

/** 已知基础组件标签：automator 不支持通配选择器，只能按标签枚举。 */
export const KNOWN_TAGS = [
  "view",
  "text",
  "button",
  "input",
  "textarea",
  "image",
  "navigator",
  "scroll-view",
  "swiper",
  "switch",
  "slider",
  "picker",
  "picker-view",
  "label",
  "form",
  "checkbox",
  "radio",
  "icon",
  "progress",
  "rich-text",
  "video",
  "audio",
  "map",
  "web-view",
  "block",
  "cover-view",
  "cover-image",
];

function sanitizeRole(tag: string | undefined): string {
  const t = (tag ?? "unknown").toLowerCase();
  return /^[a-z][a-z0-9-]*$/.test(t) ? t : "unknown";
}

function quoteName(name: string): string {
  return JSON.stringify(name);
}

export interface BuiltSnapshot {
  /** 与 bsk 同形的快照文本：每行 `@eN <role> "<name>"`。 */
  text: string;
  /** 与 `@eN` 一一对应的元素句柄（handles[i] = @e(i+1)）。 */
  handles: unknown[];
}

/**
 * 把小程序 WXML 视图树合成成与桌面浏览器同形的快照文本。
 *
 * role=组件类型、name=文本 / placeholder / id（按顺序回退）。`locator.ts` 据此按
 * `role + name + 同名序号` 重解析，故格式必须与 bsk 快照一致——这是「零改动接入」的根基。
 *
 * automator 不支持通配选择器，因此按已知标签分别 `page.$$(tag)` 取全页元素再按句柄去重，
 * 得到一份**扁平**清单（无层级缩进）。扁平快照足以支撑 `role+name+序号` 定位与 `assert_text`，
 * 只是祖先路径消歧会退化为序号（见 ADR-0020）。不在 `KNOWN_TAGS` 内的自定义组件不会被枚举，
 * 属已知 MVP 限制。
 */
export async function buildRawSnapshot(): Promise<BuiltSnapshot> {
  const page = await getCurrentPage();
  const seen = new Set<unknown>();
  const lines: string[] = [];
  const handles: unknown[] = [];
  for (const tag of KNOWN_TAGS) {
    let found: unknown[] = [];
    try {
      found = (await page.$$(tag)) as unknown[];
    } catch {
      continue;
    }
    if (!Array.isArray(found)) continue;
    for (const el of found) {
      if (!el || seen.has(el)) continue;
      seen.add(el);
      const e = el as any;
      const role = sanitizeRole(
        typeof e.tagName === "string" ? e.tagName : undefined,
      );
      let name = "";
      try {
        name = (await e.text?.()) ?? "";
      } catch {
        /* ignore */
      }
      if (!name) {
        try {
          const ph = await e.attribute?.("placeholder");
          if (ph) name = String(ph);
        } catch {
          /* ignore */
        }
      }
      if (!name) {
        try {
          const id = await e.attribute?.("id");
          if (id) name = `#${id}`;
        } catch {
          /* ignore */
        }
      }
      handles.push(el);
      lines.push(`@e${handles.length} ${role} ${quoteName(name)}`);
    }
  }
  return { text: lines.join("\n"), handles };
}
