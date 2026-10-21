/**
 * 「优先回放」：同名的回放脚本仍然对应当前用例文件时，直接用零模型回放。
 *
 * 只认四项全满足的脚本：
 * 1. 脚本文件存在且结构合法（`loadReplayScript` 会逐步校验）；
 * 2. 脚本记录了源路径与源哈希（手工拼的/内联文本生成的脚本没有可比对的依据）；
 * 3. 源路径就是当前用例文件（防止把另一个用例的脚本套过来）；
 * 4. 源哈希与当前文件一致（用例文案改过就回退现场运行）。
 *
 * 任何一项不满足都返回 `skip` 并说明原因，由调用方回退现场运行——自动回放
 * 宁可少省一次模型，也不能拿旧脚本冒充这次用例的结果。
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { t } from "../shared/i18n.js";
import {
  loadReplayScript,
  sourceDriftNotice,
  type ReplayScript,
} from "./replay.js";

export type ReplayPreference =
  | { kind: "use"; path: string; script: ReplayScript }
  | { kind: "skip"; reason: string };

export function findFreshReplay(
  casePath: string,
  scriptPath: string,
): ReplayPreference {
  if (!existsSync(scriptPath)) {
    return { kind: "skip", reason: t("replay.prefer.noScript") };
  }
  let script: ReplayScript;
  try {
    script = loadReplayScript(scriptPath);
  } catch (err) {
    return { kind: "skip", reason: err instanceof Error ? err.message : String(err) };
  }
  const { path, hash } = script.source;
  if (!path || !hash) {
    return { kind: "skip", reason: t("replay.prefer.noHash") };
  }
  if (resolve(path) !== resolve(casePath)) {
    return { kind: "skip", reason: t("replay.prefer.otherSource") };
  }
  const drift = sourceDriftNotice(script);
  if (drift) return { kind: "skip", reason: drift };
  return { kind: "use", path: scriptPath, script };
}
