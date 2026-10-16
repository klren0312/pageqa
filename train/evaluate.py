#!/usr/bin/env python3
"""
用 pageqa 本身当评测闭环，对比微调前后「bsk 识别速度」。

两种用法：
  1) 跑一次，产出指标 JSON：
       python train/evaluate.py run --config train/config.yaml \
           --base-url http://127.0.0.1:1234/v1 --model qwen2.5-1.5b-merged \
           --out train/outputs/metrics/finetuned.json
     说明：模型需先由 LM Studio/llama.cpp/vLLM 以 OpenAI 兼容方式起好服务；
           base_url/model/api_key 会写进 PAGEQA_LLM_* 环境变量再起 pageqa 子进程。
           --base-url/--model 留空则直接用环境里已有的 PAGEQA_LLM_*。

  2) 对比两次指标（训练前 vs 训练后）：
       python train/evaluate.py compare \
           --baseline train/outputs/metrics/baseline.json \
           --finetuned train/outputs/metrics/finetuned.json

关键指标（对应「识别速度」）：
  - llm_calls  : LLM 往返次数（越少=识别越快、少走弯路）
  - input_tokens / output_tokens : 单轮上下文与生成量（越少=选得越准、上下文越短）
  - cache_read : 提示缓存命中（越高=前缀稳定、重复请求越省）
  - duration_ms: 墙钟总耗时
  - status / scenarios_pass / scenarios_fail : 通过与否（速度不能牺牲准确率）
"""
import argparse
import json
import os
import shutil
import subprocess
import sys

USAGE_PREFIX = "[pageqa:usage] "


def _resolve_pageqa_cmd(pageqa_cmd, root):
    """把 pageqa 启动命令解析为可在任意 cwd 下执行的列表：
    - 默认 'pageqa' 若在 PATH 上直接用；否则回退到仓库内 node dist/index.js
    - 自定义 'node dist/index.js' 类的脚本路径相对项目根解析
    """
    if not pageqa_cmd:
        return pageqa_cmd
    exe = pageqa_cmd[0]
    if exe == "pageqa":
        if shutil.which("pageqa") or shutil.which("pageqa.cmd") or shutil.which("pageqa.exe"):
            return pageqa_cmd
        return ["node", os.path.join(root, "dist", "index.js")] + pageqa_cmd[1:]
    if exe == "node" and len(pageqa_cmd) > 1 and not os.path.isabs(pageqa_cmd[1]):
        return ["node", os.path.join(root, pageqa_cmd[1])] + pageqa_cmd[2:]
    return pageqa_cmd


def run_pageqa(case, base_url, model, api_key, pageqa_cmd, root):
    env = os.environ.copy()
    if base_url:
        env["PAGEQA_LLM_BASE_URL"] = base_url
    if model:
        env["PAGEQA_LLM_MODEL"] = model
    if api_key:
        env["PAGEQA_LLM_API_KEY"] = api_key

    cmd = _resolve_pageqa_cmd(pageqa_cmd, root) + [
        case, "--json", "--usage-stream", "--no-tui", "--no-side-outputs",
    ]
    print(f"[eval] 运行：{' '.join(cmd)}")
    # Windows 上 npm 全局装的 pageqa 实为 pageqa.cmd，CreateProcess 不能直接执行 .cmd/.bat，
    # 必须走 shell（cmd /c）才能按 PATHEXT 解析；shell=True 对 node 也同样适用。
    # 子进程输出是 UTF-8（含中文），显式指定 encoding 避免中文 Windows 默认 GBK 解码崩溃；
    # errors="replace" 保证即使有乱字节也不会抛异常，并兜底成空串防止后续 splitlines 报 None。
    p = subprocess.run(
        cmd, env=env, capture_output=True,
        encoding="utf-8", errors="replace", shell=True,
    )
    return p.returncode, p.stdout or "", p.stderr or ""


