# build-kit.ps1 - assembles jobscrape-kit.zip from an ALLOWLIST.
#
# This machine carries personal state (real .env tokens, scrape history,
# resume, job-application PDFs, handoff notes). The zip must contain ONLY
# the entries below; the final assert re-checks the staging tree for the
# forbidden patterns so a typo in the allowlist fails the build instead of
# leaking.
#
# ASCII-only (PowerShell 5.1 ANSI-codepage parsing).
#
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File installer\build-kit.ps1
param(
  [string]$OutDir = ""
)
$ErrorActionPreference = "Stop"
# Cross-platform (CI builds the kit on macOS runners too): Windows PowerShell
# 5.1 defines none of the $Is* variables, only pwsh Core does.
$IsWin = ($PSVersionTable.PSVersion.Major -le 5) -or $IsWindows
if (-not $OutDir) { $OutDir = Join-Path $PSScriptRoot "dist" }
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$Stamp = Get-Date -Format "yyyy-MM-dd"
# $env:TEMP is Windows-only; macOS sets TMPDIR (trailing slash is fine for Join-Path).
$TempRoot = $env:TEMP; if (-not $TempRoot) { $TempRoot = $env:TMPDIR }; if (-not $TempRoot) { $TempRoot = "/tmp" }
$Stage = Join-Path $TempRoot "jobscrape-kit-stage"
$Zip = Join-Path $OutDir "jobscrape-kit-$Stamp.zip"

# --- the allowlist: repo-relative source -> kit-relative destination --------
$entries = @(
  # kit entry points + docs + engine scripts
  @{ src = "installer\README.md";                     dst = "README.md" },
  @{ src = "installer\windows\setup.ps1";             dst = "setup.ps1" },
  @{ src = "installer\unix\setup.sh";                 dst = "setup.sh" },
  @{ src = "installer\windows\engine\install-colibri.ps1";      dst = "engine\install-colibri.ps1" },
  @{ src = "installer\windows\engine\ensure-engines.ps1";       dst = "engine\ensure-engines.ps1" },
  @{ src = "installer\windows\engine\register-engine-task.ps1"; dst = "engine\register-engine-task.ps1" },
  @{ src = "installer\unix\engine\install-colibri.sh";          dst = "engine\install-colibri.sh" },
  @{ src = "installer\unix\engine\ensure-engines.sh";           dst = "engine\ensure-engines.sh" },
  @{ src = "installer\unix\engine\register-engine-units.sh";    dst = "engine\register-engine-units.sh" },
  # the standalone stack
  @{ src = "deploy\docker-compose.yml";               dst = "deploy\docker-compose.yml" },
  @{ src = "deploy\.env.example";                     dst = "deploy\.env.example" },
  # jobscrape source (whole pipeline; personal/runtime state stays out via
  # the per-file list + the assert below)
  @{ src = "jobscrape\package.json";                  dst = "jobscrape\package.json" },
  @{ src = "jobscrape\Dockerfile";                    dst = "jobscrape\Dockerfile" },
  @{ src = "jobscrape\Dockerfile.scraper";            dst = "jobscrape\Dockerfile.scraper" },
  @{ src = "jobscrape\.dockerignore";                 dst = "jobscrape\.dockerignore" },
  @{ src = "jobscrape\configs\base.example.json";     dst = "jobscrape\configs\base.example.json" },
  @{ src = "jobscrape\configs\friend.json";           dst = "jobscrape\configs\friend.json" },
  @{ src = "jobscrape\configs\dev.json";              dst = "jobscrape\configs\dev.json" },
  @{ src = "jobscrape\pipeline";                      dst = "jobscrape\pipeline" },
  @{ src = "jobscrape\filters";                       dst = "jobscrape\filters" },
  @{ src = "jobscrape\scorers";                       dst = "jobscrape\scorers" }
)
# top-level jobscrape *.mjs modules - everything except digest-notify.mjs
# (gateway-container-only, billy's Telegram default baked in) and
# render-resume.mjs ONLY IF it later gains personal defaults (it ships today).
Get-ChildItem (Join-Path $RepoRoot "jobscrape") -Filter "*.mjs" -File | ForEach-Object {
  if ($_.Name -ne "digest-notify.mjs") {
    $entries += @{ src = "jobscrape\$($_.Name)"; dst = "jobscrape\$($_.Name)" }
  }
}

