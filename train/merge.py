#!/usr/bin/env python3
"""
把训练出的 LoRA 适配器合并回基座，得到可直接被 bsk/pageqa 加载的模型。

合并方式：基座以 bf16 载入（可计算 dtype，不能在 4-bit 上直接 merge），
挂上 LoRA 后 merge_and_unload，落盘为 bf16 完整模型（1.5B 约 3GB）。
推理时由 LM Studio / llama.cpp / vLLM 按需在 4-bit 加载，8GB 本机也能跑。

运行：
  python train/merge.py --config train/config.yaml
  # 或覆盖路径：
  python train/merge.py --adapter train/outputs/qwen2.5-1.5b-qlora --out train/outputs/qwen2.5-1.5b-merged
"""
import argparse

import yaml
from peft import PeftModel
from transformers import AutoModelForCausalLM, AutoTokenizer


def load_config(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        return yaml.safe_load(f)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default="train/config.yaml")
    ap.add_argument("--adapter", default=None, help="LoRA 适配器目录（覆盖 config.merge.adapter_dir）")
    ap.add_argument("--out", default=None, help="合并后模型目录（覆盖 config.merge.merged_dir）")
    args = ap.parse_args()

    cfg = load_config(args.config)
    base = cfg["model"]["base_model"]
    m = cfg.get("merge", {})
    adapter = args.adapter or m.get("adapter_dir", "train/outputs/qwen2.5-1.5b-qlora")
    out = args.out or m.get("merged_dir", "train/outputs/qwen2.5-1.5b-merged")
    dtype = m.get("dtype", "bfloat16")

    print(f"[merge] 基座 {base} | 适配器 {adapter} | 输出 {out} | dtype {dtype}")

    tokenizer = AutoTokenizer.from_pretrained(base, trust_remote_code=False)
    base_model = AutoModelForCausalLM.from_pretrained(
        base, torch_dtype=dtype, trust_remote_code=False
    )
    peft_model = PeftModel.from_pretrained(base_model, adapter)
    merged = peft_model.merge_and_unload()

    merged.save_pretrained(out)
    tokenizer.save_pretrained(out)
    print(f"[merge] 完成 -> {out}")
    print("[merge] 下一步：用 LM Studio / llama.cpp / vLLM 打开该目录起 OpenAI 兼容服务，")
    print("       再把 PAGEQA_LLM_BASE_URL / PAGEQA_LLM_MODEL 指过去，用 train/evaluate.py 跑闭环评测。")


if __name__ == "__main__":
    main()
