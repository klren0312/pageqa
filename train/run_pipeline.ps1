<#
 重训 + 合并 + 转 GGUF 一站式脚本。请在本机重启（释放 leaked CUDA context）后，
 用一个【普通的 PowerShell / CMD 终端】运行，不要用会 ~3.5 分钟强杀进程的托管环境
 （否则训练被打断会泄漏 CUDA 上下文，导致下一次续跑时 bitsandbytes 初始化失败）。

 用法（项目根目录）：
   powershell -ExecutionPolicy Bypass -File train/run_pipeline.ps1

 流程：
   1) 清空旧 LoRA 检查点 / 适配器，确保从基座 + 增强数据（train/augmented.jsonl）重新训练。
   2) 训练（带续跑）：若进程被中断（未写出最终 adapter），自动重跑并从最近 checkpoint 续训，
      直到 train/outputs/qwen2.5-1.5b-qlora/adapter_model.safetensors 出现。
   3) 合并 LoRA -> train/outputs/qwen2.5-1.5b-merged
   4) 转 GGUF(q8_0) -> train/outputs/gguf/qwen2.5-1.5b-merged-q8_0.gguf
      （该文件即 LM Studio 当前加载的模型，覆盖后重新加载即可）

 完成后：在 LM Studio 重新加载上述 GGUF，再跑评测：
   pageqa examples/element-plus-form.md --no-tui
#>
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot          # train/ -> 项目根目录
Set-Location $root

$adapterDir   = "train/outputs/qwen2.5-1.5b-qlora"
$finalAdapter = Join-Path $adapterDir "adapter_model.safetensors"

# 1) 清空旧产物，确保从增强数据重新训练（续跑仅用于单轮被中断时接着跑）
Write-Host "[pipeline] 清理旧 LoRA 产物 ..." -ForegroundColor Cyan
Remove-Item -Recurse -Force (Join-Path $adapterDir "checkpoint-*") -ErrorAction SilentlyContinue
Remove-Item -Force (Join-Path $adapterDir "adapter_model.safetensors"),
                   (Join-Path $adapterDir "training_args.bin"),
                   (Join-Path $adapterDir "added_tokens.json") -ErrorAction SilentlyContinue

# 2) 训练（续跑循环）
$attempt = 0
$maxAttempts = 30
while (-not (Test-Path $finalAdapter)) {
    $attempt++
    if ($attempt -gt $maxAttempts) { throw "训练失败次数过多，请检查 train/train.err" }
    Write-Host "[pipeline] 训练尝试 #$attempt（若被中断会自动续跑）..." -ForegroundColor Cyan
    python train/train_qlora.py --config train/config.yaml
    Start-Sleep -Seconds 2   # 让 GPU 上下文释放
}
Write-Host "[pipeline] 训练完成：$finalAdapter" -ForegroundColor Green

# 3) 合并 LoRA -> 完整模型
Write-Host "[pipeline] 合并 LoRA -> 完整模型 ..." -ForegroundColor Cyan
python train/merge.py --config train/config.yaml

# 4) 转 GGUF（q8_0，覆盖 LM Studio 当前加载的 GGUF）
Write-Host "[pipeline] 转换 GGUF(q8_0) ..." -ForegroundColor Cyan
python train/convert_to_gguf.py --quant q8_0

Write-Host "[pipeline] 全部完成。" -ForegroundColor Green
Write-Host "下一步：在 LM Studio 重新加载 train/outputs/gguf/qwen2.5-1.5b-merged-q8_0.gguf，然后运行：" -ForegroundColor Yellow
Write-Host "  pageqa examples/element-plus-form.md --no-tui" -ForegroundColor Yellow
