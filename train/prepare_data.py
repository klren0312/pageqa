#!/usr/bin/env python3
"""
把 export-sessions.mjs 抽出的轨迹转成训练集，做四件事：
  0) 清洗：剔除「一条 assistant 消息里发多个 [toolCall]」的轨迹。
     真实运行时一步只发一个调用，多调用样本会让模型学会「一次猜三步」
     （实测：微调后会连发 navigate+snapshot+wait_for，跳过用例要求的 click）。
  1) 快照截断：pageqa 的 aria 快照动辄几万字符，必须压短才能进 8GB 显存。
     策略：超长消息保留「头部 + 尾部」，中间丢弃（尾部常是 showPage 追加的可交互元素清单，
     对识别最有价值）。截断处标注原始长度，便于事后核对。
  2) 序列裁剪（关键）：超长轨迹**从头部**丢，保留最近几轮——
     之前的 tokenizer 截断是「保留开头、丢掉尾部」，等于把模型要学的
     最后一个动作（label）切掉，训练与推理分布完全错位。
  3) 95/5 切分：产出 train.jsonl / eval.jsonl。

仅对 role 为 user / tool 的消息做截断（这些是快照所在；system/assistant 一般较短）。

运行：
  python train/prepare_data.py --config train/config.yaml
"""
import argparse
import json
import os
import random
import re

import yaml

TOOL_CALL_RE = re.compile(r"^\[toolCall\]", re.M)
# `[toolCall] navigate {"url":...}` —— archive.ts 把结构化调用渲染成的文本，这里还原回原生 tool_calls
TOOL_CALL_LINE_RE = re.compile(r"^\[toolCall\]\s*(\S+)\s*(.*)$")
# 裁剪后留一点余量：训练侧还会按 token 再截一次，这里先保证「结尾的 label 完整」
BUDGET_RATIO = 0.95


def truncate(text: str, limit: int) -> str:
    """超长文本保留首尾，避免直接切片把最有价值的可交互元素清单切掉。"""
    if limit <= 0 or len(text) <= limit:
        return text
    head = int(limit * 0.6)
    tail = limit - head
    return (
        text[:head]
        + f"\n…[快照截断：原 {len(text)} 字符，保留首尾 {limit}]…\n"
        + text[-tail:]
    )


