/**
 * 版本号：从包根的 `package.json` 读，供 `--version` 与 `/setting` 面板显示。
 *
 * 读的是相对本模块的 `../package.json`（`dist/version.js` → 包根），发布后的包里同样成立
 * ——package.json 一定随包分发，`files` 只约束额外目录。读过一次就缓存：调用点都在启动、
 * 打开面板这类低频路径上，没必要每次碰盘。
 */
import { readFileSync } from "node:fs";

let cached: string | undefined;

/** 当前版本号；读不到时回落到 `unknown`（版本号是展示信息，不该让它把启动搞崩）。 */
export function packageVersion(): string {
  if (cached !== undefined) return cached;
  try {
    const raw = readFileSync(
      new URL("../package.json", import.meta.url),
      "utf8",
    );
    const parsed = JSON.parse(raw) as { version?: unknown };
    cached = typeof parsed.version === "string" ? parsed.version : "unknown";
  } catch {
    cached = "unknown";
  }
  return cached;
}
