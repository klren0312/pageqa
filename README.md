# pageqa

> 中文文档：[README.zh-CN.md](./README.zh-CN.md)

A natural-language-driven page testing agent: **an LLM parses intent → browserskill (`bsk`) drives a real browser → it emits a text/JSON report and a CI-ready exit code**. Once a case passes with the model, its operations are frozen into a replay script that can re-run the same case with zero model calls.

The interactive mode (TUI) is the default and recommended way to use it: a long flow can take ten-plus minutes, and during that time you can keep adding scenarios, switch models, and watch live progress and token usage.

<https://github.com/user-attachments/assets/d5315f93-7e02-4445-a7cf-506b3bfcaa2d>

---

## Install & prerequisites

**1. Install `pageqa`** (requires Node.js ≥ 22.19):

```bash
npm install -g pageqa      # or pnpm add -g pageqa
pageqa --init-config       # create ~/.pageqa/config.json in your home dir
pageqa update              # later: check for and install updates (--check for check-only)
```

**2. Install and connect browserskill (`bsk`)** (the plugin that drives the real browser — [project home](https://github.com/Tencent/BrowserSkill)):

```bash
bsk status                 # view daemon and connected browsers
bsk session start          # optional: create a session (pageqa auto-creates one if omitted)
```

> pageqa auto-background-starts the bsk daemon when it isn't running (once per process). But **you must connect the browser yourself**: install the bsk extension in the browser and complete the connection. If no connected browser is detected at startup, pageqa reports it clearly and asks you to connect first, rather than hanging.

**3. Configure the LLM endpoint** (default `http://127.0.0.1:3000/v1`, key `codebuddy-proxy-key`): write it into `~/.pageqa/config.json`, or use env vars `PAGEQA_LLM_BASE_URL` / `PAGEQA_LLM_API_KEY` / `PAGEQA_LLM_MODEL` (env vars > config file > built-in defaults).

```json
{ "baseUrl": "http://127.0.0.1:3000/v1", "apiKey": "codebuddy-proxy-key", "model": "hunyuan-2.0-instruct", "locale": "zh" }
```

---

## Interactive mode (TUI) — the core workflow

Run `pageqa` with no arguments in an interactive terminal and the TUI opens automatically (both stdin and stdout are a TTY):

```bash
pageqa                           # empty session: empty queue, no write-back target; /run a case file any time
pageqa --tui                     # force interactive mode (errors in a non-TTY)
/run examples/smoke.md           # load a case inside the TUI (switches the write-back target)
```

Auto-entry: with no `--json`, bare **`pageqa`** enters the TUI on a TTY. Run a case in batch with `pageqa run <case>` (never enters the TUI); interactive mode does not accept a case on the command line — load it with `/run` after entering. **Inline text only goes through `run`**; `--json` / `--replay` / `--prefer-replay` / `--session` / `--only` / `run` never enter the TUI (`--tui` together with `--only` errors immediately). To disable: `pageqa --no-tui` or `PAGEQA_NO_TUI=1`.

### Layout

```text
┌──────────────────────────────────────────────────────────┐
│ Kanban band (rendered only when terminal width ≥ 90):      │  ← 5 status columns
│   5 columns summarizing scenarios by state                  │
├──────────────────────────────────────────────────────────┤
│                                                            │
│   Scrollable log viewport (follows end; scroll back to      │
│   review; live progress / timings / pass-fail)              │
│                                                            │
├──────────────────────────────────────────────────────────┤
│ Status line: current model · pending count · write-back     │
│ > input box (fixed at bottom)                               │
│ Token: ⬇ … / ⬆ … / read … / write … / total … · hit …%      │
│ hint line                                                  │
└──────────────────────────────────────────────────────────┘
```

- **Kanban band**: all scenarios grouped into 5 columns by state (waiting / running / pass / fail / cancelled); each running card carries its own live elapsed time. Each column shows the first few cards **in queue order**, with `+N more` when exceeded. Display-only (no click actions); hidden entirely below 90 columns so the log keeps the space.
- **Status line** always shows the current model, the pending count and the **write-back target** (the case file appended scenarios are written back to; when none, it says so — appended scenarios then live only in this session and are lost on exit). The written-back count joins in once something has actually been written back.
- **Token line** (under the input box) is the same sentence as the report's last line, with the running scenarios' live values, **plus the cache hit rate and the current context length**:

  ```text
  Token: ⬇ 1.2k / ⬆ 567 / read 8.9k / write 42 / total 10.7k (LLM calls 3)  ·  hit 92%  ·  context 24.1k/128k (19%)
  ```

  The short words work because the **order is the legend**: `⬇` = input (fed into the model), `⬆` = output, `read`/`write` = cache read / cache write, `total` = the sum. The trailing `hit 92%` = cache read / (input + cache read), i.e. how much of this input came back from the prompt cache. Seeing it hold steady while a run is in progress means the prompt prefix is stable and the cache keeps hitting. When the denominator is zero (replay, endpoint returned no usage, nothing called yet) that part is simply not shown, rather than printing a 0%. The `context 24.1k/128k (19%)` part is what the last turn actually sent, against the model's window (it is dropped when the window size is unknown, and never shown when nothing is running). This line refreshes on every call, so it uses the compact `1.2k` / `24.1k` form; the report's last line keeps the exact numbers.

### Submitting scenarios

- Type natural language in the input box and press **Enter**: the current model first formats the text into a pageqa case (`## scenario name`, one step per line, one assertion per line). The formatted text is printed in full to the log — **that is what gets written back and executed**, not your raw input.
- If the model is unavailable, takes longer than 60 seconds, returns no executable steps, or drops a `${...}` placeholder from the original text, submission falls back to the original text (exactly the pre-formatting behavior) and says why in the log. Pressing `Esc` while idle discards inputs that have not been queued yet.
- Submitting means "write-back + enqueue": with a target it appends to the target file first, then enqueues (so "what you type is what you keep"); if a scenario is already running, the new one queues and runs automatically after. **Shift+Enter** inserts a newline (for multi-scenario cases).

### Commands (start a line with `/`; typing `/` pops up a fuzzy command list)

| Command | Purpose |
| --- | --- |
| `/run <path or keyword>` | Load a case file into the queue at runtime: exact path, a directory (every case in it), or a filename keyword; multiple hits let the model pick from filenames first, then a selector. Also switches the write-back target |
| `/replay <script or keyword>` | Load the scenarios of a replay script (`.json`) into the queue and rerun them step by step with **no model**: one queue item per script scenario, each timed and reported separately; the write-back target stays put (a replay script is not a case file). They can share a batch with model-driven scenarios |
| `/status` | View the run queue (one line per scenario with state and origin) |
| `/cancel <n>` | Cancel the not-yet-started queued scenario #n |
| `/new` | New session: clears viewport and queue, resets token counter, but **archives the previous batch** (still in the exit report and replay script). Refuses while something is running/pending or inputs are still being formatted |
| `/model` | Switch this session's model — `Enter` applies it now **and** saves it as the startup default. The list ships with a set of **free gateways** carrying a `free` badge — see [Free model gateways](#free-model-gateways) |
| `/login` · `/logout` | Sign in / remove a provider's local credentials (`~/.pageqa/auth.json`) |
| `/setting` | Persistent prefs: test report (HTML) / replay script toggles, language, **concurrency** (1/2/3/4/6/8) |
| `/proxy` | Proxy routing for model requests: on/off (saved to `~/.pageqa/proxy.json`), bypass for this session, reload the file, show counters and rules — see [Proxy for model requests](#proxy-for-model-requests) |
| `/help` · `/exit` | Help / finish and exit (`/quit` is an alias) |

### Keybindings

| Key | Action |
| --- | --- |
| `Enter` | Submit input |
| `Shift+Enter` | Newline |
| `Esc` | Abort the running scenario (recorded as "cancelled", not counted in exit code, not written to replay); when idle, discard inputs not yet queued by formatting; cancels a pending prompt |
| `Ctrl+C` | Finish: abort current + cancel all pending → restore terminal → print summary report (normal exit, never a hard kill; a second press during wind-down means "stop waiting") |
| `PageUp`/`PageDown` | Scroll the log a page |
| `↑`/`↓` | Scroll the log when the input box is empty (some terminals report the wheel as these) |
| `Ctrl+↑`/`Ctrl+↓` | Scroll the log one line (works while writing a multi-line case) |
| `Ctrl+P`/`Ctrl+N` | Input history previous / next |
| `Ctrl+Home`/`Ctrl+End` | Jump to log start / back to end (resume following) |
| Mouse wheel | Scroll the log (3 lines per notch; scrolling up pauses following — click the last-row hint or `Ctrl+End` to return) |

> `/run` loads scenarios are **not** written back (they're already in the file); only your appended scenarios are. Appended scenarios with no target are lost on exit, and the count is reported honestly at exit.

---

## Batch mode — one-shot runs / CI

Use when you don't need to interact mid-run, or to feed CI:

```bash
pageqa run "Open https://example.com and assert the title contains Example"   # inline natural language
pageqa run examples/smoke.md        # read a case file (auto-detects ##-separated scenarios)
pageqa run --json examples/smoke.md # JSON report
pageqa run --suite "..."            # force multi-scenario suite mode
pageqa run --concurrency 4 examples/smoke-test.md   # run up to 4 scenarios at once (default 1)
pageqa run --only 2 examples/smoke.md    # run just scenario 2
pageqa run --only "form filling" ...     # run one by exact title
pageqa run --no-side-outputs ...    # no HTML report, no default replay script — stdout only
pageqa run --out report.txt ...     # write the report to a file
```

> Direct `pageqa <case>` execution was removed so a mistyped command or filename cannot run as a case. Use the explicit `run` subcommand; for interactive mode, start `pageqa` and load the case with `/run`.

- stdout holds only the final report; logs go to stderr (so `pageqa run --json … > report.json` is clean).
- Exit code: `0` all assertions passed; `1` any assertion failed / errored / could not execute — usable directly as a CI gate.
- Before each scenario a connectivity probe runs; if the model is unreachable that scenario is recorded as FAIL and remaining pending items are cancelled, rather than wasting browser windows.

**Scenario isolation** (see `docs/adr/0013-scenario-process-isolation.md`): in suite mode **each scenario runs in its own child process**, with the parent forking them serially and aggregating the results. So when a scenario takes the browser or the bsk daemon down with it (native crash, OOM kill), only that scenario is recorded as failed (`reason: "crash"` in the report) and the rest still run. Re-running just the failed one is `--only <index|title>` — the same code path the parent uses internally when it forks.

A crash or a timeout is recorded as a failure and does not drag anyone else down; only environment-level failures (unreachable model endpoint, unusable bsk/browser) mark the remaining scenarios as "cancelled". Sessions and browser windows are owned by the parent, so a hard-killed child leaves no orphan windows.

**Running scenarios in parallel**: by default they run **one at a time** (that order is what protects implicit sequences such as create → edit → delete). Once you know they are independent, `--concurrency <n>` (or `PAGEQA_CONCURRENCY` / the `concurrency` config field) runs up to n at once: each scenario still gets its own child process, its own session and its own **browser window** — so n is literally how many windows are open at the same time, hence the cap of 8 and an error (not a silent clamp) when exceeded. Result order is unchanged: the report and the replay script always follow the case's source order, no matter who finishes first. While parallel, every log line carries a `[#<index> <scenario name>]` prefix, otherwise the interleaved output is unreadable.

**Interactive mode honours concurrency too**: `--concurrency` at startup is just the starting point for the session; inside, `/setting` > concurrency changes it at any time (levels 1/2/3/4/6/8). The change **takes effect immediately** — scenarios dispatched from then on use the new value, ones already running are left alone — and is written back to `~/.pageqa/config.json`. While parallel, the kanban band's "running" column holds several cards (each with its own live elapsed time), the status line swaps "k/n" for "N running · oldest … for …", and `Esc` aborts **all** running scenarios (once more than one can run, "the current scenario" is no longer a single thing). `--replay` never uses the scenario scheduler, so concurrency is inert there.

---

## Replay — zero-model re-run

After a model-driven pass, operations are frozen into a replay script (`*.replay.json` next to the source case, on by default; toggle in `/setting`, `--emit-script` always wins). Re-run it with zero model calls — sub-second, no LLM endpoint needed — ideal for "model once, regress daily" in CI:

```bash
pageqa run --emit-script examples/smoke.md           # explicitly generate the script (already auto-generated by default)
pageqa --replay examples/smoke.replay.json          # zero-model replay
pageqa --replay examples/smoke.replay.json --json   # machine-readable report
pageqa --replay examples/smoke.replay.json --semantic  # assertions use Jev semantic judgment
pageqa run --prefer-replay examples/smoke.md         # replay with zero models if the script still matches; otherwise run live
```

`--prefer-replay` only auto-replays when the sibling `.replay.json` is structurally valid, was recorded from the same source path, and its source hash still matches the current case. Otherwise it prints the reason and falls back to a live run. It does not change the default behavior and is ignored with `--only` / `--emit-script` / `--tui` / explicit concurrency.

Notes: the script stores **semantic locators** (role + accessible name + same-name index + ancestor path), re-resolved against the current snapshot at replay time, so small page changes usually still hit; on unresolved elements it reports the cause instead of guessing. Element-not-found → skip and continue (listed in the report); other failures → recorded as fail and the whole case still runs; `navigate` failure → abort immediately. Add `--fail-fast` to stop a scenario on first failure.

---

## Writing cases

A case is natural-language text split into steps by non-empty lines (`#`/`>` comment lines don't count). Use `## title` to separate independent scenarios (each gets its own bsk session and browser window).

**Assertion lines must line up with assertion tool calls**: the report checks "how many lines contain 断言" (the literal Chinese word — an English `assert` does not count) against "how many assertion results were actually produced" — they must match. Each `assert_text` yields one assertion, and so do `download`, `assert_no_console_error` and `assert_network` (don't add a separate "assert downloaded" line for `download`). Comment lines never inflate the count.

**Runtime placeholders** (expanded once; because each scenario runs in its own child process the moment is taken **per scenario**, not once per run — see ADR-0013):

| Placeholder | Expands to |
| --- | --- |
| `${timestamp}` | `yyyyMMddHHmm` |
| `${date}` / `${time}` | `yyyyMMdd` / `HHmmss` |
| `${datetime}` | `yyyyMMddHHmmss` |
| `${timestamp:<format>}` | custom, supports `yyyy yy MM dd HH mm ss SSS` |

Unrecognized placeholders (e.g. `${PATH}`) are kept as-is.

**File upload**: write "click the upload button to upload the local file `<absolute path>`" and the agent calls `upload` (enable "Allow access to file URLs" on the bsk extension first). **File download/export**: write "click export, confirm in the dialog, verify the file was downloaded" and the agent calls `download` (`target` is the element that triggers the download, `expectName` matches the filename with a glob like `*.xls`). Downloaded files are auto-cleaned after a passing assertion (disable via `downloadCleanup` in config).

### Format lint: `pageqa lint`

Those conventions are easy to forget, and breaking one usually only shows up **ten minutes into a run** — often as a **false failure** ("assertions incomplete", "steps incomplete"). `pageqa lint` moves the same checks in front of the run: it reads text only — **no browser, no model** — and reports "which line, which rule, why" in a second:

```bash
pageqa lint examples/smoke-test.md                            # for humans
pageqa lint --json examples/smoke.md examples/smoke-test.md   # for machines (CI)
pageqa lint --strict cases/login.md                           # warnings fail too (pre-commit)
```

Step and assertion counts come from the very code the runtime uses (`numberSteps` / `countAssertions`), so a clean lint never turns into an "assertions incomplete" failure at run time.

| Severity | Rules |
| --- | --- |
| `error` (exit code 1) | empty scenario, duplicate scenario title, `@e3` snapshot ref, a navigation verb (`打开`/`访问`/`前往`/`跳转到`/`进入`) without http/https, unknown placeholder (`${PATH}` is kept verbatim), upload without an absolute path |
| `warn` (non-zero under `--strict`) | text before the first `## ` (dropped), fixed `wait N seconds`, a dropdown written as "fill in", a separate "assert the filename…" line after a download, prose mistaken for a step, a scenario with no assertion, **an assertion with no literal text to match** ("the table has rows", "the dialog is open") |

Exit code: `0` clean; `1` has an `error` (or a `warn` under `--strict`).

**Runs pre-check automatically too**: before every run (batch / interactive / `--only`) the same rules are applied and any findings are printed to stderr (at most 5 expanded). It is **advisory and never blocks** — a case that can run should run, a real failure is worth more than a format warning; to gate on it, wire `pageqa lint` into CI. Pass `--no-lint` to skip it.

> Turning the intro text of `examples/smoke.md` into a `>` line is not pedantry: that text is dropped entirely, yet it still counted toward the step total — its only effect was making n one larger than the steps the model could actually run.

---

## Config & optional enhancements

- **Config file**: `~/.pageqa/config.json` with fields `baseUrl`/`apiKey`/`model`/`modelProvider`/`contextWindow`/`compactPrompt`/`locale`/`htmlReport`/`replayScript`/`downloadDir`/`downloadCleanup`/`autoScreenshot`/`scenarioTimeoutMs`/`concurrency`/`modelPricing`/`usdToCny`. Precedence: `PAGEQA_*` env vars > config file > built-in defaults — but only the endpoint / model / context window / prefix compaction / locale / timeout / concurrency / exchange-rate fields have env-var overrides; the side-output switches (`htmlReport`, `replayScript`, `downloadDir`, `downloadCleanup`, `autoScreenshot`) are read from the file only.
- **Parallelism (optional)**: `concurrency` or `PAGEQA_CONCURRENCY` (**default 1** = one at a time, capped at 8). Parallelism is a claim that the scenarios are independent, hence off by default; the value is literally how many browser windows are open at once.
- **Per-scenario execution limit (optional)**: `scenarioTimeoutMs` or `PAGEQA_SCENARIO_TIMEOUT` (milliseconds, **unlimited by default**). In suite mode a scenario that exceeds it has its child process killed, is recorded as failed (`reason: "timeout"` in the report), and **the following scenarios still run**. Off by default: ten-plus-minute flows are normal here, so an assumed default would just be a new source of failures — set it explicitly when CI needs a gate.
- **Small-window models / context window (optional)**: `contextWindow` or `PAGEQA_LLM_CONTEXT_WINDOW` (in tokens). Custom endpoints expose no window metadata, and a local engine's window depends on its **load setting** (the same model can be 8192 or 131072) — so when you don't declare one, pageqa **asks the engine once** (LM Studio's `/api/v0/models`, llama.cpp's `/props`) and only falls back to a conservative 32k when that fails; a declared value always wins. The budget is `window − output reserve − safety margin`, trimming old snapshots at 75% / 85% occupancy (the aggressive tier drops whole middle messages and injects a state note); **the fixed prefix (system prompt + tool docs, ~12.4k tokens by default) is compacted to the small-model tier (~3.5k) when any of three things holds**: (1) the budget is below roughly 16k (it does not fit), (2) **the model name looks small** (<=9B parameter tags such as `4b`/`e4b`/`7b`, or words like mini/nano/tiny) — a 4B model with a 131072 window gets compacted too, otherwise it reads a 9k-token rule book every turn for nothing, (3) `compactPrompt` is set in config (`PAGEQA_COMPACT_PROMPT`; `false` forces no compaction). Snapshots shrink to the remaining room, `max_tokens` is clamped to the window (1/8 on small windows), and every turn re-calibrates the estimate against the real usage the endpoint reports. If a request still overflows, history is compressed and retried once; a second overflow fails the run and the report spells out the options (bigger-window model, declare `contextWindow`, or split the long case into several scenarios). See `docs/adr/0014`.
- **Jev semantic assertion (optional)**: add a `jev` field to config (or `PAGEQA_JEV_*` env vars) for a semantic re-check when a literal match misses, correcting false FAILs from synonyms/near-synonyms/formatting; on API failure it degrades back to string match automatically.
- **Cost estimate (optional)**: the report's last line estimates spend from the four token classes. Rates come from a built-in snapshot (`src/report/price-snapshot.ts`, covering Anthropic / OpenAI / Google / DeepSeek / Qwen / GLM / Kimi), and **`modelPricing` overrides it** — `provider → model id (or "*") → {input,output,cacheRead,cacheWrite}`, in USD per million tokens; custom endpoints and free gateways need it to get any estimate. Each token class uses its own rate (cache reads are usually a tenth of input), and a missing rate counts as 0 rather than being derived. When no rate is found the report says "no price configured" instead of `$0.00` — the latter reads as "this model is free". `usdToCny` (or `PAGEQA_USD_TO_CNY`, default 7.1) only controls the CNY figure shown alongside; the rates themselves stay in USD.
- **Turning the endpoint's thinking off (optional)**: hybrid reasoning models (Hunyuan / DeepSeek / Qwen / GLM) default to **thinking on** over OpenAI-compatible endpoints — the model emits a long reasoning passage first, which is slow, burns tokens, and muddles the agent's step numbering and conclusions. Set `thinkingFormat` (or `PAGEQA_LLM_THINKING_FORMAT`) and pageqa sends the endpoint's own off-switch on **every** request:

  | `thinkingFormat` | field sent when thinking is off |
  | --- | --- |
  | `deepseek` / `zai` | `thinking: { "type": "disabled" }` |
  | `qwen` | `enable_thinking: false` |
  | `qwen-chat-template` | `chat_template_kwargs: { "enable_thinking": false, "preserve_thinking": true }` |
  | `together` | `reasoning: { "enabled": false }` |
  | `openrouter` | `reasoning: { "effort": "none" }` |
  | `string-thinking` | `thinking: "none"` |
  | `openai` / `ant-ling` / `baseten` / `chat-template` | **cannot send an off-switch** (the field only appears when a thinking level is requested), so configuring one is a no-op |

  **On by default**: with nothing configured, pageqa picks the off-switch the endpoint understands from the model id (`qwen*`/`qwq*` get `enable_thinking: false`; `deepseek*`, `hunyuan*`, `hy*`, `glm*` get `thinking: {"type":"disabled"}`; anything unrecognised falls back to the deepseek convention, the most common one). Set an explicit value from the table above to change the spelling, or `none`/`off` to stop disabling thinking altogether.
  The effective value and the field being sent are printed at startup. **If the endpoint rejects that field** (strict implementations answer 400), the probe drops it, retries once, writes the downgrade into the model object so this process never sends it again, and says so. So defaulting to off cannot break an endpoint that used to work; it costs one extra probe request only when the endpoint really is incompatible.
- **Language**: `--locale zh|en` or `PAGEQA_LOCALE`; default `zh`. The data contract (JSON fields, exit codes) is language-neutral.
- **Proxy for model requests (optional)**: `~/.pageqa/proxy.json` — see [Proxy for model requests](#proxy-for-model-requests) below.
- **Free model gateways (optional)**: `/model` ships with a set of free / login-free OpenAI-compatible gateways — see [Free model gateways](#free-model-gateways) below.

---

## Free model gateways

Alongside the custom endpoint and pi-ai's built-in providers, `/model` ships with a set of **free** OpenAI-compatible gateways (catalog data taken from [pi-free](https://github.com/apmantza/pi-free); they carry a `free` badge in `/model`):

| provider | endpoint | key env var | notes |
| --- | --- | --- | --- |
| `cline` | `https://api.cline.bot/api/v1` | `CLINE_API_KEY` | public catalog; **chat still needs a login** (`/login cline`). Models are listed logged out and the pre-flight probe reports the real error |
| `llm7` | `https://api.llm7.io/v1` | `LLM7_API_KEY` | two free selectors: `default` / `fast` |
| `fastrouter` | `https://api.fastrouter.ai/api/v1` | `FASTROUTER_API_KEY` | public catalog; `:free` routes have per-minute / per-day caps |
| `orcarouter` | `https://api.orcarouter.ai/v1` | `ORCAROUTER_API_KEY` | key required; only `-free` routes are listed |
| `xkiro` | `https://api.xkiro.com/v1` | `XKIRO_API_KEY` | key required; only `:free` routes are listed |
| `kilo` | `https://api.kilo.ai/api/gateway` | `KILO_API_KEY` | key required, or sign in with the device-code flow (`/login kilo`); the only gateway whose `/models` carries an authoritative per-model `isFree` flag, so its free list does not rely on naming patterns |
| `opencode-free` | `https://opencode.ai/zen/v1` | *(none — fixed anonymous bearer `public`)* | OpenCode Zen's anonymous free lane; always listed and needs no credential, but the request must carry the tool fingerprint described below |

- **No Pi CLI needed**: pi-free itself is a Pi extension (it depends on `@earendil-works/pi-coding-agent`), so pageqa only borrows the catalog data it curated.
- **Catalog: remote first, snapshot as fallback**: opening `/model` fetches each gateway's public `/v1/models` concurrently and keeps only the free entries; when that fails the built-in snapshot (pi-free's 2026-08-26 audit) is used, so there is always something to pick even offline. A failed refresh is silent — it just falls back.
- **Credentials**: set the env var or use `/login <provider>`; both land in `~/.pageqa/auth.json`. `cline` / `llm7` / `fastrouter` / `opencode-free` work without a key and are listed out of the box; `kilo` / `orcarouter` / `xkiro` only appear once you configure one (kilo also accepts `/login kilo`).
- **No guarantees**: rate limits, model retirements and catalog renames are entirely upstream's business. That is what the pre-flight probe (the `ping` before a run starts) is for — an unreachable model aborts with a readable reason instead of producing a pile of bogus scenario failures.
- **`opencode-free` is ported, behind a fingerprint gate**: OpenCode Zen's free tier fingerprints the request's tool list — `tools[]` must carry `bash`/`edit`/`glob`/`grep`/`read`, otherwise 403 `FreeTierError`. pageqa's tool set is browser actions and has none of the five, so **while that gateway is the selected model** it appends five placeholder tools: they exist only to pass the gate and answer "not implemented in pageqa, use the browser tools" if the model ever calls one. No other provider pays for this (the stubs are appended per run, not globally), and the accepted cost is a few hundred tokens per turn on that one lane.

---

## Proxy for model requests

Some networks cannot reach a model endpoint directly, while the local endpoint on `127.0.0.1` and the bsk daemon **must** stay direct. A blanket `HTTP_PROXY` breaks the local ones (the symptom is "connected, but never answers"). So pageqa routes per domain:

| Action | Meaning |
| --- | --- |
| `direct` | always connect directly |
| `proxy` | always go through the proxy |
| `fallback` | try direct first, retry through the proxy on a **network** error (default) |

- **Config file**: `~/.pageqa/proxy.json` (`pageqa --init-config` writes one). Precedence: `PAGEQA_PROXY_*` env vars > file > built-in defaults.

```json
{
  "proxy": "http://127.0.0.1:7890",
  "enabled": true,
  "mode": "fallback",
  "rules": [
    { "match": "localhost,127.0.0.1,*.local,10.*,192.168.*", "action": "direct", "comment": "local / intranet" },
    { "match": "api.deepseek.com", "action": "proxy", "comment": "force proxy" },
    { "match": "*", "action": "fallback", "comment": "direct first, proxy on failure" }
  ]
}
```

Rules are matched top-down, first match wins; anything unmatched falls back to `mode`. `rules: []` means "no rules at all, everything follows `mode`".

| Pattern | Matches |
| --- | --- |
| `example.com` | that domain only |
| `*.example.com` | any subdomain (and the bare domain) |
| `10.*` · `172.2*` | an IP prefix / range (`*` may sit anywhere) |
| `*` | everything |

- **Defaults**: with no `proxy.json` at all, pageqa still routes — localhost/intranet direct, everything else `fallback`. So a local endpoint is untouched while an off-network model endpoint automatically goes through the proxy. The only behavioural change is that a failing direct request gets one extra attempt via `http://127.0.0.1:7890`; set `"enabled": false` (or `PAGEQA_PROXY_ENABLED=false`) to switch it off entirely.
- **Env overrides** (handy in CI): `PAGEQA_PROXY_URL`, `PAGEQA_PROXY_ENABLED`, `PAGEQA_PROXY_MODE`. To reuse a shell's `HTTPS_PROXY`, pass it explicitly: `PAGEQA_PROXY_URL=$HTTPS_PROXY pageqa run case.md`.
- **Interactive mode**: `/proxy` toggles routing (saved to the file), bypasses it for the session only (not saved), reloads the file, and shows counters plus the effective rules. `--debug` prints the current state at startup.
- Outbound Jev requests (`--semantic`) go through the same routing.

---

## CLI options

| Option | Description |
| --- | --- |
| `--session <id>` | Use an existing bsk session (auto-created by default) |
| `--locale <zh\|en>` | UI / log / report language (default zh) |
| `--json` | Output JSON report (excludes the TUI) |
| `--suite` | Force multi-scenario suite mode |
| `--only <index\|title>` | Run just one scenario (index from 1, or an exact title match); output stays suite-shaped. Mutually exclusive with `--suite`/`--tui`/`--replay` |
| `--concurrency <n>` | Run up to n scenarios at once (**a limit**, default 1; `PAGEQA_CONCURRENCY` / the `concurrency` config field also work). Capped at 8, exceeding it errors; interactive mode honours it too (`/setting` > concurrency changes it live), `--replay` does not |
| `--tui` / `--no-tui` | Force interactive on/off (`PAGEQA_NO_TUI=1` also works); `--tui` takes no case — load it with `/run` inside |
| `--no-pager` | Print long help without a pager (default pager: Space/Enter next, q quit; `PAGER=cat` also works) |
| `--emit-script [path]` | Freeze a replay script (on by default, next to the source case) |
| `--no-side-outputs` | Write no side outputs (HTML report, default replay script); an explicit `--emit-script <path>` still wins |
| `--quiet-side-outputs` | Still write side outputs, but print **no closing "outputs" list** — the list is printed once by the process you actually close. The parent sets it for child processes: the replay script in a child's list is a temp transport file that the parent deletes right after |
| `--usage-stream` | Print one structured LLM-usage record per call to stderr (prefix `[pageqa:usage]`); how the parent gets live usage from a child process |
| `--no-lint` | Skip the case-format pre-check before a run (on by default; it only advises on stderr and never blocks). To gate on it use `pageqa lint` |
| `lint` (subcommand) | `pageqa lint <case file...>`: static case-format check, no browser and no model (`--json` / `--strict`); exit code `1` means there is an `error` |
| `--replay <file>` | Replay an existing script with zero models |
| `--prefer-replay` | Replay with zero models when the sibling script still matches the current case; otherwise run live |
| `--semantic` | At replay, assertions use Jev semantic judgment |
| `--fail-fast` | At replay, stop a scenario on first failure |
| `--settle-waits` | At replay, run `wait` steps as "wait until the page settles, capped at the recorded milliseconds" instead of sleeping the full time. Faster, but a wait that existed for something outside the page (a server-side export, a background queue) can be released early |
| `--locate-timeout <ms>` | At replay, how long a step waits for the page to become ready when the locator's whole region is missing (default 8000; `0` = judge "element not found" at once) |
| `--init-config` | Create the config file if it is missing (it does not reset an existing one) |
| `--out <file>` | Write the report to a file |
| `--debug` | Debug logs (bsk commands & timings, snapshot slimming, Jev requests…) |
| `sessions` (subcommand) | `pageqa sessions`: start the local archive server to review the parameters handed to the model and the full interaction (`--port <n>` / `--dir <path>` / `--no-open`) |
| `update` (subcommand) | `pageqa update`: check for and install the latest version (`--check` for check-only, `--json` for machine-readable output); uses `npm install -g pageqa@latest`, with a pnpm hint on failure |
| `-v, --version` · `-h, --help` | Version / help |

---

## Reviewing run archives (`pageqa sessions`)

How much of the scene you can inspect decides whether you can debug it at all. Every run writes "what was handed to the agent" plus "the full interaction" into `~/.pageqa/sessions/sessions.sqlite` (one **SQLite container** through pi's `@earendil-works/pi-durable`: one run is one member of the `pageqa.archive` document family, keyed by run id, while the list page's summaries live in the singleton `pageqa.index` document — archive and index are written in a single transaction), and `pageqa sessions` serves them:

- **Parameters handed to the agent**: system prompt, model, tool declarations (with JSON Schema), the step-numbered case and placeholder values;
- **Per-turn LLM context**: the messages actually sent on that turn (including context trimming) — answering "what did the model really see, and were earlier steps pushed out?";
- **Every tool call**: the arguments the model supplied, the result or failure reason, duration and verdict.

You can clean up straight from the page: a "delete" button on every list row, a "clear all" in the header, and "delete this run" on the detail page. Each asks for confirmation first (what is deleted is really gone, from both the list and the detail view); the same thing is available as `DELETE /api/sessions/<id>` and `DELETE /api/sessions`.

```bash
pageqa sessions                  # default http://127.0.0.1:7331/ (the port is bumped upward if taken)
pageqa sessions --port 8080      # pick a port
pageqa sessions --dir ./archives # use another archive directory
pageqa sessions --no-open        # do not open the browser automatically
```

Archives are written automatically by every run, with no extra switch; in suite mode each scenario gets its own. They live in the **user directory** rather than the working directory, and `--no-side-outputs` does not turn them off — this is a debugging tool, not a test artifact; only the latest 200 runs are kept. Since an archive contains the system prompt, case text and page snapshots, the server binds to loopback (`127.0.0.1`) only.

---

## Architecture (layered / module view)

The diagram below is the **layered view** — one box per layer (the module list is inside each box), and only the main flow between layers. The runtime sequence is in "How it works" right after; the per-file breakdown lives in `src/`.

```mermaid
flowchart TD
  subgraph ENTRY["Entry & orchestration · src/index.ts + src/agent"]
    CLI["index.ts<br/>parseArgs · main<br/>batch / interactive --tui / replay / lint / sessions"]
    RUN["agent.ts · suite.ts · record.ts · replay.ts · lint.ts · vars.ts · timing.ts<br/>runAgent / runSuite (one child process per scenario)<br/>record operations → zero-model replay · case-format lint"]
  end

  subgraph TUI["Interactive mode · src/tui"]
    APP["app.ts · queue.ts · writeback.ts · case-source.ts · batches.ts<br/>kanban band + log viewport + bottom input<br/>serial by default, concurrency 1/2/3/4/6/8"]
  end

  subgraph BSK["bsk tool layer · src/bsk"]
    TOOLS["tools.ts — 21 tools<br/>async · abortable · globally serial<br/>picker.ts · condition.ts · settle.ts<br/>ipc.ts · navigate-diagnosis.ts"]
  end

  subgraph LLMC["LLM & config · src/config + src/llm"]
    MODELS["models.ts · llm.ts · free-providers.ts<br/>auth.ts · config.ts · proxy.ts · jev.ts"]
  end

  subgraph SIDE["Report & archives · src/report + src/session"]
    REPORT["report.ts · report-html.ts · side-outputs.ts<br/>downloads.ts · screenshots.ts"]
    ARCHIVE["archive.ts (one SQLite container)<br/>server.ts (pageqa sessions)"]
  end

  XCUT["Cross-cutting · src/shared: i18n.ts localization · log.ts logging · locator.ts semantic locators · snapshot.ts snapshot slimming · version.ts"]
  BROWSER["Real browser (connected by the bsk daemon)"]

  CLI -->|"batch / --replay"| RUN
  CLI -->|"--tui / auto-detected TTY"| APP
  CLI -->|"sessions"| ARCHIVE
  APP -->|"runAgent"| RUN
  RUN --> MODELS
  RUN --> TOOLS
  RUN --> REPORT
  RUN --> ARCHIVE
  TOOLS --> BROWSER
```

### How it works

```
Natural-language intent
   └─> pi-agent-core agent (LLM: configurable OpenAI-compatible endpoint)
          └─> every request goes through proxy.ts first: per-domain direct / via proxy / direct-then-proxy
          └─> bsk tools: navigate / snapshot / click / fill / select_option / pick_date / upload / download / hover / scroll / press / wheel / focus / blur / get_html / screenshot / wait / wait_for / assert_text / assert_no_console_error / assert_network
                 └─> real browser (connected by bsk)
          └─> conclusion & evidence -> report (text/JSON) + exit code
          └─> by default: record successful operations -> replay script (*.replay.json; off in /setting)

Replay script -> pageqa --replay -> reuses the same bsk op layer -> real browser -> report + exit code (no LLM called)

Interactive mode (pageqa / --tui; load cases with /run)
   ├─> TUI: kanban band (5 status columns) + scrolling log viewport (progress logs merged via setSink) + fixed bottom input box
   ├─> run queue: serial by default (concurrency 1/2/3/4/6/8 via /setting); submitted new scenarios are written back to the target then enqueued
   └─> exit -> restore main screen -> summary report (stdout/--out) + exit code (cancelled not counted)
```

Available tools (`src/bsk/tools.ts`): `navigate` opens a page; `snapshot` reads the page's aria tree and visible text (with slimming and reuse; the `refs` mode keeps only the interactive-element list); `click`/`fill`/`hover` element interactions (pass `showPage: true` to get a post-action element list appended, saving the follow-up snapshot); `select_option` picks a dropdown/cascader option in one call (open -> wait for the overlay -> match by visible text; it **appends** a post-action interactive-element list by default, since such an action always changes the page and invalidates old `@eN` refs — pass `showPage: false` to opt out); `pick_date` picks a date in one call (open the panel -> navigate to the target month -> click the day; accepts `2026-09-29` / `today` / `+3` / `-7`; for **date ranges** pass the end date as `endDate` and it walks "pick start -> pick end -> confirm", failing loudly when the panel type and the arguments disagree instead of leaving a half-finished range); `upload` uploads a local file; `download` captures a browser download (itself an assertion); `scroll` scrolls to an element; `press` sends a **real** keyboard key (Enter to submit in an input, `Escape` to close a dialog, `Tab` through focus order; pass `target` to focus an element first, otherwise the key goes to the current focus, i.e. wherever the previous `fill` left it); `wheel` dispatches a **real wheel event** (infinite-scroll bottom callbacks and horizontal scrollers only respond to this — `scroll` is "scroll the element into view" and fires no scroll event; positive `deltaY` scrolls down, roughly 600–800 per screen); `focus`/`blur` focus and blur an element (form validation usually hangs off blur, so "fill → blur → assert the error message" is a standard chain, and blur is cleaner than clicking elsewhere); `get_html` dumps the raw DOM HTML (covers what the snapshot cannot see — `class`/`data-*`/`value` **attributes**; capped at 16 KiB inline by default, pass `out` to write a larger dump to a file); `screenshot` captures evidence (viewport by default, `fullPage: true` for the whole page, `target` with an `@eN` ref to crop to one element; images are **inlined into the HTML report** and also kept under `~/.pageqa/screenshots` — it is a read-only action that **produces no assertion**); `wait`/`wait_for` wait (`wait_for`'s element conditions — `selector` / `gone` — go through bsk's native `wait-for-element`: one round trip covers the whole budget with polling inside the browser extension, unaffected by background-tab timer throttling; text conditions are still polled page-side by pageqa for at most 5 seconds (matching normalizes whitespace, so text split across nodes still matches) — use `wait` for longer waits; `selector` waits for **visible** by default and `state: visible|hidden|attached|detached` asks instead for "entered the DOM" or "actually left the DOM"; `gone` equals `hidden` — hidden by `v-show` / `display:none` counts as gone, use `state: "detached"` to require removal; timeout reports separate "was it still in the DOM" from "was it visible"; on a bsk without this command it falls back to the page-side probe with identical conclusions and evidence wording); `assert_text` asserts the page contains the specified text (pass `absent: true` to assert it **does not** contain it — negation belongs in that flag, not in the expectation string); `assert_no_console_error` asserts the page raised no JavaScript errors (uncaught exceptions plus `console.error` / browser error logs — **these never surface as page text**, so `assert_text` can never see them; `ignore` whitelists known noise and `warnings: true` counts warnings too); `assert_network` asserts a request happened and its status matches (`url` is matched as a substring, `status` takes `200` or `2xx`, and omitting `status` means "the request completed successfully").

**Stale refs self-heal**: any action using an expired `@eN` is refused — that is what keeps it from silently clicking whatever element now holds that number (see the header of `locator.ts`) — and the error carries the **current interactive-element list** right in it, so the model retries with a fresh ref instead of spending another round trip on a snapshot (`select_option` / `pick_date` also append that list on **success**, so "select one widget, then the next" no longer costs an extra turn).

Picker widgets (Element Plus and friends) use a **mixed strategy**: `.el-*` class contracts first (steadier than the aria tree), then generic ARIA selectors such as `[role=listbox]`; when neither hits, the tool fails honestly and lists the currently selectable options so the model can fall back to the generic "look at the snapshot and click" path — it **never guesses** at an element. Why a dedicated layer: on the generic path "open -> snapshot -> click the option" costs three LLM round trips, and stepping through calendar months costs one snapshot per click; collapsing that into a single call takes picking a date from over ten seconds down to a few.

Long-flow protection (auto-retry): after one conversation round, if the agent's self-reported progress isn't full (`steps done: k/n` with `k < n`), or the case had assertions but the report only parsed some, pageqa automatically appends a "continue remaining steps" prompt and keeps going, at most 5 rounds; if a continuation round moves neither progress nor the assertion count, it stops there instead of burning the remaining rounds.

See `src/` for the full directory breakdown.

---

## Verification & CI

```bash
pnpm install --frozen-lockfile && pnpm run build
pnpm run test:unit     # unit tests: no browser / LLM / TTY dependency
pnpm test              # end-to-end smoke: needs bsk connected to a browser + an available LLM endpoint
```

`examples/smoke.md` works as an end-to-end sample (`pageqa run examples/smoke.md --json`). Inject the LLM endpoint in CI to use pageqa as a quality gate (`node dist/index.js run --json examples/smoke.md`).