# --- stage -------------------------------------------------------------------
if (Test-Path $Stage) { Remove-Item $Stage -Recurse -Force }
New-Item -ItemType Directory -Force -Path $Stage | Out-Null
foreach ($e in $entries) {
  $src = Join-Path $RepoRoot $e.src
  $dst = Join-Path $Stage $e.dst
  if (-not (Test-Path $src)) { throw "allowlist entry missing on disk: $($e.src)" }
  New-Item -ItemType Directory -Force -Path (Split-Path $dst) | Out-Null
  if (Test-Path $src -PathType Container) {
    Copy-Item $src $dst -Recurse -Force
  } else {
    Copy-Item $src $dst -Force
  }
}

# keep unix scripts executable through the zip (Info-ZIP external attr on
# Windows; real +x on unix staging so the archiver records the exec bit)
if ($IsWin) {
  Get-ChildItem $Stage -Recurse -Filter "*.sh" | ForEach-Object { $_.IsReadOnly = $false }
} else {
  Get-ChildItem $Stage -Recurse -Filter "*.sh" | ForEach-Object { chmod +x $_.FullName }
}

# --- the assert: none of these may exist anywhere in the staging tree --------
$forbidden = @(".env$", "base\.json$", "production\.json$", "^state$", "^logs$",
               "^staging$", "\.pdf$", "^HANDOFF-", "profile\.md$", "resume\.md$",
               "digest-notify", "audit\.jsonl", "^\.backups$", "err\.log$")
$hits = Get-ChildItem $Stage -Recurse -Force | Where-Object {
  $n = $_.Name
  ($forbidden | Where-Object { $n -match $_ }).Count -gt 0
}
if ($hits) {
  $hits | ForEach-Object { Write-Host "FORBIDDEN IN KIT: $($_.FullName)" -ForegroundColor Red }
  throw "allowlist leak - see the FORBIDDEN lines above; fix the allowlist, not the assert"
}

# version stamp: kit README footer
$sha = git -C $RepoRoot rev-parse --short HEAD
Add-Content (Join-Path $Stage "README.md") "`n---`n`nBuilt from openclaw-sandbox@$sha on $Stamp."

# --- zip ----------------------------------------------------------------------
# bsdtar/zip, not Compress-Archive: the latter writes backslash path
# separators, which unix `unzip` extracts as literal backslash filenames (kit
# arrives broken for macOS/Linux friends). All writers here emit forward-slash
# entries; -a picks zip from the extension.
#
# Top-level entries are named explicitly, never `.`: bsdtar's `.` operand
# writes entries prefixed with `./`, and Windows Explorer's zip view silently
# renders such archives as an EMPTY folder (valid archive, `tar -x` works,
# Explorer sees 0 items - confirmed 2026-09-09 via Shell COM). Naming the
# entries stores them unprefixed, which every consumer accepts.
$topLevel = @(Get-ChildItem -Force $Stage | ForEach-Object { $_.Name })
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
if (Test-Path $Zip) { Remove-Item $Zip -Force }
if ($IsWin) {
  # Full path on purpose: bare `tar` resolves to git-bash's GNU tar in some
  # environments, which reads C:\... as a remote host and fails.
  & (Join-Path $env:SystemRoot "System32\tar.exe") -a -c -f $Zip -C $Stage @topLevel
  if ($LASTEXITCODE -ne 0) { throw "tar failed with exit code $LASTEXITCODE" }
} elseif ($IsMacOS) {
  # /usr/bin/tar on macOS IS bsdtar - writes zip via -a.
  & /usr/bin/tar -a -c -f $Zip -C $Stage @topLevel
  if ($LASTEXITCODE -ne 0) { throw "tar failed with exit code $LASTEXITCODE" }
} else {
  # GNU tar cannot write zip at all - Info-ZIP can. Naming the directories
  # (not `.`) keeps entries unprefixed; dotfiles inside named dirs ship.
  Push-Location $Stage
  try {
    zip -q -r $Zip @topLevel
    if ($LASTEXITCODE -ne 0) { throw "zip failed with exit code $LASTEXITCODE" }
  } finally { Pop-Location }
}
if (-not (Test-Path $Zip)) { throw "zip was not written: $Zip" }
Remove-Item $Stage -Recurse -Force

Write-Host ""
Write-Host "kit built: $Zip" -ForegroundColor Green
Write-Host "contents: git@$sha, stamped $Stamp"