def parse_usage(stderr):
    last = None
    for line in stderr.splitlines():
        if line.startswith(USAGE_PREFIX):
            try:
                last = json.loads(line[len(USAGE_PREFIX):])
            except json.JSONDecodeError:
                pass
    return last


def parse_report(stdout):
    s = stdout.strip()
    if not s:
        return None
    try:
        return json.loads(s)
    except json.JSONDecodeError:
        # stdout 可能夹了前导/后导文本，取第一个 { 到最后一个 } 之间的部分
        start = s.find("{")
        end = s.rfind("}")
        if start != -1 and end != -1 and end > start:
            try:
                return json.loads(s[start : end + 1])
            except json.JSONDecodeError:
                return None
    return None


def sum_usage(usages):
    agg = {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0,
           "reasoning": 0, "total": 0, "calls": 0}
    for u in usages:
        if not u:
            continue
        for k in agg:
            agg[k] += int(u.get(k, 0) or 0)
    return agg


def extract_metrics(stdout, stderr, case):
    usage = parse_usage(stderr)
    report = parse_report(stdout)
    if report is None:
        return {"case": case, "parse_ok": False,
                "error": "stdout 不是合法 JSON 报告", "raw_stdout": stdout[:500]}

    status = report.get("status")
    scenarios = report.get("scenarios") or []
    if scenarios:
        n_pass = sum(1 for s in scenarios if s.get("status") == "pass")
        n_fail = sum(1 for s in scenarios if s.get("status") == "fail")
        agg = usage or sum_usage([s.get("usage") for s in scenarios])
        steps = sum(len(s.get("steps") or []) for s in scenarios)
        ap = sum(len(s.get("assertions") or []) for s in scenarios)
        af = sum(1 for s in scenarios for a in (s.get("assertions") or [])
                 if a.get("verdict") == "fail")
    else:
        n_pass = 1 if status == "pass" else 0
        n_fail = 1 if status == "fail" else 0
        agg = usage or (report.get("usage") or {})
        steps = len(report.get("steps") or [])
        assertions = report.get("assertions") or []
        ap = len(assertions)
        af = sum(1 for a in assertions if a.get("verdict") == "fail")

    calls = int(agg.get("calls", 0) or 0)
    inp = int(agg.get("input", 0) or 0)
    out = int(agg.get("output", 0) or 0)
    cache = int(agg.get("cacheRead", 0) or 0)
    total = int(agg.get("total", 0) or 0)
    dur = report.get("durationMs")

    return {
        "case": case,
        "parse_ok": True,
        "status": status,
        "scenarios_pass": n_pass,
        "scenarios_fail": n_fail,
        "assertions_pass": ap,
        "assertions_fail": af,
        "steps": steps,
        "llm_calls": calls,
        "input_tokens": inp,
        "output_tokens": out,
        "cache_read": cache,
        "total_tokens": total,
        "tokens_per_step": round(inp / steps, 1) if steps else None,
        "duration_ms": dur,
    }


def print_metrics(m):
    if not m.get("parse_ok"):
        print("  [解析失败]", m.get("error"))
        return
    print(f"  状态        : {m['status']}  (pass={m['scenarios_pass']} fail={m['scenarios_fail']})")
    print(f"  断言        : pass={m['assertions_pass']} fail={m['assertions_fail']}")
    print(f"  步骤数      : {m['steps']}")
    print(f"  LLM 往返    : {m['llm_calls']} 次   <- 越小识别越快")
    print(f"  token/步    : {m['tokens_per_step']}")
    print(f"  input tok   : {m['input_tokens']}")
    print(f"  output tok  : {m['output_tokens']}")
    print(f"  cache 命中  : {m['cache_read']}")
    print(f"  墙钟耗时    : {m['duration_ms']} ms")


