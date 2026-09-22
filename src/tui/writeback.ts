/**
 * 追加场景写回源用例文件。
 *
 * 交互模式下用户提交的输入不是「只存在于本次运行的临时片段」——它是要留下的用例。
 * 因此提交即落盘（`appendFile`）：
 * - 敲下来的就是用户想留下的东西，与「随手记一条待办」同理；
 * - 若等场景跑完才写，Ctrl+C 或崩溃会把整条待办队列丢掉，而「不想丢掉想跑的用例」
 *   正是交互模式存在的理由；
 * - 回放脚本的 `source.hash` 也据此覆盖全部场景（见 ADR-0002 决策七）。
 */
import { appendFileSync, readFileSync } from "node:fs";
import { splitScenarios } from "../agent.js";

/** 一段待写回的场景。 */
export interface CaseScenario {
  name: string;
  body: string;
}

/** 场景名退回首行摘要时的最大长度。 */
const NAME_MAX = 40;

/**
 * 把一段用户输入拆成场景。
 *
 * 用户写了 `## 标题` 就用它（与用例文件的写法完全一致）；没写才退回首行摘要。
 * 这条不是措辞问题：标题会被永久写进用户的用例文件，而「文件里的标题由文件的主人
 * 决定」是 `examples/*.md` 一直遵守的规则（见 ADR-0002 决策七）。
 */
export function scenariosFromInput(text: string): CaseScenario[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const scenarios = splitScenarios(trimmed);
  if (/^##\s+/m.test(trimmed)) return scenarios;
  // 没有 `## ` 时 splitScenarios 会统一给「场景 1」，这里换成首行摘要
  return scenarios.map((s) => ({ ...s, name: scenarioNameFromBody(s.body) }));
}

/** 没写标题时的场景名：取首个非空行，过长则截断。 */
export function scenarioNameFromBody(body: string, max = NAME_MAX): string {
  const first =
    body
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "追加场景";
  return first.length > max ? first.slice(0, max) + "…" : first;
}

/**
 * 把一个场景追加到源用例文件末尾，返回实际写入的文本。
 *
 * 纯 append、不重写整个文件：用户可能同时在编辑器里开着它，重写的破坏面大得多。
 * 写什么就是用户写的什么（含 `${timestamp}` 占位符），绝不写展开后的具体值——
 * 否则下次运行必撞名，等于把一次性用例写进文件。
 */
export function appendScenarioToCaseFile(
  path: string,
  scenario: CaseScenario,
): string {
  const existing = readFileSync(path, "utf8");
  // 与 splitScenarios 的分隔规则对齐：场景之间留一个空行，文件末尾补换行。
  const sep = existing.length === 0 ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
  const block = `${sep}## ${scenario.name}\n\n${scenario.body.trim()}\n`;
  appendFileSync(path, block, "utf8");
  return block;
}
