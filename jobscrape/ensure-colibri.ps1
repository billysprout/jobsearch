# ensure-colibri.ps1 - start colibri serve (and Ollama) if not already up.
# Payload for the OpenClaw-EngineServe scheduled task (see
# register-colibri-server.ps1). Idempotent: each check hits the health
# endpoint first and only starts what is actually down, so re-runs are
# no-ops while the engines are healthy.
#
# Why: the 2026-09-07 audit found colibri serve down all afternoon (RAM
# guard refusal + no supervisor) and Ollama down, so the gemma fallback was
# dead on arrival. Nothing else starts these before the 07:00 scrape.

$ErrorActionPreference = "SilentlyContinue"

function Test-Url($url) {
    try {
        $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 3
        return ($r.StatusCode -eq 200)
    } catch { return $false }
}

# --- colibri serve (OpenAI-compatible engine API on :8000) ---
if (-not (Test-Url "http://127.0.0.1:8000/health")) {
    $env:COLI_MODEL = "C:\c\glm52"
    Start-Process -FilePath "C:\Program Files\Python314\python.exe" `
        -ArgumentList "C:\c\colibri\c\coli", "serve", "--host", "127.0.0.1", "--port", "8000", "--model-id", "glm-5.2-colibri" `
        -WorkingDirectory "C:\c\colibri\c" -WindowStyle Hidden
    Write-Host "colibri serve was down - starting on :8000"
} else {
    Write-Host "colibri serve already up on :8000"
}

# --- Ollama (gemma fallback engine on :11434) ---
if (-not (Test-Url "http://127.0.0.1:11434/v1/models")) {
    Start-Process -FilePath "C:\Users\billy\AppData\Local\Programs\Ollama\ollama.exe" `
        -ArgumentList "serve" -WindowStyle Hidden
    Write-Host "ollama was down - starting on :11434"
} else {
    Write-Host "ollama already up on :11434"
}
