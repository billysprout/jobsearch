# register-config-server.ps1 -- register config-server.mjs as a Windows
# Scheduled Task that starts at logon (it must be up whenever the agent
# might need to configure jobscrape -- unlike colibri, nobody starts it by
# hand). Run once as admin, same as register-task.ps1.
#
# The task action reads JOBSCRAPE_CONFIG_TOKEN / JOBSCRAPE_CONFIG_PORT from
# the repo-root .env and bakes them into the command line. The token grants
# config-write access to jobscrape -- plaintext in the task XML is the same
# exposure class as .env itself (both local-admin-readable). If that ever
# stops being acceptable, swap the cmd wrapper for a script that reads .env
# at start time.

$ErrorActionPreference = "Stop"

$TaskName = "OpenClaw-JobScrapeConfigServer"
$NodePath = (Get-Command node -ErrorAction Stop).Source
$ScriptDir = $PSScriptRoot
$LogFile = Join-Path $ScriptDir "logs\config-server.log"
$EnvFile = Join-Path (Split-Path $ScriptDir -Parent) ".env"

if (-not (Test-Path $EnvFile)) {
    throw "repo-root .env not found at $EnvFile -- generate it first (bash setup.sh env)"
}

function Get-DotEnvValue([string]$Key) {
    $line = Select-String -Path $EnvFile -Pattern ("^" + $Key + "=(.*)$") | Select-Object -First 1
    if (-not $line) { throw "$Key not found in $EnvFile" }
    return $line.Matches[0].Groups[1].Value.Trim()
}

$Token = Get-DotEnvValue "JOBSCRAPE_CONFIG_TOKEN"
$Port = Get-DotEnvValue "JOBSCRAPE_CONFIG_PORT"

if (-not (Test-Path (Join-Path $ScriptDir "logs"))) {
    New-Item -ItemType Directory -Path (Join-Path $ScriptDir "logs") -Force | Out-Null
}

# cmd wrapper because New-ScheduledTaskAction cannot set environment variables.
# >> redirect (not >) so restarts append instead of truncating the log.
$Inner = "set JOBSCRAPE_CONFIG_TOKEN=$Token&& set JOBSCRAPE_CONFIG_PORT=$Port&& `"$NodePath`" config-server.mjs >> `"$LogFile`" 2>&1"
$Action = New-ScheduledTaskAction -Execute "$env:ComSpec" -Argument "/c $Inner" -WorkingDirectory $ScriptDir
$Trigger = New-ScheduledTaskTrigger -AtLogOn
# Unlimited execution time (this is a service, not a batch job), don't stop on
# idle, and never run two instances (logon triggers fire per logon session).
$Settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopOnIdleEnd `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "Removing existing task '$TaskName'..." -ForegroundColor Yellow
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings `
    -Description "jobscrape config/status service (host-side, token-gated :$Port)" | Out-Null

Write-Host ""
Write-Host "Scheduled task '$TaskName' registered." -ForegroundColor Green
Write-Host "  Trigger:  At log on"
Write-Host "  Command:  node config-server.mjs  (working dir: $ScriptDir)"
Write-Host "  Port:     $Port (token-gated; GET /health open)"
Write-Host "  Logs:     $LogFile"
Write-Host ""
Write-Host "To start now:       schtasks /Run /TN '$TaskName'" -ForegroundColor Cyan
Write-Host "To stop:            schtasks /End /TN '$TaskName'" -ForegroundColor Cyan
Write-Host "To remove:          Unregister-ScheduledTask -TaskName '$TaskName'" -ForegroundColor Cyan
