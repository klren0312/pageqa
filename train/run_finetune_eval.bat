@echo off
REM =====================================================================
REM  Post-merge one-click eval: run finetuned eval on the served merged
REM  model, then compare with the baseline produced by run.bat.
REM
REM  Prerequisites (manual):
REM    1) python train/merge.py --config train/config.yaml
REM       -> outputs/qwen2.5-1.5b-merged
REM    2) Open the merged dir with LM Studio / llama.cpp / vLLM and start
REM       an OpenAI-compatible server (e.g. http://127.0.0.1:1234/v1)
REM    3) Point PAGEQA_LLM_BASE_URL / PAGEQA_LLM_MODEL at that model
REM       (or override here with --base-url / --model)
REM
REM  Usage:
REM    train\run_finetune_eval.bat
REM    train\run_finetune_eval.bat --base-url http://127.0.0.1:1234/v1 --model qwen2.5-1.5b-merged
REM =====================================================================

cd /d "%~dp0\.."

set BASELINE=%~dp0outputs/metrics/baseline.json
set FINETUNED=%~dp0outputs/metrics/finetuned.json

echo [eval] running finetuned eval on merged model: %FINETUNED%
python train/evaluate.py run --config "%~dp0config.yaml" --out "%FINETUNED%" %*
if errorlevel 1 (
  echo [eval] finetuned eval failed: ensure merged model server is up and PAGEQA_LLM_* point to it, and pageqa is on PATH
  pause
  exit /b 1
)

if not exist "%BASELINE%" (
  echo [eval] baseline.json not found; run train\run.bat first to generate it. Showing finetuned metrics only.
) else (
  echo [eval] comparing baseline vs finetuned...
  python train/evaluate.py compare --baseline "%BASELINE%" --finetuned "%FINETUNED%"
)

echo [eval] done. Watch llm_calls / tokens_per_step / duration_ms go down, and status stay pass.
pause
