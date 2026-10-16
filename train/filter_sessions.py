#!/usr/bin/env python3
"""
过滤 export-sessions.mjs 导出的轨迹，产出「高质量」SFT 训练集。

一条轨迹 = export-sessions.mjs 的一条记录 { id, model, messages }，
messages 是最后一轮的累积上下文（system / user / assistant / tool），
assistant 的动作以 `[toolCall] <name> <json args>` 文本行存在（见 src/session/archive.ts）。

本脚本在「已 pass」的基础上，进一步剔除学坏/走弯路的轨迹，保留「快而准」的短路径：
  - 丢弃：用了 wait(ms) 猜秒数的（应改用 wait_for 条件等待）；
  - 丢弃：同一动作连续重复的（典型卡顿/重试迹象）；
  - 丢弃：工具结果里出现错误标记的（过程有 [tool-error]）；
  - 打分：优先用塌缩型单调用工具 select_option / pick_date（+2），
          snapshot 往返越多越「慢」（-1），按分排序保留前 --top 比例或高于 --min-score 的；
  - 去重：按「用户用例文本 + 最终动作序列」哈希，去掉重复/近似重复。

用法（在项目根目录）：
  node scripts/export-sessions.mjs --out train/data/sessions.jsonl     # 先导出
  python train/filter_sessions.py                                       # 过滤 + 去重 -> train/data/filtered.jsonl
  python train/filter_sessions.py --in train/data/sessions.jsonl --out train/data/train_in.jsonl --top 0.6 --min-score 1
"""
import argparse
import hashlib
import json
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

TOOLCALL_RE = re.compile(r"\[toolCall\]\s+([A-Za-z0-9_]+)\s*(.*)")

WAIT_GUESS = {"wait"}                       # wait(ms) 猜秒数：坏
WAIT_CONDITIONAL = {"wait_for", "waitfor"}  # 条件等待：好
COLLAPSED = {"select_option", "selectoption", "pick_date", "pickdate"}  # 塌缩型单调用：好
SNAPSHOT = {"snapshot"}

ERROR_MARKERS = ("[tool-error]", "[toolError]", "Error:", "错误", "失败：", "超时")


def resolve(p):
    return p if os.path.isabs(p) else os.path.join(ROOT, p)


def extract_toolcalls(messages):
    """返回 [(name, args_str, assistant_index)]，按出现顺序。"""
    calls = []
    for i, m in enumerate(messages):
        if m.get("role") != "assistant":
            continue
        content = m.get("content")
        if not isinstance(content, str):
            continue
        for line in content.splitlines():
            mm = TOOLCALL_RE.match(line.strip())
            if mm:
                calls.append((mm.group(1).lower(), mm.group(2).strip(), i))
    return calls


def has_error_toolresult(messages):
    for m in messages:
        if m.get("role") == "tool":
            c = m.get("content")
            if isinstance(c, str) and any(mk in c for mk in ERROR_MARKERS):
                return True
    return False


def user_case_text(messages):
    """取第一条 user 消息文本作为「用例」指纹的一部分。"""
    for m in messages:
        if m.get("role") == "user":
            c = m.get("content")
            return c if isinstance(c, str) else ""
    return ""


def analyze(rec):
    """对一条轨迹打分并判断是否合格。返回 (ok, score, info)。"""
    messages = rec.get("messages") or []
    calls = extract_toolcalls(messages)
    names = [c[0] for c in calls]

    # 无实质动作：过滤
    if not calls:
        return False, 0, {"reason": "no-toolcall"}

    wait_guess = sum(1 for n in names if n in WAIT_GUESS)
    collapsed = sum(1 for n in names if n in COLLAPSED)
    snapshots = sum(1 for n in names if n in SNAPSHOT)

    # 连续重复动作（卡顿/重试迹象）：同一 name 连续出现 >=3 次
    stuck = False
    run = 1
    for a, b in zip(names, names[1:]):
        run = run + 1 if a == b else 1
        if run >= 3:
            stuck = True
            break

    info = {
        "n_calls": len(calls),
        "wait_guess": wait_guess,
        "collapsed": collapsed,
        "snapshots": snapshots,
        "stuck": stuck,
        "err": has_error_toolresult(messages),
    }

    if wait_guess > 0:
        info["reason"] = "wait-ms-guess"
        return False, 0, info
    if stuck:
        info["reason"] = "stuck-repeat"
        return False, 0, info
    if info["err"]:
        info["reason"] = "tool-error"
        return False, 0, info

    score = 2 * collapsed - 1 * snapshots
    info["reason"] = "ok"
    return True, score, info


def fingerprint(rec):
    messages = rec.get("messages") or []
    names = [c[0] for c in extract_toolcalls(messages)]
    case = re.sub(r"\s+", " ", user_case_text(messages)).strip()
    key = case + "|" + ">".join(names)
    return hashlib.md5(key.encode("utf-8")).hexdigest()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="inp", default="train/data/sessions.jsonl")
    ap.add_argument("--out", default="train/data/filtered.jsonl")
    ap.add_argument("--top", type=float, default=0.6, help="按分数保留前多少比例（0~1）")
    ap.add_argument("--min-score", type=int, default=0, help="低于该分数直接丢弃")
    ap.add_argument("--keep-all", action="store_true", help="只去坏样本+去重，不按分数截断")
    args = ap.parse_args()

    inp = resolve(args.inp)
    out = resolve(args.out)
    if not os.path.exists(inp):
        raise SystemExit(f"[filter] 找不到输入 {inp}，先运行 node scripts/export-sessions.mjs")

    records = []
    with open(inp, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                records.append(json.loads(line))

    kept, rejected = [], {"no-toolcall": 0, "wait-ms-guess": 0, "stuck-repeat": 0,
                          "tool-error": 0, "low-score": 0}
    for rec in records:
        ok, score, info = analyze(rec)
        if not ok:
            rejected[info.get("reason", "low-score")] = rejected.get(info.get("reason"), 0) + 1
            continue
        if not args.keep_all and score < args.min_score:
            rejected["low-score"] += 1
            continue
        rec["_score"] = score
        kept.append(rec)

    # 按分数从高到低
    kept.sort(key=lambda r: r["_score"], reverse=True)
    # 去重
    seen, deduped = set(), []
    dup = 0
    for rec in kept:
        fp = fingerprint(rec)
        if fp in seen:
            dup += 1
            continue
        seen.add(fp)
        deduped.append(rec)

    # top 比例截断
    final = deduped
    if not args.keep_all and 0 < args.top < 1:
        k = max(1, int(len(deduped) * args.top))
        final = deduped[:k]

    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        for rec in final:
            rec.pop("_score", None)
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")

    print(f"[filter] 输入 {len(records)} 条")
    print(f"[filter] 剔除：{rejected}")
    print(f"[filter] 去重：-{dup}")
    print(f"[filter] 输出 {len(final)} 条 -> {out}")
    if final:
        import statistics
        sc = [r.get('_score', 0) for r in final] or [0]
        print(f"[filter] 保留样本分数：min={min(sc)} max={max(sc)} mean={statistics.mean(sc):.2f}")


if __name__ == "__main__":
    main()