# jobscrape kit setup - Windows.
#
# Installs and starts the standalone jobscrape stack:
#   Docker Desktop -> Ollama -> gemma4 model -> config seed -> compose up
#   -> optional colibri engine + GLM-5.2 weights (~400 GB disk)
#
# ASCII-only on purpose: PowerShell 5.1 parses no-BOM .ps1 files in the ANSI
# codepage, and a single em-dash has eaten whole scripts before.
#
# Idempotent: every step detects an existing install and skips. Safe to
# re-run after a reboot mid-install.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File setup.ps1 [-WithColibri] [-SkipProbe] [-Port 8790] [-RunAt 07:00]
param(
  [switch]$WithColibri,   # also install colibri + GLM-5.2 int4 weights (~400 GB)
  [switch]$SkipProbe,     # skip the post-install dry-run scrape
  [string]$Port = "8790",
  [string]$RunAt = "07:00"
)
$ErrorActionPreference = "Stop"

$KitRoot     = $PSScriptRoot
$DeployDir   = Join-Path $KitRoot "deploy"
$JobscrapeDir = Join-Path $KitRoot "jobscrape"
$EngineDir   = Join-Path $KitRoot "engine"

function Write-Step($msg)  { Write-Host ""; Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)    { Write-Host "    OK: $msg" -ForegroundColor Green }
function Write-Warn2($msg) { Write-Host "    !! $msg" -ForegroundColor Yellow }
function Test-Cmd($name)   { return [bool](Get-Command $name -ErrorAction SilentlyContinue) }

# Set colibri.enabled in configs/base.json (PowerShell-native JSON - no
# node/python requirement on the friend's machine).
function Set-ConfigColibriEnabled([string]$KitRoot, [bool]$Value) {
  $file = Join-Path $KitRoot "jobscrape\configs\base.json"
  $json = Get-Content $file -Raw | ConvertFrom-Json
  if ($json.PSObject.Properties["colibri"]) {
    if ($json.colibri.PSObject.Properties["enabled"]) { $json.colibri.enabled = $Value }
    else { $json.colibri | Add-Member -MemberType NoteProperty -Name enabled -Value $Value }
  } else {
    $colibri = New-Object PSObject
    $colibri | Add-Member -MemberType NoteProperty -Name enabled -Value $Value
    $json | Add-Member -MemberType NoteProperty -Name colibri -Value $colibri
  }
  $json | ConvertTo-Json -Depth 20 | Set-Content $file -Encoding UTF8
  Write-Ok "colibri.enabled=$Value in configs/base.json"
}

# ---------------------------------------------------------------------------
Write-Step "1/7 Docker"
# ---------------------------------------------------------------------------
$dockerOk = $false
if (Test-Cmd docker) {
  docker info 2>$null | Out-Null
  if ($LASTEXITCODE -eq 0) { $dockerOk = $true; Write-Ok "docker engine already running" }
}
if (-not $dockerOk) {
  if (-not (Test-Cmd docker)) {
    Write-Host "    Docker not found - installing Docker Desktop (winget)..."
    if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
      Write-Warn2 "Docker Desktop install needs Administrator. Re-run this script from an elevated PowerShell."
      exit 1
    }
    winget install --id Docker.DockerDesktop -e --accept-source-agreements --accept-package-agreements
    if ($LASTEXITCODE -ne 0) { Write-Warn2 "winget install failed - install Docker Desktop manually from https://www.docker.com/products/docker-desktop/ then re-run setup"; exit 1 }
  }
  Write-Host "    Starting Docker Desktop..."
  $dd = Join-Path $env:ProgramFiles "Docker\Docker\Docker Desktop.exe"
  if (Test-Path $dd) { Start-Process $dd | Out-Null }
  Write-Host "    Waiting for the docker engine (up to 10 minutes)..."
  $ready = $false
  for ($i = 0; $i -lt 60; $i++) {
    docker info 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { $ready = $true; break }
    Start-Sleep -Seconds 10
  }
  if (-not $ready) { Write-Warn2 "docker engine did not come up (reboot may be required to finish WSL2 setup) - re-run setup after rebooting"; exit 1 }
  Write-Ok "docker engine is up"
}

