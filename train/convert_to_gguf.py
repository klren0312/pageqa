#!/usr/bin/env python3
"""
把合并后的 HF 模型（safetensors）转成 GGUF，供 LM Studio / llama.cpp 加载。

流程：
  1) 确保有 llama.cpp 的 convert_hf_to_gguf.py（缺失则 git clone 到 --tools-dir）
  2) 安装转换依赖（requirements-convert_hf_to_gguf.txt）
  3) 转 F16 GGUF
  4) 量化成 Q4_K_M：优先用已编译的 llama-quantize；否则从 GitHub releases 下载
     预编译 Windows 二进制；都没有则只保留 F16 并提示。

用法（在项目根目录运行）：
  python train/convert_to_gguf.py
  python train/convert_to_gguf.py --model train/outputs/qwen2.5-1.5b-merged --quant Q4_K_M
  python train/convert_to_gguf.py --quant none            # 只出 F16，不量化
  python train/convert_to_gguf.py --copy-to "D:\\Apps\\llmstudio\\model"   # 顺便放进 LM Studio 模型目录
"""
import argparse
import glob
import json
import os
import shutil
import subprocess
import sys
import urllib.request
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def log(msg):
    print(f"[gguf] {msg}", flush=True)


def resolve(p):
    return p if os.path.isabs(p) else os.path.join(ROOT, p)


def run(cmd, cwd=None):
    env = os.environ.copy()
    # 强制 UTF-8 模式：避免子进程（尤其源码构建时的 meson）用 GBK 解码而崩溃
    env["PYTHONUTF8"] = "1"
    log("$ " + " ".join(cmd))
    r = subprocess.run(cmd, cwd=cwd, env=env)
    if r.returncode != 0:
        raise SystemExit(f"[gguf] 命令失败（退出码 {r.returncode}）：{' '.join(cmd)}")


def ensure_llama_cpp(tools_dir):
    repo = os.path.join(tools_dir, "llama.cpp")
    conv = os.path.join(repo, "convert_hf_to_gguf.py")
    if os.path.exists(conv):
        log(f"已有 llama.cpp：{repo}")
        return repo
    if not shutil.which("git"):
        raise SystemExit("[gguf] 需要 git 才能克隆 llama.cpp，请先安装 Git 或手动放置 convert_hf_to_gguf.py")
    log("克隆 llama.cpp ...")
    run(["git", "clone", "--depth", "1", "https://github.com/ggml-org/llama.cpp.git", repo])
    return repo


def install_convert_deps(repo):
    # torch / transformers / numpy 本机已就绪，不重复安装——尤其不要碰 numpy：
    # 在 Python 3.14 上 pip 会尝试源码编译 numpy（meson + GBK 解码会崩）。
    # 这里只补装转换真正缺的轻量包：gguf（纯 Python）；sentencepiece 仅 SPM tokenizer 需要，
    # Qwen2 用的是 BPE（tokenizer.json），装不上也不影响。
    log("安装转换依赖 (gguf) ...")
    run([sys.executable, "-m", "pip", "install", "-U", "gguf", "--quiet"])
    try:
        run([sys.executable, "-m", "pip", "install", "-U", "sentencepiece", "--quiet"])
    except SystemExit:
        log("sentencepiece 安装失败（可忽略，Qwen2 用 BPE tokenizer）")


def convert_gguf(repo, model_dir, out, outtype):
    log(f"转换 GGUF (outtype={outtype}) ...")
    run([sys.executable, os.path.join(repo, "convert_hf_to_gguf.py"),
         model_dir, "--outfile", out, "--outtype", outtype])


def find_local_quantize(repo):
    cands = []
    cands += glob.glob(os.path.join(repo, "build", "bin", "**", "llama-quantize*"), recursive=True)
    cands += glob.glob(os.path.join(repo, "build", "**", "llama-quantize*"), recursive=True)
    for c in cands:
        if os.path.isfile(c) and os.path.splitext(c)[1].lower() in ("", ".exe"):
            return c
    return None


