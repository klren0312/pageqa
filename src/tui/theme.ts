/**
 * 交互界面的配色。
 *
 * pi-tui **不导出任何默认主题对象**（`EditorTheme`/`MarkdownTheme`/`SelectListTheme`
 * 都只有类型），因此必须自持一份。
 *
 * 默认只用 16 色：它们在所有终端上都有定义；只有当 `COLORTERM` 明确声明 truecolor
 * 时才升级到 24 位色。`NO_COLOR` / `TERM=dumb` 时完全不着色（仍然可读）。
 */
import type { EditorTheme } from "@earendil-works/pi-tui";

const trueColor = /truecolor|24bit/i.test(process.env.COLORTERM ?? "");
const colored =
  process.env.NO_COLOR === undefined && process.env.TERM !== "dumb";

/** 构造一个着色函数：16 色码 + 可选的真彩色替代。 */
function style(
  basic: string,
  rgb?: [number, number, number],
): (text: string) => string {
  return (text: string): string => {
    if (!colored) return text;
    const code =
      trueColor && rgb ? `38;2;${rgb[0]};${rgb[1]};${rgb[2]}` : basic;
    return `\x1b[${code}m${text}\x1b[0m`;
  };
}

export const dim = style("90", [138, 138, 148]);
export const accent = style("36", [86, 182, 255]);
export const title = style("1;36", [96, 196, 255]);
export const bold = style("1");
export const ok = style("32", [106, 190, 120]);
export const warn = style("33", [222, 184, 92]);
export const err = style("31", [228, 108, 108]);

/** 编辑器的边框与自动补全列表配色。 */
export const editorTheme: EditorTheme = {
  borderColor: dim,
  selectList: {
    selectedPrefix: accent,
    selectedText: title,
    description: dim,
    scrollInfo: dim,
    noMatch: dim,
  },
};