# ---------------------------------------------------------------------------
Write-Step "2/7 Ollama"
# ---------------------------------------------------------------------------
if (-not (Test-Cmd ollama)) {
  $ollamaExe = Join-Path $env:LOCALAPPDATA "Programs\Ollama\ollama.exe"
  if (Test-Path $ollamaExe) { $env:Path += ";" + (Split-Path $ollamaExe) }
  else {
    Write-Host "    Ollama not found - installing (winget)..."
    winget install --id Ollama.Ollama -e --accept-source-agreements --accept-package-agreements
    $env:Path += ";" + (Join-Path $env:LOCALAPPDATA "Programs\Ollama")
  }
}
Write-Ok "ollama CLI present"

# Ensure the server is answering on :11434 (the Windows app usually
# autostarts; a bare `ollama serve` covers the rest).
$ollamaUp = $false
try {
  Invoke-RestMethod -Uri "http://127.0.0.1:11434/api/tags" -TimeoutSec 3 | Out-Null
  $ollamaUp = $true
} catch { }
if (-not $ollamaUp) {
  Write-Host "    Ollama server not answering - starting `ollama serve`..."
  Start-Process -WindowStyle Hidden "ollama" -ArgumentList "serve"
  for ($i = 0; $i -lt 15; $i++) {
    try { Invoke-RestMethod -Uri "http://127.0.0.1:11434/api/tags" -TimeoutSec 3 | Out-Null; $ollamaUp = $true; break } catch { Start-Sleep -Seconds 2 }
  }
}
if (-not $ollamaUp) { Write-Warn2 "could not reach Ollama on :11434 - the gemma fallback will be unavailable until it is running"; }
else { Write-Ok "Ollama server up on :11434" }

# ---------------------------------------------------------------------------
Write-Step "3/7 gemma4 model (fallback ranker)"
# ---------------------------------------------------------------------------
$haveGemma = $false
try {
  $tags = Invoke-RestMethod -Uri "http://127.0.0.1:11434/api/tags" -TimeoutSec 5
  foreach ($m in $tags.models) { if ($m.name -like "gemma4-e2b-64k*") { $haveGemma = $true } }
} catch { }
if ($haveGemma) { Write-Ok "gemma4-e2b-64k already present" }
elseif ($ollamaUp) {
  # gemma4-e2b-64k is not a registry model - it is a local 64k-context
  # variant of the public gemma4:e2b (CI-proven 2026-09-09: `ollama pull
  # gemma4-e2b-64k` fails everywhere except the machine that created the
  # variant by hand). Pull the public base, then build the variant.
  Write-Host "    Pulling gemma4:e2b (a few GB, one time)..."
  ollama pull gemma4:e2b
  if ($LASTEXITCODE -ne 0) { Write-Warn2 "ollama pull failed - ranking falls back to heuristics until this succeeds"; }
  else {
    Write-Host "    Creating the 64k-context variant (gemma4-e2b-64k)..."
    $mf = Join-Path $env:TEMP "gemma4-64k.modelfile"
    Set-Content -Path $mf -Value "FROM gemma4:e2b`r`nPARAMETER num_ctx 65536" -Encoding Ascii
    ollama create gemma4-e2b-64k -f $mf
    Remove-Item $mf -Force
    if ($LASTEXITCODE -ne 0) { Write-Warn2 "ollama create failed - ranking falls back to heuristics until this succeeds"; }
    else { Write-Ok "gemma4-e2b-64k ready (base gemma4:e2b + num_ctx 65536)" }
  }
}
else { Write-Warn2 "skipping model pull - no Ollama server" }

