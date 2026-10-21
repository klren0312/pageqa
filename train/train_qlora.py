#!/usr/bin/env python3
"""
1.5B QLoRA 训练：bitsandbytes 4-bit 量化 + PEFT LoRA。

关键点（对应本机 RTX 5060 Laptop 8GB）：
  - 4-bit NF4 量化基座（~0.75GB 权重） + double quant 再省一点；
  - LoRA 只训适配器，优化器/梯度状态极小；
  - gradient_checkpointing + batch=1 + paged_adamw_8bit 把峰值显存压到 8GB 内。
  - 输入序列已在 prepare_data.py 截断到 max_snapshot_chars，这里再按 max_seq_length 封顶。

运行（先在 config.yaml 同目录）：
  pip install -r train/requirements.txt
  python train/prepare_data.py --config train/config.yaml
  python train/train_qlora.py --config train/config.yaml
  # 多卡 / 更稳可用：accelerate launch train/train_qlora.py --config train/config.yaml

训练完推理性价比最高的是合并 LoRA 到基座（merge 脚本可后续补）；
直接用 PeftModel 推理也行：model = AutoModelForCausalLM.from_pretrained(base, ...);
peft_model = PeftModel.from_pretrained(model, output_dir)。
"""
import argparse
import inspect
import os

import torch
import yaml
from datasets import load_dataset
from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training
from transformers import (
    AutoModelForCausalLM,
    AutoTokenizer,
    BitsAndBytesConfig,
    Trainer,
    TrainingArguments,
)