def download_quantize(tools_dir):
    """从 llama.cpp 最新 release 下载预编译 Windows 二进制，取出 llama-quantize.exe。"""
    log("尝试下载 llama.cpp 预编译 Windows 二进制（取 llama-quantize）...")
    try:
        api = "https://api.github.com/repos/ggml-org/llama.cpp/releases/latest"
        req = urllib.request.Request(api, headers={"User-Agent": "convert_to_gguf"})
        with urllib.request.urlopen(req, timeout=30) as r:
            data = json.load(r)
        url = name = None
        for a in data.get("assets", []):
            n = a["name"]
            if "win" in n and "x64" in n and n.endswith(".zip"):
                if "cpu" in n:
                    url, name = a["browser_download_url"], n
                    break
                url, name = url or a["browser_download_url"], name or n
        if not url:
            log("未找到合适的 Windows 预编译包")
            return None
        dest_dir = os.path.join(tools_dir, "llama_bin")
        os.makedirs(dest_dir, exist_ok=True)
        zp = os.path.join(dest_dir, name)
        log(f"下载 {name} ...")
        req = urllib.request.Request(url, headers={"User-Agent": "convert_to_gguf"})
        with urllib.request.urlopen(req, timeout=300) as r, open(zp, "wb") as f:
            shutil.copyfileobj(r, f)
        with zipfile.ZipFile(zp) as z:
            z.extractall(dest_dir)
        for c in glob.glob(os.path.join(dest_dir, "**", "llama-quantize*"), recursive=True):
            if os.path.isfile(c) and os.path.splitext(c)[1].lower() in ("", ".exe"):
                return c
    except Exception as e:  # 网络/接口失败则降级
        log(f"下载失败（{e}），将跳过量化")
    return None


def quantize(repo, tools_dir, in_f16, out_q, qtype):
    q = find_local_quantize(repo) or download_quantize(tools_dir)
    if not q:
        log("未找到 llama-quantize，跳过量化（仍可用 F16 GGUF）。")
        log("如需量化：在 llama.cpp 目录执行 cmake -B build && cmake --build build --config Release")
        return None
    log(f"量化 -> {qtype}（使用 {os.path.basename(q)}）")
    run([q, in_f16, out_q, qtype])
    return out_q


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="train/outputs/qwen2.5-1.5b-merged", help="合并后的 HF 模型目录")
    ap.add_argument("--outdir", default="train/outputs/gguf", help="GGUF 输出目录")
    ap.add_argument("--quant", default="q8_0",
                    help="量化类型；本版 convert_hf_to_gguf.py 直接支持 q8_0/f16/bf16 等；none=只出 F16。q4_k_m 需自建 llama-quantize")
    ap.add_argument("--name", default=None, help="输出文件基名（默认取模型目录名）")
    ap.add_argument("--tools-dir", default="train/outputs/llama.cpp", help="llama.cpp / 预编译包存放目录")
    ap.add_argument("--copy-to", default=None, help="把最终 GGUF 复制到该目录（如 LM Studio 模型目录）")
    args = ap.parse_args()

    model_dir = resolve(args.model)
    outdir = resolve(args.outdir)
    tools_dir = resolve(args.tools_dir)
    if not os.path.isdir(model_dir):
        raise SystemExit(f"[gguf] 找不到模型目录 {model_dir}，请先运行 python train/merge.py")

    os.makedirs(outdir, exist_ok=True)
    name = args.name or os.path.basename(os.path.normpath(model_dir))
    f16 = os.path.join(outdir, f"{name}-f16.gguf")
    qpath = os.path.join(outdir, f"{name}-{args.quant}.gguf") if args.quant.lower() != "none" else None

    repo = ensure_llama_cpp(tools_dir)
    install_convert_deps(repo)

    final = None
    # 优先：convert_hf_to_gguf.py 直接量化输出（新版支持，无需 llama-quantize）
    if qpath:
        try:
            convert_gguf(repo, model_dir, qpath, args.quant.lower())
            log(f"直接量化完成：{qpath}（{os.path.getsize(qpath)/1e9:.2f} GB）")
            final = qpath
        except SystemExit:
            log("直接量化失败，回退到 F16 + llama-quantize ...")

    if final is None:
        convert_gguf(repo, model_dir, f16, "f16")
        log(f"F16 完成：{f16}（{os.path.getsize(f16)/1e9:.2f} GB）")
        final = f16
        if qpath:
            got = quantize(repo, tools_dir, f16, qpath, args.quant)
            if got:
                log(f"量化完成：{got}（{os.path.getsize(got)/1e9:.2f} GB）")
                final = got

    if args.copy_to:
        dst_dir = resolve(args.copy_to)
        os.makedirs(dst_dir, exist_ok=True)
        dst = os.path.join(dst_dir, os.path.basename(final))
        shutil.copy2(final, dst)
        log(f"已复制到：{dst}")

    log("完成。把上面的 GGUF 拖进 LM Studio 即可加载。")


if __name__ == "__main__":
    main()