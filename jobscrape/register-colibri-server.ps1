# register-colibri-server.ps1 - register the engine keepalive scheduled task.
# Run once as admin (schtasks needs elevation). Complements register-task.ps1
# (the scrape): colibri serve and Ollama are supervised by nothing else, and
# the 2026-09-07 audit found colibri serve down all afternoon plus Ollama
# down (gemma fallback dead on arrival).
#
# The task runs ensure-colibri.ps1 at logon and daily at 06:45 - 15 minutes
# before the 07:00 scrape. It health-checks first and only starts what is
# down, so it never touches healthy engines and never double-starts.

$ErrorActionPreference = "Stop"

$TaskName = "OpenClaw-EngineServe"
$EnsureScript = Join-Path $PSScriptRoot "ensure-colibri.ps1"

$Action = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$EnsureScript`"" `
    -WorkingDirectory $PSScriptRoot
# 06:45 gives colibri's model load a 15-minute head start on the 07:00 run.
$Triggers = @(
    New-ScheduledTaskTrigger -Daily -At "06:45"
    New-ScheduledTaskTrigger -AtLogOn
)
$Settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopOnIdleEnd `
    -ExecutionTimeLimit ([TimeSpan]::FromMinutes(15)) -MultipleInstances IgnoreNew

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "Removing existing task '$TaskName'..." -ForegroundColor Yellow
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Triggers -Settings $Settings `
    -Description "Ensure colibri serve (:8000) and Ollama (:11434) are up for the 07:00 jobscrape" | Out-Null

Write-Host ""
Write-Host "Scheduled task '$TaskName' registered." -ForegroundColor Green
Write-Host "  Triggers: daily 06:45 + at logon"
Write-Host "  Payload:  $EnsureScript"
Write-Host ""
Write-Host "Test now:   schtasks /Run /TN '$TaskName'" -ForegroundColor Cyan
Write-Host "To remove:  Unregister-ScheduledTask -TaskName '$TaskName'" -ForegroundColor Cyan
