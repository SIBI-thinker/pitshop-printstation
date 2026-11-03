# Run this file once as Administrator after installing Node.js, SumatraPDF and (optionally) Microsoft Office.
# It installs dependencies, points phones' internet checks at this laptop so the print page opens
# by itself after scanning the Wi-Fi QR code, adds the Windows startup task, and starts the station.

$ProjectPath = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectPath

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error "Node.js is not installed or is not on PATH."
    exit 1
}
if (-not (Test-Path '.env')) { Copy-Item '.env.example' '.env' }

npm install
node scripts/captive-hosts.js
node scripts/install.js
& "$PSScriptRoot\start-kiosk.bat"
