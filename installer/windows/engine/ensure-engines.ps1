# ensure-engines.ps1 - keep-alive payload for the scheduled task.
#
# Health-checks colibri (:8000) and Ollama (:11434) and starts only what is
# down. Runs at logon + daily 06:45 (see register-engine-task.ps1), before
# the 07:00 scrape. Idempotent by construction; safe to run by hand.
#
# ASCII-only (PowerShell 5.1 ANSI-codepage parsing).
param(
  [Parameter(Mandatory = $true)][string]$KitRoot
)
$ErrorActionPreference = "Continue"

$EngineDir  = Join-Path $KitRoot "engine"
$ColibriDir = Join-Path $EngineDir "colibri"
$ModelDir   = Join-Path $EngineDir "glm52"
$LogFile    = Join-Path $EngineDir "engines.log"

function Log($msg) {
  $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg"
  Write-Host $line
  try { Add-Content -Path $LogFile -Value $line -Encoding ASCII } catch { }
}
function Test-Url($url) {
  try { Invoke-RestMethod -Uri $url -TimeoutSec 4 | Out-Null; return $true } catch { return $false }
}

Log "=== ensure-engines start ==="

# --- Ollama (gemma fallback ranker) ---
if (Test-Url "http://127.0.0.1:11434/api/tags") {
  Log "ollama already up on :11434"
} else {
  $exe = Get-Command ollama -ErrorAction SilentlyContinue
  if (-not $exe) {
    $p = Join-Path $env:LOCALAPPDATA "Programs\Ollama\ollama.exe"
    if (Test-Path $p) { $exe = Get-Item $p }
  }
  if ($exe) {
    Log "starting ollama serve ($($exe.FullName))"
    Start-Process -WindowStyle Hidden $exe.FullName -ArgumentList "serve"
  } else {
    Log "ollama not installed - skipping (gemma fallback unavailable)"
  }
}

# --- colibri (primary ranker) ---
if (-not (Test-Path (Join-Path $ColibriDir ".installed"))) {
  Log "colibri not installed - skipping (gemma-only ranking)"
} elseif (Test-Url "http://127.0.0.1:8000/health") {
  Log "colibri already up on :8000"
} else {
  # Try the release launchers in order: coli.cmd (Windows release shim),
  # then python coli (the repo's python launcher).
  $coliCmd = Join-Path $ColibriDir "coli.cmd"
  $started = $false
  if (Test-Path $coliCmd) {
    Log "starting colibri via coli.cmd (model: $ModelDir)"
    $env:COLI_MODEL = $ModelDir
    Start-Process -WindowStyle Hidden -WorkingDirectory $ColibriDir -FilePath $coliCmd -ArgumentList "serve", "--model", $ModelDir
    $started = $true
  } else {
    $py = Get-Command python -ErrorAction SilentlyContinue
    if (-not $py) { $py = Get-Command py -ErrorAction SilentlyContinue }
    $coliPy = Join-Path $ColibriDir "coli"
    if ($py -and (Test-Path $coliPy)) {
      Log "starting colibri via $($py.Source) $coliPy (model: $ModelDir)"
      $env:COLI_MODEL = $ModelDir
      Start-Process -WindowStyle Hidden -WorkingDirectory $ColibriDir -FilePath $py.Source -ArgumentList $coliPy, "serve", "--model", $ModelDir
      $started = $true
    }
  }
  if (-not $started) {
    Log "could not find a colibri launcher in $ColibriDir - inspect the release layout"
  } else {
    for ($i = 0; $i -lt 20; $i++) {
      if (Test-Url "http://127.0.0.1:8000/health") { Log "colibri is up on :8000"; break }
      Start-Sleep -Seconds 5
    }
    if (-not (Test-Url "http://127.0.0.1:8000/health")) { Log "colibri did not answer /health within 100s (weights still loading? check manually)" }
  }
}

Log "=== ensure-engines done ==="
