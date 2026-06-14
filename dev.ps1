<#
  Runs all ShopSim dev components together:
    - mirofish_worker (FastAPI backend) in its own window
    - shopy-tester  (Shopify app)  in THIS window, interactive

  Usage:
    .\dev.ps1          # backend in MOCK mode (default — no MiroFish needed)
    .\dev.ps1 -Real    # backend runs the real mirofish CLI

  If PowerShell blocks the script, run:
    powershell -ExecutionPolicy Bypass -File .\dev.ps1
#>
param([switch]$Real)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$worker = Join-Path $root "mirofish_worker"
$app = Join-Path $root "shopy-tester"
$py = Join-Path $worker ".venv\Scripts\python.exe"

if (-not (Test-Path $py)) {
  Write-Host "Worker venv not found. Set it up once:" -ForegroundColor Yellow
  Write-Host "  cd mirofish_worker"
  Write-Host "  python -m venv .venv"
  Write-Host "  .\.venv\Scripts\python.exe -m pip install -r requirements.txt"
  exit 1
}

$mock = if ($Real) { "0" } else { "1" }

Write-Host "Starting backend (MIROFISH_MOCK=$mock) in a new window..." -ForegroundColor Cyan
$cmd = "`$env:MIROFISH_MOCK='$mock'; & '$py' app.py"
Start-Process powershell -WorkingDirectory $worker -ArgumentList "-NoExit", "-Command", $cmd | Out-Null

Start-Sleep -Seconds 2

Write-Host "Starting Shopify app (shopify app dev) here. Press Ctrl+C to stop it." -ForegroundColor Cyan
Write-Host "(The backend keeps running in its own window — close that window when done.)" -ForegroundColor DarkGray
Set-Location $app
shopify app dev
