#!/usr/bin/env node
// Read-only forensic reader for the pageqa run archive.
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const NS = "pageqa";
const raw = process.argv.slice(2);
const opts = { dir: null, limit: 25, msgs: 8, id: null, mode: "list" };
for (let i = 0; i < raw.length; i++) {
  const a = raw[i];
  if (a === "--dir") opts.dir = raw[++i];
  else if (a === "--limit") opts.limit = Number(raw[++i]);
  else if (a === "--msgs") opts.msgs = Number(raw[++i]);
  else if (a === "--zero-calls") opts.mode = "zero";
  else if (a === "--show-system") opts.showSystem = true;
  else if (a === "--schema") opts.mode = "schema";
  else if (a === "--help" || a === "-h") opts.mode = "help";
  else if (!a.startsWith("-")) opts.id = a;
}
for (const k of ["limit", "msgs"]) if (!Number.isInteger(opts[k]) || opts[k] < 1) opts[k] = 25;

function fail(msg) {
  console.log(msg);
  process.exit(1);
}
function clip(s, n = 300) {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…[+${t.length - n}]` : t;
}
function json(s) {
  try { return JSON.parse(s); } catch { return null; }
}

// Paths must be built with join(homedir(), ...): a literal "C:\Users\..." in a JS
// string has its backslashes eaten as escapes, which is what makes the open fail.
function dbPath() {
  if (!opts.dir) return join(homedir(), ".pageqa", "sessions", "sessions.sqlite");
  return opts.dir.endsWith(".sqlite") ? opts.dir : join(opts.dir, "sessions.sqlite");
}
function openDb() {
  const p = dbPath();
  if (!existsSync(p)) fail(`archive not found: ${p}\n  pass --dir <archive dir> if the runs live elsewhere`);
  try {
    return new DatabaseSync(p, { readOnly: true });
  } catch (e) {
    fail(`cannot open ${p} read-only: ${e.message}\n  a pageqa run may still hold it; retry after it exits`);
  }
}

const REAL_CALLS =
  "(SELECT COUNT(*) FROM list_values l WHERE l.session_id=t.session_id AND l.namespace=? AND l.key='toolCalls')";

function listRows(db) {
  // Placeholder order follows the SQL text: subquery namespace, then outer namespace, then LIMIT.
  const rows = db
    .prepare(
      `SELECT t.session_id AS id, t.value AS v, ${REAL_CALLS} AS realc
       FROM scalar_values t WHERE t.namespace=? AND t.key='summary'
       ORDER BY t.session_id DESC LIMIT ?`
    )
    .all(NS, NS, opts.limit);
  return rows;
}

function formatRow(id, value, realc) {
  const s = json(value) || {};
  const mismatch = Number(s.toolCalls ?? 0) !== realc ? " <== summary disagrees" : "";
  return [
    id,
    s.status ?? "-",
    `steps:${s.steps ?? "-"}`,
    `sum:${s.toolCalls ?? "-"}`,
    `real:${realc}`,
    `turns:${s.turns ?? "-"}`,
    clip(s.scenarioName || s.casePreview || "", 44),
  ].join(" | ") + mismatch;
}

function detail(db, id) {
  const get = (key) =>
    db.prepare(`SELECT value FROM scalar_values WHERE namespace=? AND key=? AND session_id=?`).get(NS, key, id)?.value;
  const sum = json(get("summary"));
  if (!sum) fail(`no archived summary for ${id}\n  try --schema, or list first`);
  const res = json(get("result")) || {};
  const calls = db
    .prepare(`SELECT seq, value FROM list_values WHERE namespace=? AND key='toolCalls' AND session_id=? ORDER BY seq`)
    .all(NS, id);

  console.log(`### ${id}`);
  console.log(
    `status=${sum.status} steps=${sum.steps} calls(summary)=${sum.toolCalls} calls(real rows)=${calls.length} turns=${sum.turns} model=${clip(sum.model, 40)}`
  );
  console.log(`case: ${clip(sum.casePreview, 160)}`);
  console.log(`note: ${clip(res.note, 300) || "(none)"}  usage: ${JSON.stringify(res.usage ?? null)}`);

  // params holds the whole system prompt: report sizes, never dump it.
  const p = json(get("params")) || {};
  console.log(
    `params keys: ${Object.keys(p).join(",") || "-"} | systemPrompt chars: ${String(p.systemPrompt ?? "").length}`
  );

  if (calls.length) {
    console.log(`\n--- real tool calls (${calls.length}) ---`);
    for (const c of calls) {
      const t = json(c.value) || {};
      console.log(`[${t.index ?? c.seq}] ${t.name} ok=${t.ok} ${clip(JSON.stringify(t.args ?? {}), 150)}`);
      if (t.ok === false) console.log(`      err: ${clip(t.result, 240)}`);
    }
  } else {
    console.log("\n--- real tool calls: NONE archived ---");
  }

  // Each turn's context is cumulative, so every turn re-prints the whole transcript.
  // Read only the last turn; earlier turns differ by nothing but timing.
  const turns = db
    .prepare(`SELECT seq, value FROM list_values WHERE namespace=? AND key='turns' AND session_id=? ORDER BY seq DESC LIMIT 1`)
    .all(NS, id);
  if (!turns.length) return console.log("(no turns archived)");
  const last = json(turns[0].value) || {};
  const all = Array.isArray(last.context) ? last.context : [];
  // The system prompt is identical across runs; showing it burns context without evidence.
  const ctx = opts.showSystem ? all : all.filter((m) => m.role !== "system");
  console.log(`\n--- final turn context (${all.length} msgs, ${ctx.length} non-system, showing last ${opts.msgs}) ---`);
  for (const m of ctx.slice(-opts.msgs)) {
    console.log(`  [${m.role}${m.truncated ? " truncated" : ""}] ${clip(m.text, 700)}`);
  }

  const fake = [];
  for (const m of ctx) {
    if (m.role !== "assistant") continue;
    const t = String(m.text ?? "");
    if (t.includes("```python") || t.includes("```json") || /<\s*tool_call/i.test(t) ||
        /假设快照|假设返回|假设页面|assume the snapshot/i.test(t)) {
      const hits = [
        t.includes("```python") && "```python block",
        t.includes("```json") && "```json block",
        /<\s*tool_call/i.test(t) && "inline <tool_call> markup",
        /假设快照|假设返回|假设页面|assume the snapshot/i.test(t) && "assumed a tool result",
      ].filter(Boolean);
      fake.push(`  turn ${last.index}: ${hits.join(", ")} -> ${clip(t, 200)}`);
      break;
    }
  }
  console.log("\n--- verdict ---");
  if (!calls.length && fake.length) {
    console.log("NO real tool call was archived; the assistant wrote pseudo-code instead:");
    console.log(fake.join("\n"));
  } else if (!calls.length) {
    console.log("NO real tool call archived, and no pseudo-code marker found — read the context above.");
  } else {
    const bad = calls.map((c) => json(c.value)).filter((t) => t && t.ok === false);
    console.log(bad.length ? `${bad.length} tool call(s) returned ok=false — start with the first one.` : "All archived tool calls returned ok.");
  }
  const claimed = Number(sum.toolCalls ?? 0);
  if (calls.length && claimed !== calls.length)
    console.log(`summary.toolCalls=${claimed} but ${calls.length} call rows archived — trust the rows.`);
}

