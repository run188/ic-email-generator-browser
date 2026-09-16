$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$pidFile = Join-Path $root "coordinator\coordinator.pid"

if (-not (Test-Path -LiteralPath $pidFile)) {
  Write-Host "Coordinator is not running"
  exit 0
}

$processId = [int](Get-Content -LiteralPath $pidFile -Raw -Encoding ASCII)
$process = Get-Process -Id $processId -ErrorAction SilentlyContinue
if ($null -ne $process) {
  Stop-Process -Id $processId
  [void]$process.WaitForExit(5000)
}

Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
Write-Host "Coordinator stopped"
