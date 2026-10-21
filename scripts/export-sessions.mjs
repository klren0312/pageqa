/**
 * 从 pageqa 运行存档抽取训练轨迹。
 *
 * 数据来源：~/.pageqa/sessions/sessions.sqlite（pi-durable 容器，字段见 src/session/archive.ts）。
 * 我们复用仓库已编好的 readArchive/listArchives，而不是去解析 pi-durable 内部表结构。
 *
 * 抽取策略（贴近 SFT 需求）：
 *   - 只取 status === "pass" 且 called === true 的运行（干净正样本；失败轨迹留给后续 DPO 负例）。
 *   - 取「最后一轮」的 context：它就是这一轮实际发给模型的完整上下文（累积历史），
 *     天然是一条多轮对话（system / user 用例 / assistant 工具调用 / tool 结果 …）。
 *   - 角色映射：toolResult -> tool，其余原样。assistant 文本里的 "[toolCall] name args"
 *     行原样保留——训练时模型就学这种「动作即文本」的风格（详见 train/README 升级路径）。
 *
 * 注意：存档里每条消息已被 archive.ts 在 4000 字符处截断（MAX_TEXT_CHARS）；
 *       更长的「原始快照」需靠 train/prepare_data.py 再做一次业务侧截断。
 *
 * 运行：
 *   pnpm build                                  # 必须先编译出 dist/
 *   node scripts/export-sessions.mjs            # -> train/data/sessions.jsonl
 *   node scripts/export-sessions.mjs --dir /path/to/sessions --out train/data/sessions.jsonl
 */
import { listArchives, readArchive } from "../dist/session/archive.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(`--${name}=`.length) : fallback;
};

const OUT = arg("out", "train/data/sessions.jsonl");
const DIR = arg("dir", undefined); // 不传则用 archive.ts 默认的 ~/.pageqa/sessions

function roleOf(r) {
  return r === "toolResult" ? "tool" : r;
}

const summaries = await listArchives(DIR);
const candidates = summaries.filter((s) => s.status === "pass" && s.called);
console.log(`[export] ${summaries.length} 条存档，其中 ${candidates.length} 条 pass 且已调用模型`);

const lines = [];
let skipped = 0;
for (const s of candidates) {
  try {
    const archive = await readArchive(s.id, DIR);
    const turns = archive.turns;
    if (!turns || turns.length === 0) {
      skipped += 1;
      continue;
    }
    const ctx = turns[turns.length - 1].context; // 累积完整上下文
    if (!ctx || ctx.length === 0) {
      skipped += 1;
      continue;
    }
    const messages = ctx.map((m) => ({ role: roleOf(m.role), content: m.text }));
    // 工具 schema 必须一起导出：训练时要和推理一样用 apply_chat_template(..., tools=...)
    // 渲染出 `<tool_call>{"name":..,"arguments":..}</tool_call>`，否则模型只会把调用写成纯文本。
    const tools = (archive.params?.tools ?? []).map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
    lines.push(JSON.stringify({ id: s.id, model: s.model, tools, messages }));
  } catch (e) {
    skipped += 1;
    // 单条失败不阻断整批
  }
}

mkdirSync(dirname(resolve(OUT)), { recursive: true });
writeFileSync(OUT, lines.join("\n") + (lines.length ? "\n" : ""));
console.log(`[export] 写出 ${lines.length} 条轨迹 -> ${OUT}（跳过 ${skipped} 条）`);
