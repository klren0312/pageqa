@echo off
REM =====================================================================
REM  Pre-training launcher: sets HF mirror, installs deps, builds dist,
REM  runs optional baseline eval, then trains (QLoRA).
REM  Usage:
REM    train\run.bat
REM    train\run.bat --config train\config.yaml
REM  Env toggles:
REM    set BASELINE=1        enable the baseline eval step (needs an LLM service up)
REM    set FORCE_BUILD=1     force pnpm build even if dist already exists
REM =====================================================================

set HF_ENDPOINT=https://hf-mirror.com
set HF_HUB_ENABLE_HF_TRANSFER=1

cd /d "%~dp0\.."
echo [run] HF_ENDPOINT=%HF_ENDPOINT%
echo [run] workdir: %CD%

REM ---- install python deps (skips if already present) ----
echo [run] checking python deps...
pip install -r "%~dp0requirements.txt" --quiet

REM ---- ensure dist is built (baseline eval falls back to node dist/index.js) ----
if "%FORCE_BUILD%"=="1" (
  echo [run] force build via pnpm build...
  call pnpm build
) else if not exist "dist" (
  echo [run] dist missing, building via pnpm build...
  call pnpm build
) else (
  echo [run] dist exists, skip build; set FORCE_BUILD=1 to force
)

REM ---- baseline eval: opt-in, enabled by set BASELINE=1 (needs an LLM service up) ----
if "%BASELINE%"=="1" (
  echo [run] baseline eval before training...
  python train/evaluate.py run --config "%~dp0config.yaml" --out "%~dp0outputs/metrics/baseline.json"
  if errorlevel 1 (
    echo [run] baseline eval failed: LLM service not up or pageqa missing; skipped, training continues
  ) else (
    echo [run] baseline saved: train/outputs/metrics/baseline.json
  )
) else (
  echo [run] skip baseline eval; set BASELINE=1 to enable
)

echo [run] start training...
python train/train_qlora.py --config "%~dp0config.yaml" %*

echo [run] training done, exit=%ERRORLEVEL%
pause
