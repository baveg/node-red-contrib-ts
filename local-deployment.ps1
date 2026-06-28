$ErrorActionPreference = "Stop"

$NodeRedDir = "$env:USERPROFILE\.node-red"
Write-Host ">> Using Node-RED directory: $NodeRedDir"

if (-not (Test-Path $NodeRedDir)) {
    New-Item -ItemType Directory -Force $NodeRedDir | Out-Null
}

Write-Host "[build] Building project..."
npm run build
if (-not $?) { exit 1 }

Write-Host "[pack] Creating package..."
npm pack
if (-not $?) { exit 1 }

$PackageFile = Get-ChildItem -Filter "node-red-contrib-ts-*.tgz" |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1 -ExpandProperty Name

if (-not $PackageFile) {
    Write-Host "[ERROR] No package file found"
    exit 1
}

Write-Host "[install] Installing $PackageFile to local Node-RED..."
npm install $PackageFile --prefix $NodeRedDir --save
if (-not $?) { exit 1 }

Write-Host "[clean] Cleaning up local package..."
Remove-Item -Force $PackageFile -ErrorAction SilentlyContinue

# Kill Node-RED if running
$Procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like "*node-red*" }

if ($Procs) {
    Write-Host "[stop] Stopping Node-RED..."
    $Procs | ForEach-Object {
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Seconds 2
}

# Start Node-RED
Write-Host "[start] Starting Node-RED..."
Start-Process -FilePath "cmd.exe" -ArgumentList "/c npx node-red" -WindowStyle Hidden

# Wait for Node-RED to start
for ($i = 1; $i -le 30; $i++) {
    try {
        Invoke-WebRequest -Uri "http://localhost:1880" -UseBasicParsing -TimeoutSec 1 -ErrorAction Stop | Out-Null
        Write-Host "[OK] Node-RED is running at http://localhost:1880"
        exit 0
    } catch {
        Start-Sleep -Seconds 1
    }
}

Write-Host "[WARN] Node-RED may not have started properly"