# ---------------------------------------------------------------------------
Write-Step "4/7 secrets (.env)"
# ---------------------------------------------------------------------------
$envFile = Join-Path $DeployDir ".env"
if (Test-Path $envFile) {
  Write-Ok "deploy/.env already exists - keeping it"
} else {
  $bytes = New-Object byte[] 32
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $token = ($bytes | ForEach-Object { $_.ToString("x2") }) -join ""
  $lines = Get-Content (Join-Path $DeployDir ".env.example")
  $lines = $lines -replace "JOBSCRAPE_CONFIG_TOKEN=.*", "JOBSCRAPE_CONFIG_TOKEN=$token"
  $lines = $lines -replace "JOBSCRAPE_CONFIG_PORT=.*", "JOBSCRAPE_CONFIG_PORT=$Port"
  $lines = $lines -replace "JOBSCRAPE_RUN_AT=.*", "JOBSCRAPE_RUN_AT=$RunAt"
  $lines | Set-Content $envFile -Encoding ASCII
  Write-Ok "wrote deploy/.env with a fresh API token"
}

# ---------------------------------------------------------------------------
Write-Step "5/7 config seed"
# ---------------------------------------------------------------------------
$baseConfig = Join-Path $JobscrapeDir "configs\base.json"
if (Test-Path $baseConfig) {
  Write-Ok "configs/base.json already exists - keeping it (edit keywords at the status page later)"
} else {
  Copy-Item (Join-Path $JobscrapeDir "configs\base.example.json") $baseConfig
  Write-Ok "seeded configs/base.json from the example (edit tracks/keywords at the status page later)"
}

# ---------------------------------------------------------------------------
Write-Step "6/7 colibri engine (optional)"
# ---------------------------------------------------------------------------
$wantColibri = $false
if ($WithColibri) { $wantColibri = $true }
else {
  Write-Host "    colibri is the high-quality ranker: ~400 GB of model weights on"
  Write-Host "    disk and 16 GB+ RAM. Without it, ranking uses the gemma model"
  Write-Host "    (already installed above) - a bit weaker, much lighter."
  $answer = Read-Host "    Install colibri too? [y/N]"
  if ($answer -match "^[Yy]") { $wantColibri = $true }
}
if ($wantColibri) {
  & (Join-Path $EngineDir "install-colibri.ps1") -KitRoot $KitRoot
  Set-ConfigColibriEnabled -KitRoot $KitRoot -Value $true
} else {
  Write-Ok "skipping colibri - ranking will use gemma"
  Set-ConfigColibriEnabled -KitRoot $KitRoot -Value $false
}

# ---------------------------------------------------------------------------
Write-Step "7/7 starting the stack"
# ---------------------------------------------------------------------------
Push-Location $DeployDir
try {
  docker compose up -d --build
  if ($LASTEXITCODE -ne 0) { throw "docker compose up failed" }
  Write-Ok "stack is up (scraper scheduler + config API + status page)"
} finally { Pop-Location }

if (-not $SkipProbe) {
  Write-Host "    Running a small dry-run probe (fetches job boards, ranks 3 postings"
  Write-Host "    with your real engine; writes nothing). Can take a few minutes."
  Push-Location $DeployDir
  try {
    docker compose run --rm scraper node scrape.mjs --once --dry-run --limit 3
    if ($LASTEXITCODE -eq 0) { Write-Ok "probe run finished cleanly" }
    else { Write-Warn2 "probe exited nonzero - check deploy/logs/ and the status page" }
  } finally { Pop-Location }
}

Write-Host ""
Write-Host "jobscrape is installed." -ForegroundColor Green
Write-Host "  digests:     $(Join-Path $DeployDir 'digests')\digest\<date>.md"
Write-Host "  status page: http://127.0.0.1:$Port/?token=<your token from deploy\.env>"
Write-Host "  schedule:    daily at $RunAt (container restarts keep it alive)"
Write-Host "  logs:        $(Join-Path $DeployDir 'logs')"
if (-not $wantColibri) {
  Write-Host ""
  Write-Host "  colibri was not installed. To add it later, re-run:"
  Write-Host "    powershell -NoProfile -ExecutionPolicy Bypass -File setup.ps1 -WithColibri"
}
