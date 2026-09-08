# register-engine-task.ps1 - registers JobScrape-EngineServe, a scheduled
# task that runs ensure-engines.ps1 at logon + daily 06:45 (15-minute
# execution limit - it starts servers and exits, it does not babysit them).
#
# ASCII-only (PowerShell 5.1 ANSI-codepage parsing).
param(
  [Parameter(Mandatory = $true)][string]$KitRoot,
  [string]$TaskName = "JobScrape-EngineServe"
)
$ErrorActionPreference = "Stop"

$ensure = Join-Path $KitRoot "engine\ensure-engines.ps1"
if (-not (Test-Path $ensure)) { throw "ensure script not found: $ensure" }

$action    = New-ScheduledTaskAction -Execute "powershell.exe" `
             -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$ensure`" -KitRoot `"$KitRoot`""
$trigger1  = New-ScheduledTaskTrigger -AtLogOn
$trigger2  = New-ScheduledTaskTrigger -Daily -At "06:45"
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive
$settings  = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 15) -StartWhenAvailable

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
  Set-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger1, $trigger2 -Principal $principal -Settings $settings | Out-Null
  Write-Host "    updated scheduled task $TaskName"
} else {
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger1, $trigger2 -Principal $principal -Settings $settings | Out-Null
  Write-Host "    registered scheduled task $TaskName"
}

# Test-run once now so the engines come up without waiting for a trigger.
Start-ScheduledTask -TaskName $TaskName
Write-Host "    test-fired $TaskName (check engine\engines.log)"
