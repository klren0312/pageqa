/**
 * 用例正文 → 场景序列（按 `## ` 二级标题分隔）。
 *
 * 为什么单独一个模块：这是**纯文本切分**，却长期住在 `agent/agent.ts` 里——而后者一被
 * import 就会连带拉起 pi-agent-core 与 pi-ai（实测 1026 个模块，慢盘上要好几秒）。
 * 交互模式的启动路径（`tui/app.ts`、`tui/writeback.ts`）只需要这份切分，不需要整个
 * agent：把它摘出来，首帧就不必为一次 `split()` 付整棵 agent 模块图的加载开销。
 *
 * 行为与拆分前逐字一致（同一份实现，`agent/agent.ts` 原样 re-export，调用点不用改）。
 */
import { splitFrontmatter } from "./case-meta.js";
import { t } from "./i18n.js";

/** 一个场景：`## ` 标题 + 其下的步骤正文。 */
export interface Scenario {
  name: string;
  body: string;
}

/** 把一个脚本拆分为多个场景（按 `## ` 二级标题分隔）。无标题则整体作为一个场景。 */
export function splitScenarios(script: string): Scenario[] {
  // 用例头（frontmatter）不是步骤：先剥掉。没有 `## ` 的用例否则会把它当成正文，
  // 模型就会去「执行」那几行 YAML。
  const { body: text } = splitFrontmatter(script);
  const lines = text.split(/\r?\n/);
  const collected: Scenario[] = [];
  let currentName = "";
  let currentLines: string[] = [];
  let inScenario = false;
  const flush = () => {
    if (!inScenario) return;
    const body = currentLines.join("\n").trim();
    if (body.length > 0)
      collected.push({ name: currentName || t("common.scenarioDefault"), body });
    currentLines = [];
  };
  for (const line of lines) {
    const m = line.match(/^##\s+(.*)$/);
    if (m) {
      flush();
      inScenario = true;
      currentName = m[1].trim();
    } else if (inScenario) {
      currentLines.push(line);
    }
    // 一级标题(#)与##之前的开场说明文字：不计入任何场景
  }
  flush();
  return collected.length
    ? collected
    : [{ name: t("common.scenarioDefault"), body: text.trim() }];
}