def load_config(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        return yaml.safe_load(f)


def _resolve(p, root):
    """相对路径按项目根（config 所在目录的上一级，即 train/ 的父目录）解析，
    避免依赖运行时 cwd（如 run.bat 切到 train/ 时仍能正确定位数据/输出）。"""
    if not p or os.path.isabs(p):
        return p
    return os.path.join(root, p)


def build_bnb_config(q: dict) -> BitsAndBytesConfig:
    return BitsAndBytesConfig(
        load_in_4bit=q.get("load_in_4bit", True),
        bnb_4bit_quant_type=q.get("bnb_4bit_quant_type", "nf4"),
        bnb_4bit_compute_dtype=q.get("bnb_4bit_compute_dtype", "bfloat16"),
        bnb_4bit_use_double_quant=q.get("bnb_4bit_use_double_quant", True),
    )


def build_lora_config(l: dict) -> LoraConfig:
    return LoraConfig(
        r=int(l.get("r", 32)),
        lora_alpha=int(l.get("lora_alpha", 64)),
        lora_dropout=float(l.get("lora_dropout", 0.05)),
        bias=l.get("bias", "none"),
        task_type=l.get("task_type", "CAUSAL_LM"),
        target_modules=l.get(
            "target_modules",
            ["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
        ),
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default="train/config.yaml")
    args = ap.parse_args()
    cfg = load_config(args.config)
    # config 位于 train/config.yaml，其上级目录即为项目根
    root = os.path.dirname(os.path.dirname(os.path.abspath(args.config)))

    base = cfg["model"]["base_model"]
    trust = bool(cfg["model"].get("trust_remote_code", False))
    d = cfg["data"]
    max_seq = int(d.get("max_seq_length", 2048))

    print(f"[train] 基座：{base} | max_seq_length={max_seq}")

    tokenizer = AutoTokenizer.from_pretrained(base, trust_remote_code=trust)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    # 1) 基座：默认 4-bit（省显存）；可改用 fp16 以绕开 bitsandbytes 在某些环境
    #    下的初始化不稳定（leaked CUDA context 会导致 bnb 初始化失败）。
    q = cfg["quantization"]
    use_4bit = bool(q.get("load_in_4bit", True))
    if use_4bit:
        bnb = build_bnb_config(q)
        model = AutoModelForCausalLM.from_pretrained(
            base,
            quantization_config=bnb,
            device_map="auto",
            trust_remote_code=trust,
        )
        # 2) k-bit 训练准备（开启 grad checkpoint 必须的钩子）
        model = prepare_model_for_kbit_training(model)
    else:
        # 不走 device_map="auto"：否则 accelerate 会 import bitsandbytes 探测设备管理，
        # 在本机触发 bnb 初始化失败。改为 CPU 加载后显式搬 cuda。
        model = AutoModelForCausalLM.from_pretrained(
            base,
            torch_dtype=torch.bfloat16,
            trust_remote_code=trust,
        )
        model.gradient_checkpointing_enable()
        model.enable_input_require_grads()
        model = model.cuda()
    # 3) 挂 LoRA
    model = get_peft_model(model, build_lora_config(cfg["lora"]))
    model.print_trainable_parameters()

    # 4) 读数据并预分词（已截断过的文本）
    data_files = {
        "train": _resolve(d["train_file"], root),
        "eval": _resolve(d["eval_file"], root),
    }
    raw = load_dataset("json", data_files=data_files)

    def render(msgs, tools):
        return tokenizer.apply_chat_template(
            msgs, tools=tools, tokenize=False, add_generation_prompt=False
        )

    def tokenize(example):
        # 必须带 tools 一起渲染：推理时 21 个工具的 schema 由 API 传给模型，
        # 模板会把它们写进 system 段并规定 `<tool_call>{"name":..,"arguments":..}</tool_call>`
        # 的输出格式。不带 tools 渲染，训练分布与推理分布就是两套对话格式。
        msgs = example["messages"]
        tools = example.get("tools") or None
        text = render(msgs, tools)
        enc = tokenizer(text, truncation=True, max_length=max_seq, add_special_tokens=False)

        # labels 只在 assistant 段上计算（-100 屏蔽 system / 用例 / 工具结果）。
        # 全序列都算 loss 会让 1.5B 去「背」固定前缀：实测 loss 掉到 0.08，
        # 模型转而背诵训练样本（连发多个工具调用、抢答「步骤完成：4/4」）。
        # chat 模板是纯字符串拼接，所以「前缀渲染长度」就是各消息的分界。
        labels = [-100] * len(enc["input_ids"])
        prev = 0
        for i, m in enumerate(msgs):
            cur = len(tokenizer(render(msgs[: i + 1], tools), add_special_tokens=False)["input_ids"])
            if m.get("role") == "assistant":
                lo, hi = prev, min(cur, len(labels))
                if hi > lo:
                    labels[lo:hi] = enc["input_ids"][lo:hi]
            prev = cur
        # 兜底：没有任何 assistant 段时退回整段学习，避免整条样本没有监督信号
        enc["labels"] = labels if any(x != -100 for x in labels) else enc["input_ids"].copy()
        return enc

    tok = raw.map(tokenize, remove_columns=raw["train"].column_names)

    # 5) 训练参数（来自 config.training）
    tcfg = dict(cfg["training"])
    tcfg.setdefault("logging_steps", 10)
    # 兜底：过滤当前 transformers 版本的 TrainingArguments 不支持的键（避免版本差异直接崩溃）
    _valid = set(inspect.signature(TrainingArguments.__init__).parameters)
    _unknown = [k for k in tcfg if k not in _valid]
    if _unknown:
        print(f"[train] 忽略 TrainingArguments 不支持的参数: {_unknown}")
        tcfg = {k: v for k, v in tcfg.items() if k in _valid}
    training_args = TrainingArguments(**tcfg)

    # 数据已在 tokenize() 阶段预分词（input_ids/attention_mask/labels），
    # 直接用普通 Trainer，避开 SFTTrainer 各版本的参数改名/移除问题
    # （tokenizer->processing_class、max_seq_length->max_length、dataset_text_field 被删）。
    def collate(features):
        maxlen = max(len(f["input_ids"]) for f in features)
        pad_id = tokenizer.pad_token_id if tokenizer.pad_token_id is not None else 0
        ids, attn, labels = [], [], []
        for f in features:
            n = len(f["input_ids"])
            ids.append(f["input_ids"] + [pad_id] * (maxlen - n))
            attn.append(f["attention_mask"] + [0] * (maxlen - n))
            labels.append(f["labels"] + [-100] * (maxlen - n))  # padding 不参与 loss
        return {
            "input_ids": torch.tensor(ids, dtype=torch.long),
            "attention_mask": torch.tensor(attn, dtype=torch.long),
            "labels": torch.tensor(labels, dtype=torch.long),
        }

    trainer = Trainer(
        model=model,
        args=training_args,
        train_dataset=tok["train"],
        eval_dataset=tok["eval"],
        data_collator=collate,
    )

    out_dir = _resolve(tcfg.get("output_dir", "train/outputs/qwen2.5-1.5b-qlora"), root)
    tcfg["output_dir"] = out_dir
    # 支持从最新检查点续训：命令被长时间运行环境中断后，可重复执行本脚本接着跑，
    # 不必从头再来（每个 epoch 末尾都会落一个 checkpoint）。无检查点时从头训练。
    import glob as _glob
    _ckpts = _glob.glob(os.path.join(out_dir, "checkpoint-*"))
    _resume = True if _ckpts else None
    trainer.train(resume_from_checkpoint=_resume)
    trainer.save_model(out_dir)
    tokenizer.save_pretrained(out_dir)
    print("[train] 完成，模型已保存到", out_dir)


if __name__ == "__main__":
    main()
