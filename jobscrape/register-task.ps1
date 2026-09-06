# register-task.ps1 — register jobscrape as a daily Windows Scheduled Task.
# Run once as operator to set up the daily 07:00 scrape.
# Requires admin elevation for schtasks.

$ErrorActionPreference = "Stop"

$TaskName = "OpenClaw-JobScrape"
$NodePath = (Get-Command node -ErrorAction Stop).Source
$ScriptPath = Join-Path $PSScriptRoot "scrape.mjs"
$LogDir = Join-Path $PSScriptRoot "logs"
$LogFile = Join-Path $LogDir "run-$(Get-Date -Format 'yyyy-MM-dd').log"

if (-not (Test-Path $LogDir)) {
    New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
}

# --limit 10: colibri scores one posting at a time and can take 1-10+ minutes
# each (see mcp-colibri's measured latency notes) — 40/day (the scrape.mjs
# default) would run for hours. 10 is a deliberate tradeoff, not a forgotten
# default; raise it if colibri throughput improves or --no-colibri is used.
$Action = New-ScheduledTaskAction -Execute $NodePath -Argument "`"$ScriptPath`" --once --limit 10" -WorkingDirectory $PSScriptRoot
$Trigger = New-ScheduledTaskTrigger -Daily -At "07:00"
# 6h matches the repo's other long-running-local-model budget (egress/squid.conf's
# client_lifetime). Was 3h; scrape.mjs now streams each ranked chunk to the
# digest as it completes (see its header comment) instead of writing once at
# the end, so a timeout this generous no longer means losing a whole run's
# worth of ranking if colibri is running slow (disk-tier offload, no GPU).
$Settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopOnIdleEnd -ExecutionTimeLimit ([TimeSpan]::FromHours(6))

# Remove existing task if it exists
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "Removing existing task '$TaskName'..." -ForegroundColor Yellow
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Description "Daily job scrape pipeline for OpenClaw sandbox" | Out-Null

Write-Host ""
Write-Host "Scheduled task '$TaskName' registered." -ForegroundColor Green
Write-Host "  Trigger:   Daily at 07:00 local time"
Write-Host "  Command:   $NodePath `"$ScriptPath`" --once --limit 10"
Write-Host "  Logs:      $LogDir/run-YYYY-MM-DD.log"
Write-Host ""
Write-Host "To run manually:  schtasks /Run /TN '$TaskName'" -ForegroundColor Cyan
Write-Host "To remove:       Unregister-ScheduledTask -TaskName '$TaskName'" -ForegroundColor Cyan