def compare(b_path, f_path):
    with open(b_path, "r", encoding="utf-8") as fb:
        base = json.load(fb)
    with open(f_path, "r", encoding="utf-8") as ff:
        fine = json.load(ff)

    rows = [
        ("状态", base.get("status"), fine.get("status")),
        ("通过场景", base.get("scenarios_pass"), fine.get("scenarios_pass")),
        ("失败场景", base.get("scenarios_fail"), fine.get("scenarios_fail")),
        ("断言失败", base.get("assertions_fail"), fine.get("assertions_fail")),
        ("步骤数", base.get("steps"), fine.get("steps")),
        ("LLM 往返", base.get("llm_calls"), fine.get("llm_calls")),
        ("token/步", base.get("tokens_per_step"), fine.get("tokens_per_step")),
        ("input tok", base.get("input_tokens"), fine.get("input_tokens")),
        ("output tok", base.get("output_tokens"), fine.get("output_tokens")),
        ("cache 命中", base.get("cache_read"), fine.get("cache_read")),
        ("墙钟耗时 ms", base.get("duration_ms"), fine.get("duration_ms")),
    ]
    print(f"\n{'指标':<14}{'baseline':>14}{'finetuned':>14}   变化")
    print("-" * 58)
    for name, b, f in rows:
        if b is None and f is None:
            continue
        try:
            bv, fv = float(b), float(f)
            if bv:
                delta = f"{f'{(fv-bv)/abs(bv)*100:+.1f}%' if bv else ''}"
            else:
                delta = "n/a"
        except (TypeError, ValueError):
            delta = ""
        print(f"{name:<14}{str(b):>14}{str(f):>14}   {delta}")
    print("\n说明：LLM 往返 / token 类指标下降=识别更快更准；状态/失败场景上升=质量更好。")


def load_config(path):
    with open(path, "r", encoding="utf-8") as f:
        import yaml
        return yaml.safe_load(f)


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)

    rp = sub.add_parser("run", help="跑一次 pageqa，产出指标 JSON")
    rp.add_argument("--config", default="train/config.yaml")
    rp.add_argument("--case", default=None)
    rp.add_argument("--base-url", default=None)
    rp.add_argument("--model", default=None)
    rp.add_argument("--api-key", default=None)
    rp.add_argument("--pageqa-cmd", default=None, help="pageqa 启动命令，默认 ['pageqa']；仓库内可用 'node dist/index.js'")
    rp.add_argument("--out", default=None, help="指标 JSON 输出路径")

    cp = sub.add_parser("compare", help="对比 baseline 与 finetuned 两次指标")
    cp.add_argument("--baseline", required=True)
    cp.add_argument("--finetuned", required=True)

    args = ap.parse_args()

    if args.cmd == "compare":
        compare(args.baseline, args.finetuned)
        return

    # run
    cfg = load_config(args.config)
    ev = cfg.get("evaluate", {})
    root = os.path.dirname(os.path.dirname(os.path.abspath(args.config)))
    case = args.case or ev.get("case", "examples/smoke.md")
    base_url = args.base_url if args.base_url is not None else ev.get("base_url", "")
    model = args.model if args.model is not None else ev.get("model", "")
    api_key = args.api_key if args.api_key is not None else ev.get("api_key", "codebuddy-proxy-key")
    pageqa_cmd = args.pageqa_cmd.split() if args.pageqa_cmd else (
        ev.get("pageqa_cmd", "pageqa").split())
    out = args.out or ev.get("metrics_dir", "train/outputs/metrics") + "/run.json"
    if out.endswith("/") or os.path.isdir(out):
        out = os.path.join(out, "run.json")
    if not os.path.isabs(out):
        out = os.path.join(root, out)

    rc, so, se = run_pageqa(case, base_url, model, api_key, pageqa_cmd, root)
    metrics = extract_metrics(so, se, case)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        json.dump(metrics, f, ensure_ascii=False, indent=2)

    print(f"\n=== 指标 ({out}) ===")
    print_metrics(metrics)
    if not metrics.get("parse_ok"):
        print("\n--- pageqa stderr ---\n", se[-2000:])
    sys.exit(0 if (metrics.get("status") == "pass" or rc == 0) else 1)


if __name__ == "__main__":
    main()
