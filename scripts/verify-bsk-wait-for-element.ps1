<#
.SYNOPSIS
  端到端验证 bsk wait-for-element（CLI → daemon → 浏览器扩展 → 页面）。

.DESCRIPTION
  覆盖七种情形：
    T1  已可见的元素      —— 立即返回 satisfied=true
    T2  从未出现的元素    —— detached 视为已满足（not_found 是观测结果不是错误）
    T3  在 DOM 但不可见   —— 超时，且证据为 attached=true / visible=false
    T4  延迟出现的元素    —— 等到它出现（elapsed_ms 反映真实等待）
    T5  延迟移除的元素    —— detached 在元素真正离开 DOM 时才满足
    T6  ref 路径          —— @eN 引用同样可用，回显 used_ref
    T7  human 模式        —— 超时退出码仍为 0，stdout 带 satisfied=false

  前置条件：
    - bsk 二进制包含 wait-for-element 命令；
    - 浏览器扩展是包含 tool.wait_for_element 的新构建
      （改完源码后需在 chrome://extensions 重新加载 apps/extension/.output/chrome-mv3）；
    - 脚本会先停掉在跑的旧 daemon，让 CLI 用新构建重新拉起。

.PARAMETER BskExe
  bsk 可执行文件路径；默认取 PATH 上的 bsk。

.PARAMETER Url
  测试页面；默认 https://example.com（元素通过 evaluate 动态注入，不依赖特定页面）。

.EXAMPLE
  .\verify-bsk-wait-for-element.ps1 -BskExe D:\1project\BrowserSkill\target\debug\bsk.exe
#>
# NOTE: keep this file saved as UTF-8 *with BOM*. Windows PowerShell 5.1 reads
# .ps1 as the system ANSI code page; without the BOM the Chinese text turns into
# mojibake that also swallows quotes, and the script fails to parse.

param(
  [string]$BskExe = "bsk",
  [string]$Url = "https://example.com"
)

$ErrorActionPreference = "Continue"
$script:pass = 0
$script:fail = 0
$script:unknownMethod = $false
$script:sid = ""
$script:ErrFile = Join-Path $env:TEMP "bsk-verify-stderr.txt"

function Invoke-Bsk {
  # NOTE: keep this file saved as UTF-8 *with BOM*. Windows PowerShell 5.1 reads
# .ps1 as the system ANSI code page; without the BOM the Chinese text turns into
# mojibake that also swallows quotes, and the script fails to parse.

param([string[]]$BskArgs)
  $stdout = & $BskExe @BskArgs 2>$script:ErrFile
  $err = Get-Content $script:ErrFile -Raw -ErrorAction SilentlyContinue
  if ($err -match "unknown_method") { $script:unknownMethod = $true }
  [pscustomobject]@{
    ExitCode = $LASTEXITCODE
    Stdout   = (($stdout | ForEach-Object { $_.ToString() }) -join "`n")
    Stderr   = $err
  }
}

function Check {
  # NOTE: keep this file saved as UTF-8 *with BOM*. Windows PowerShell 5.1 reads
# .ps1 as the system ANSI code page; without the BOM the Chinese text turns into
# mojibake that also swallows quotes, and the script fails to parse.

param([string]$Name, [bool]$Ok, [string]$Detail = "")
  if ($Ok) { $script:pass++; Write-Output ("PASS  {0}   {1}" -f $Name, $Detail) }
  else     { $script:fail++; Write-Output ("FAIL  {0}   {1}" -f $Name, $Detail) }
}

# 以 --json 调用并解析；解析失败返回 $null（调用方据此判失败）
function Wait-ElementJson {
  # NOTE: keep this file saved as UTF-8 *with BOM*. Windows PowerShell 5.1 reads
# .ps1 as the system ANSI code page; without the BOM the Chinese text turns into
# mojibake that also swallows quotes, and the script fails to parse.

param([string]$Target, [string]$State, [string]$Timeout = "5s")
  $r = Invoke-Bsk @("wait-for-element", $Target, "--state", $State,
                    "--timeout", $Timeout, "--session", $script:sid, "--json")
  if ($r.ExitCode -ne 0) { return $null }
  try { return $r.Stdout | ConvertFrom-Json } catch { return $null }
}

Write-Output "bsk   : $BskExe"
Write-Output "页面  : $Url"
Write-Output ""

# --- 0. 命令存在 -----------------------------------------------------------
$help = Invoke-Bsk @("wait-for-element", "--help")
Check "T0 命令存在" (($help.ExitCode -eq 0) -and ($help.Stdout -match "Wait until an element")) ""

# --- 0.5 停掉旧 daemon（老构建不含新方法，会让所有调用变成 unknown_method）-----
$null = Invoke-Bsk @("daemon", "stop")
Start-Sleep -Milliseconds 800

