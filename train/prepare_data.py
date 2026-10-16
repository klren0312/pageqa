#!/usr/bin/env python3
"""
把 export-sessions.mjs 抽出的轨迹转成训练集，并做两件事：
  1) 快照截断：pageqa 的 aria 快照动辄几万字符，必须压短才能进 8GB 显存。
     策略：超长消息保留「头部 + 尾部」，中间丢弃（尾部常是 showPage 追加的可交互元素清单，
     对识别最有价值）。截断处标注原始长度，便于事后核对。
  2) 95/5 切分：产出 train.jsonl / eval.jsonl。

仅对 role 为 user / tool 的消息做截断（这些是快照所在；system/assistant 一般较短）。

运行：
  python train/prepare_data.py --config train/config.yaml
"""
import argparse
import json
import os
import random

import yaml


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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default="train/config.yaml")
    args = ap.parse_args()
    cfg = load_config(args.config)
    d = cfg["data"]

    max_snap = int(d["max_snapshot_chars"])
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

    # 截断每条消息里的长快照
    for s in sessions:
        for m in s.get("messages", []):
            if m.get("role") in ("user", "tool") and isinstance(m.get("content"), str):
                m["content"] = truncate(m["content"], max_snap)

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
        f"| max_snapshot_chars={max_snap}"
    )


if __name__ == "__main__":
    main()
