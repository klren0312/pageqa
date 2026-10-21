/**
 * 追加输入的模型格式化。
 *
 * 交互模式里随手敲的一段话，要变成「`## 场景名` / 一行一步 / 断言单独成行」的用例，
 * 步骤编号与断言核账才对得上：一句话里并列的几个动作留在同一行只算一个步骤，
 * 断言不单独成行则报告会按「断言数不足」判 FAIL。这里只做格式整理，不改写测试意图——
 * 写回文件与真正执行的，都是模型整理后的这段文本。
 *
 * 网络调用留在 app.ts（它才持有模型目录与会话选择）；本模块只负责提示词与输出清洗，
 * 因此可以直接单测。
 */

/** 格式化请求的上限：模型慢不能把「提交一条用例」卡成无期限等待。 */
export const FORMAT_TIMEOUT_MS = 60_000;

/** 输出通常比一段话长，给足空间；超出仍会被端点截断，由 stopReason 识别。 */
export const FORMAT_MAX_TOKENS = 2048;

/**
 * 格式化提示词。
 *
 * 规则全部对应 pageqa 的真实执行契约（见 `.agents/skills/page-test-case-writer`）：
 * `##` 分场景、非空行即步骤、`断言` 行数与工具调用数核账、条件等待进回放脚本。
 * 同时把「不编造」写在最前面：格式化一旦擅自补充页面文案或测试数据，跑出来的
 * 结论就不再是用户输入的那条用例了。
 */
export const FORMAT_SYSTEM_PROMPT = [
  "你是 pageqa 的用例格式化助手。pageqa 会把用例按非空行逐条驱动浏览器执行。",
  "把用户输入的测试文本整理成 pageqa 用例格式；只做格式整理，不改变测试意图。",
  "",
  "硬性规则：",
  "1. 只输出用例正文，不要解释，不要用代码块包裹。",
  "2. 每个场景以 `## <场景名>` 开头。输入只描述一条流程时只输出一个场景；明确包含多个互不依赖的测试流程时才拆成多个场景。",
  "3. 一个非空行 = 一个步骤，一行只做一件事；把一句话里并列的多个动作拆成多行。",
  "4. 说明、前置条件、备注写成以 `>` 开头的行，它们不参与执行。",
  "5. 打开页面必须写完整 URL（含 http:// 或 https://）。",
  "6. 断言必须单独成行并以「断言」开头；只写用户明确要求的断言，不新增、不改写期望结果。一行「断言 …」对应执行时的一次断言工具调用。",
  "7. 涉及下载/导出时，把触发下载的元素写在同一步里（如「点击「导出」按钮并捕获下载的文件」），不要先写一次点击再等下载。",
  "8. 页面内的等待写成条件等待（「等到页面出现「…」」/「等到「…」消失」）；不要为页面内等待写死秒数，不要写 @eN 快照编号。",
  "9. 原样保留 URL、字段名、输入值和 ${...} 占位符；不得编造页面文案、元素、接口或测试数据。",
  "10. 不要添加「读取页面内容」之类的额外步骤，除非用户明确要求或确实无法确定页面结构。",
  "",
  "示例：",
  "输入：打开 https://example.com，等页面出现 Example Domain，断言页面包含 Example Domain",
  "输出：",
  "## 打开示例页",
  "打开 https://example.com",
  "等到页面出现「Example Domain」",
  "断言页面包含 Example Domain",
].join("\n");

/** 把一段用户输入包成格式化请求（真正的测试文本放在分隔线内，避免与规则混淆）。 */
export function buildFormatPrompt(raw: string): string {
  return [
    "把下面的测试文本整理成 pageqa 用例：",
    "<<<输入开始",
    raw.trim(),
    "输入结束>>>",
  ].join("\n");
}

/**
 * 清洗模型回复，得到可以直接交给 `splitScenarios` 的用例文本。
 *
 * 处理三种常见跑偏：包进 ```markdown 代码块、在第一个 `##` 之前加一句「以下是…」、
 * 只回了空内容或注释。清洗后没有任何可执行步骤时返回 undefined，由调用方回退为原文提交。
 */
export function parseFormattedCase(reply: string): string | undefined {
  let text = reply.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").trim();
  if (!text) return undefined;
  // 整份用例被代码围栏包住时（模型常见跑偏），只取围栏内的内容。
  // 只有开头的围栏才算“包裹”，避免把正文里一个孤立的闭合围栏当成新的开头。
  // 语言标记可以是任意文本（` ``` md ` 也算），未闭合时取到文末。
  if (text.startsWith("```")) {
    const fenced = /^```[^\n]*\n([\s\S]*?)(?:```|$)/.exec(text);
    if (fenced) text = fenced[1].trim();
  }
  // 其余位置残留的围栏行不是用例内容（例如多出来的闭合围栏）。
  text = text
    .split("\n")
    .filter((line) => !line.trim().startsWith("```"))
    .join("\n")
    .trim();
  if (!text) return undefined;
  // 第一个 `## 场景名` 之前的开场白不是用例：splitScenarios 本来也会丢弃它，
  // 这里先切掉，免得「模型没写标题」时开场白被当成第一个步骤。
  const firstHeading = text.search(/^##\s+/m);
  if (firstHeading > 0) text = text.slice(firstHeading).trim();
  // 只给了一级标题时把它当作场景名，避免写回成 `## # 标题`。
  if (firstHeading < 0) {
    const firstH1 = text.search(/^#\s+/m);
    if (firstH1 >= 0) text = text.slice(firstH1).replace(/^#\s+/, "## ");
  }
  const hasStep = text.split("\n").some((line) => {
    const trimmed = line.trim();
    return trimmed.length > 0 && !trimmed.startsWith("#") && !trimmed.startsWith(">");
  });
  return hasStep ? text : undefined;
}

/**
 * 原文里的 `${...}` 占位符必须在整理结果中原样出现。
 *
 * 这些占位符会在执行时展开；格式化若把它替换成具体值，写回的用例下次运行就会撞名。
 * 返回缺失的占位符（去重），空数组表示全部保留。
 */
export function missingPlaceholders(raw: string, formatted: string): string[] {
  const placeholders = raw.match(/\$\{[^}]+\}/g) ?? [];
  return [...new Set(placeholders)].filter((p) => !formatted.includes(p));
}
