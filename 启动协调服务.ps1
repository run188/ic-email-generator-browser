$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$server = Join-Path $root "coordinator\server.py"

try {
  $health = Invoke-RestMethod -Uri "http://127.0.0.1:8765/api/health" -TimeoutSec 2
  Write-Host "Coordinator is already running: $($health.activeCount)/$($health.maxConcurrency) active tasks"
  exit 0
} catch {
  # Continue and start the service.
}

$python = (Get-Command python -ErrorAction Stop).Source
Start-Process -FilePath $python -ArgumentList @($server) -WorkingDirectory $root -WindowStyle Hidden

for ($attempt = 0; $attempt -lt 20; $attempt++) {
  Start-Sleep -Milliseconds 250
  try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:8765/api/health" -TimeoutSec 2
    Write-Host "Coordinator started: http://127.0.0.1:8765"
    Write-Host "Maximum concurrency: $($health.maxConcurrency)"
    exit 0
  } catch {
    # Keep waiting for startup.
  }
}

throw "Coordinator failed to start. Verify that Python 3 is installed."