def load_config(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        return yaml.safe_load(f)


def load_tokenizer(cfg: dict):
    from transformers import AutoTokenizer

    base = cfg["model"]["base_model"]
    trust = bool(cfg["model"].get("trust_remote_code", False))
    tk = AutoTokenizer.from_pretrained(base, trust_remote_code=trust)
    if tk.pad_token is None:
        tk.pad_token = tk.eos_token
    return tk


def token_len(tk, messages, tools=None) -> int:
    """一条完整对话（含 chat 模板特殊 token 与工具 schema）的 token 数。"""
    text = tk.apply_chat_template(
        messages, tools=tools, tokenize=False, add_generation_prompt=False
    )
    return len(tk(text, add_special_tokens=False)["input_ids"])


def to_native_messages(messages):
    """把 archive 渲染出来的 `[toolCall] name args` 文本还原成原生 tool_calls。

    为什么必须还原：推理时 pageqa 通过 OpenAI tools 协议调用，模型要输出
    `<tool_call>{"name":..,"arguments":..}</tool_call>`。若直接把渲染文本当 SFT 目标，
    模型只会把调用写成一行业务文本，浏览器一步都不会动（实测三个场景全部 0 条工具记录）。
    """
    out = []
    for m in messages:
        content = m.get("content")
        if m.get("role") != "assistant" or not isinstance(content, str):
            out.append(m)
            continue
        calls, texts = [], []
        for line in content.splitlines():
            hit = TOOL_CALL_LINE_RE.match(line.strip())
            if not hit:
                texts.append(line)
                continue
            name, raw = hit.group(1), hit.group(2).strip()
            try:
                args = json.loads(raw) if raw else {}
            except json.JSONDecodeError:
                # 参数被截断的样本不能当正样本：丢掉这条轨迹（由调用方处理）
                return None
            calls.append(
                {"type": "function", "function": {"name": name, "arguments": args}}
            )
        msg = {"role": "assistant", "content": "\n".join(texts).strip()}
        if calls:
            msg["tool_calls"] = calls
        out.append(msg)
    return out


def group_messages(messages):
    """把消息按「一次动作 + 它的工具结果」分组：assistant 起头，后续 toolResult 归入同组。"""
    groups = []
    for m in messages:
        if m.get("role") == "assistant" or not groups:
            groups.append([m])
        else:
            groups[-1].append(m)
    return groups


def trim_from_head(tk, messages, budget: int, tools=None):
    """超预算时丢掉**最早**的对话组，保留 system 与结尾（label 所在）。

    返回 (裁剪后的消息, 丢掉的消息数)。已经放得下时原样返回。
    """
    if not messages or token_len(tk, messages, tools) <= budget:
        return messages, 0

    head = []
    rest = messages
    if messages[0].get("role") == "system":
        head, rest = [messages[0]], messages[1:]

    groups = group_messages(rest)
    keep = len(groups)
    dropped = 0
    kept = rest
    while keep > 0:
        kept = [m for g in groups[-keep:] for m in g]
        if token_len(tk, head + kept, tools) <= budget or keep == 1:
            break
        dropped += len(groups[len(groups) - keep])
        keep -= 1
    return head + kept, dropped


def fit_to_budget(tk, messages, budget: int, tools=None):
    """仍超预算时，进一步压缩中间的工具结果（保留首尾），绝不动最后一条 assistant 目标。

    前缀（system + 工具 schema）本身就有约 3.8k token，只靠丢旧轮次可能压不下来；
    这里再对最长的快照逐次收缩，保证训练侧的 tokenizer 截断永远不会去切 label。
    返回 (消息, 被压缩次数)。
    """
    shrinks = 0
    while token_len(tk, messages, tools) > budget:
        idx, size = -1, 200
        for i, m in enumerate(messages[:-1]):
            content = m.get("content")
            if m.get("role") in ("user", "tool") and isinstance(content, str):
                if len(content) > size:
                    idx, size = i, len(content)
        if idx < 0:
            break
        content = messages[idx]["content"]
        messages[idx]["content"] = truncate(content, max(200, int(len(content) * 0.6)))
        shrinks += 1
    return messages, shrinks


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default="train/config.yaml")
    args = ap.parse_args()
    cfg = load_config(args.config)
    d = cfg["data"]

    max_snap = int(d["max_snapshot_chars"])
    max_seq = int(d.get("max_seq_length", 2048))
    budget = int(max_seq * BUDGET_RATIO)
    in_file = d["in_file"]
    train_file = d["train_file"]
    eval_file = d["eval_file"]
    eval_split = float(d.get("eval_split", 0.05))
    seed = int(d.get("seed", 42))

    if not os.path.exists(in_file):
        raise SystemExit(
            f"找不到 {in_file}，请先运行：pnpm build && node scripts/export-sessions.mjs"
        )

    sessions = []
    with open(in_file, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                sessions.append(json.loads(line))

    # 合并持久化的增强数据（train/augment_data.py 产出），让 assert_text / 步骤完成度
    # 的强化轨迹在「重新 export-sessions 覆盖 sessions.jsonl」之后依然保留。
    aug_file = os.path.join(os.path.dirname(in_file), "augmented.jsonl")
    if os.path.exists(aug_file):
        n_aug = 0
        with open(aug_file, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    sessions.append(json.loads(line))
                    n_aug += 1
        print(f"[prepare] 已合并增强数据 {n_aug} 条（{aug_file}）")

    # 0) 统一固定前缀：存档里混着两种前缀——
    #    大窗口跑出来的「全量系统提示（4000 字符）+ 全量工具 schema（13.4k 字符）」，
    #    和小窗口跑出来的「压缩提示（1105 字符）+ 压缩工具（8.4k 字符）」。
    #    推理端模型名含 1.5b → 走小窗口/小模型压缩路径，所以训练必须统一到压缩这一套。
    def system_of(s):
        return next((m for m in s.get("messages", []) if m.get("role") == "system"), None)

    compact = [s for s in sessions if (sm := system_of(s)) and len(sm.get("content") or "") <= 2000]
    if compact:
        canonical_system = system_of(compact[0])["content"]
        canonical_tools = compact[0].get("tools") or []
        for s in sessions:
            for m in s.get("messages", []):
                if m.get("role") == "system":
                    m["content"] = canonical_system
            s["tools"] = canonical_tools
        print(
            f"[prepare] 统一固定前缀：压缩系统提示 {len(canonical_system)} 字符 + "
            f"{len(canonical_tools)} 个工具 schema"
        )

    # 0.5) 清洗多动作轨迹：一步多 [toolCall] 与 pageqa 的真实协议不符
    cleaned = []
    n_multi = 0
    for s in sessions:
        multi = any(
            m.get("role") == "assistant"
            and len(TOOL_CALL_RE.findall(m.get("content") or "")) > 1
            for m in s.get("messages", [])
        )
        if multi:
            n_multi += 1
            continue
        cleaned.append(s)
    sessions = cleaned
    if n_multi:
        print(f"[prepare] 剔除多动作轨迹 {n_multi} 条（一条消息里 >1 个 [toolCall]）")

    # 1) 截断每条消息里的长快照
    for s in sessions:
        for m in s.get("messages", []):
            if m.get("role") in ("user", "tool") and isinstance(m.get("content"), str):
                m["content"] = truncate(m["content"], max_snap)

    # 2) `[toolCall] xxx` 文本 -> 原生 tool_calls（训练目标必须是模型真实要输出的通道）
    #    所有运行的可用工具清单一致，取第一条带 tools 的轨迹作为规范清单，
    #    增强数据（augment_data.py 产出）没有 tools 字段，用规范清单补齐。
    canonical = next((s["tools"] for s in sessions if s.get("tools")), [])
    if not canonical:
        raise SystemExit(
            "[prepare] 数据里没有 tools 字段，请先重新导出：pnpm build && node scripts/export-sessions.mjs"
        )
    native = []
    n_parse_fail = 0
    for s in sessions:
        msgs = to_native_messages(s.get("messages", []))
        if msgs is None:
            n_parse_fail += 1
            continue
        s["messages"] = msgs
        s.setdefault("tools", canonical)
        native.append(s)
    sessions = native
    if n_parse_fail:
        print(f"[prepare] 剔除 toolCall 参数无法解析的轨迹 {n_parse_fail} 条")

    # 3) 超长轨迹从头部裁，保住结尾的 assistant 目标；仍超预算再收缩快照
    tk = load_tokenizer(cfg)
    trimmed = 0
    shrunk = 0
    lengths = []
    for s in sessions:
        msgs, dropped = trim_from_head(tk, s.get("messages", []), budget, s["tools"])
        if dropped:
            trimmed += 1
        msgs, shrinks = fit_to_budget(tk, msgs, budget, s["tools"])
        if shrinks:
            shrunk += 1
        s["messages"] = msgs
        lengths.append(token_len(tk, msgs, s["tools"]))
    lengths.sort()
    if lengths:
        n = len(lengths)
        print(
            f"[prepare] 序列裁剪：{trimmed} 条被裁掉较早轮次、{shrunk} 条被进一步收缩快照"
            f"（预算 {budget} tokens）| "
            f"长度 p50={lengths[n // 2]} p90={lengths[int(n * 0.9)]} max={lengths[-1]}"
        )

    random.seed(seed)
    random.shuffle(sessions)
    k = max(1, int(len(sessions) * (1 - eval_split)))
    train, ev = sessions[:k], sessions[k:]

    def dump(path, items):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            for it in items:
                f.write(json.dumps(it, ensure_ascii=False) + "\n")

    dump(train_file, train)
    dump(eval_file, ev)
    print(
        f"[prepare] 共 {len(sessions)} 条 | train={len(train)} eval={len(ev)} "
        f"| max_snapshot_chars={max_snap} | max_seq_length={max_seq}"
    )


if __name__ == "__main__":
    main()