function schema(db) {
  const ts = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
  for (const { name } of ts) {
    const cols = db.prepare(`PRAGMA table_info(${name})`).all().map((c) => c.name);
    console.log(`${name}: ${cols.join(", ")}`);
  }
  const nk = db
    .prepare("SELECT namespace, key, COUNT(*) AS n FROM scalar_values GROUP BY namespace, key " +
             "UNION ALL SELECT namespace, key, COUNT(*) AS n FROM list_values GROUP BY namespace, key ORDER BY namespace, key")
    .all();
  console.log("\nnamespace/key counts (scalar + list):");
  for (const r of nk) console.log(`  ${r.namespace}/${r.key}: ${r.n}`);
}

const db = openDb();
try {
  if (opts.mode === "help")
    console.log(
      "usage: archive.mjs [--list] | --zero-calls | <session-id> [--msgs N] | --schema | --dir <path> | --show-system\n" +
      "  read-only over ~/.pageqa/sessions/sessions.sqlite"
    );
  else if (opts.mode === "schema") schema(db);
  else if (opts.mode === "zero") {
    const hits = listRows(db).filter((r) => r.realc === 0);
    console.log(`sessions with zero archived tool calls (last ${opts.limit} scanned, ${hits.length} hit):`);
    for (const r of hits) console.log(formatRow(r.id, r.v, r.realc));
  } else if (opts.id) detail(db, opts.id);
  else {
    const rows = listRows(db);
    console.log(`recent archives (${rows.length}):`);
    for (const r of rows) console.log(formatRow(r.id, r.v, r.realc));
  }
} catch (e) {
  fail(`query failed: ${e.message}`);
}
