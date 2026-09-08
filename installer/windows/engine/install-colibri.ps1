# install-colibri.ps1 - optional colibri engine + GLM-5.2 int4 weights.
#
# Downloads the latest colibri release from GitHub (prebuilt, no compiler
# needed) and the ~400 GB GLM-5.2 int4 weight set from Hugging Face, then
# registers a scheduled task that keeps both engines alive across reboots.
#
# ASCII-only (PowerShell 5.1 ANSI-codepage parsing). Idempotent: skips
# pieces already on disk; weight download resumes via huggingface_hub.
param(
  [Parameter(Mandatory = $true)][string]$KitRoot,
  [string]$RepoOwner = "JustVugg",
  [string]$RepoName  = "colibri",
  [string]$HfRepo    = "mastouri/GLM-5.2-colibri-int4-g64-with-int8-mtp",
  [double]$MinFreeDiskGB = 420,
  [double]$MinRamGB = 16
)
$ErrorActionPreference = "Stop"

$EngineDir  = Join-Path $KitRoot "engine"
$ColibriDir = Join-Path $EngineDir "colibri"
$ModelDir   = Join-Path $EngineDir "glm52"

function Write-Step($msg) { Write-Host ""; Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "    OK: $msg" -ForegroundColor Green }
function Write-Warn2($msg){ Write-Host "    !! $msg" -ForegroundColor Yellow }

# --- Prereq checks -----------------------------------------------------------
Write-Step "prerequisites"
$drive = (Get-Item $KitRoot).PSDrive
$freeGB = [math]::Round($drive.Free / 1GB)
Write-Host "    free disk on $($drive.Name): ($freeGB GB; need $MinFreeDiskGB GB)"
if ($freeGB -lt $MinFreeDiskGB) {
  Write-Warn2 "not enough disk for the weights - aborting colibri install (gemma-only ranking stays active)"
  exit 1
}
$totalRamGB = [math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB)
if ($totalRamGB -lt $MinRamGB) {
  Write-Warn2 "this machine has ${totalRamGB} GB RAM; colibri wants ${MinRamGB} GB+ (it will run, slowly)"
}
if (-not (Get-Command python -ErrorAction SilentlyContinue) -and -not (Get-Command py -ErrorAction SilentlyContinue)) {
  Write-Host "    python not found - installing (winget)..."
  winget install --id Python.Python.3.12 -e --accept-source-agreements --accept-package-agreements
  $env:Path += ";$env:LOCALAPPDATA\Programs\Python\Python312;$(Join-Path $env:LOCALAPPDATA 'Programs\Python\Python312\Scripts')"
}
Write-Ok "prerequisites satisfied"

# --- colibri release ----------------------------------------------------------
Write-Step "colibri engine (GitHub release)"
$marker = Join-Path $ColibriDir ".installed"
if (Test-Path $marker) {
  Write-Ok "already installed at $ColibriDir"
} else {
  Write-Host "    resolving latest release..."
  $rel = Invoke-RestMethod "https://api.github.com/repos/$RepoOwner/$RepoName/releases/latest"
  $asset = $rel.assets | Where-Object { $_.name -match "windows.*x86_64.*\.zip$" } | Select-Object -First 1
  if (-not $asset) { throw "no windows x86_64 zip asset in latest release of $RepoOwner/$RepoName" }
  $zip = Join-Path $env:TEMP $asset.name
  Write-Host "    downloading $($asset.name) ..."
  Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zip
  New-Item -ItemType Directory -Force -Path $ColibriDir | Out-Null
  Expand-Archive -Path $zip -DestinationPath $ColibriDir -Force
  Remove-Item $zip
  Set-Content $marker "release $($rel.tag_name)" -Encoding ASCII
  Write-Ok "colibri $($rel.tag_name) extracted to $ColibriDir"
}

# --- weights ------------------------------------------------------------------
Write-Step "GLM-5.2 int4 weights from Hugging Face (~400 GB)"
$weightsMarker = Join-Path $ModelDir ".complete"
if (Test-Path $weightsMarker) {
  Write-Ok "weights already present at $ModelDir"
} else {
  Write-Host "    installing huggingface download tooling..."
  python -m pip install -U "huggingface_hub[cli]" 2>$null
  if ($LASTEXITCODE -ne 0) { py -3 -m pip install -U "huggingface_hub[cli]" }
  New-Item -ItemType Directory -Force -Path $ModelDir | Out-Null
  Write-Host "    downloading $HfRepo - this is the long step (resumes if interrupted)..."
  $hf = Join-Path $env:LOCALAPPDATA "Programs\Python\Python312\Scripts\huggingface-cli.exe"
  if (-not (Test-Path $hf)) { $hf = "huggingface-cli" }
  & $hf download $HfRepo --local-dir $ModelDir
  if ($LASTEXITCODE -ne 0) { throw "weight download failed - re-run setup to resume" }
  Set-Content $weightsMarker "done" -Encoding ASCII
  Write-Ok "weights downloaded to $ModelDir"
}

# --- keep-alive task ----------------------------------------------------------
Write-Step "registering the engine keep-alive scheduled task"
& (Join-Path $PSScriptRoot "register-engine-task.ps1") -KitRoot $KitRoot
Write-Host ""
Write-Host "colibri installed. The scraper picks it up on the next run (or the" -ForegroundColor Green
Write-Host "status page's next config save)." -ForegroundColor Green