# --- 1. 会话与页面 -----------------------------------------------------------
$script:sid = ((Invoke-Bsk @("session", "start")).Stdout -split "`n" |
               Where-Object { $_.Trim() } | Select-Object -Last 1).Trim()
Check "T1 会话启动" ($script:sid -match "^[A-Za-z0-9]{2,}$") "session=$script:sid"
if (-not $script:sid) { Write-Output "无法取得 session id，中止。"; exit 1 }

$nav = Invoke-Bsk @("navigate", $Url, "--session", $script:sid)
Check "T1 打开页面" ($nav.ExitCode -eq 0) $Url

# --- T2 已可见的元素：立即返回 ------------------------------------------------
$j = Wait-ElementJson "body" "visible" "5s"
Check "T2 已可见立即返回" (($null -ne $j) -and $j.satisfied -and $j.attached -and $j.visible) "elapsed=$($j.elapsed_ms)ms"

# --- T3 从未出现的元素：detached 直接满足 -------------------------------------
$j = Wait-ElementJson "#qa-nope" "detached" "3s"
Check "T3 缺席视为 detached" (($null -ne $j) -and $j.satisfied -and (-not $j.attached)) "elapsed=$($j.elapsed_ms)ms"

# --- T4 在 DOM 但不可见：超时并给出证据 ----------------------------------------
$js = '(() => { var d = document.createElement(\"div\"); d.id = \"qa-hidden\"; d.style.display = \"none\"; document.body.appendChild(d); return \"ok\"; })()'
$null = Invoke-Bsk @("evaluate", $js, "--session", $script:sid)
$j = Wait-ElementJson "#qa-hidden" "visible" "2s"
Check "T4 在但不可见：satisfied=false + 证据" (($null -ne $j) -and (-not $j.satisfied) -and $j.attached -and (-not $j.visible)) "attached=$($j.attached) visible=$($j.visible)"

# --- T5 延迟出现：真的等到了它 --------------------------------------------------
$js = 'setTimeout(function () { var d = document.createElement(\"div\"); d.id = \"qa-late\"; d.textContent = \"late\"; document.body.appendChild(d); }, 800); \"scheduled\"'
$null = Invoke-Bsk @("evaluate", $js, "--session", $script:sid)
$j = Wait-ElementJson "#qa-late" "visible" "5s"
Check "T5 延迟出现被等到" (($null -ne $j) -and $j.satisfied -and ($j.elapsed_ms -ge 300)) "elapsed=$($j.elapsed_ms)ms"

# --- T6 延迟移除：detached 在真正离开 DOM 时才满足 -------------------------------
$js = '(function () { var d = document.createElement(\"div\"); d.id = \"qa-doomed\"; document.body.appendChild(d); setTimeout(function () { var x = document.getElementById(\"qa-doomed\"); if (x) { x.remove(); } }, 600); return \"ok\"; })()'
$null = Invoke-Bsk @("evaluate", $js, "--session", $script:sid)
$j = Wait-ElementJson "#qa-doomed" "detached" "5s"
Check "T6 延迟移除被等到" (($null -ne $j) -and $j.satisfied -and (-not $j.attached)) "elapsed=$($j.elapsed_ms)ms"

# --- T7 ref 路径 ----------------------------------------------------------------
$snap = (Invoke-Bsk @("snapshot", "--session", $script:sid)).Stdout
$ref = [regex]::Match($snap, "@e\d+").Value
if ($ref) {
  $j = Wait-ElementJson $ref "visible" "5s"
  Check "T7 ref 路径可用" (($null -ne $j) -and $j.satisfied -and ($j.used_ref -match "^e\d+$")) "ref=$ref used_ref=$($j.used_ref)"
} else {
  Check "T7 ref 路径可用" $false "快照里没找到 @eN"
}

# --- T8 human 模式：超时不算失败 --------------------------------------------------
$h = Invoke-Bsk @("wait-for-element", "#qa-nope", "--state", "visible",
                  "--timeout", "1s", "--session", $script:sid)
Check "T8 human 模式：超时退出码为 0" (($h.ExitCode -eq 0) -and ($h.Stdout -match "satisfied=false")) ($h.Stdout.Trim())

# --- 收尾 -----------------------------------------------------------------------
$null = Invoke-Bsk @("session", "stop", $script:sid)

Write-Output ""
Write-Output ("结果: {0} 通过 / {1} 失败" -f $script:pass, $script:fail)
if ($script:unknownMethod) {
  Write-Output "提示：出现 unknown_method —— 浏览器扩展还是旧构建。" +
    "请在 chrome://extensions 重新加载 $PSScriptRoot\..\BrowserSkill\apps\extension\.output\chrome-mv3 后重跑。"
}
if ($script:fail -gt 0) { exit 1 }
