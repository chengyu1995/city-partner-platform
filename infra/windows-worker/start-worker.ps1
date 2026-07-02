$ErrorActionPreference = "Stop"

$WorkerDir = $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($WorkerDir)) {
    $WorkerDir = Split-Path -Parent $MyInvocation.MyCommand.Path
}
$WorkerFile = Join-Path $WorkerDir "local_worker.js"
$LogDir = Join-Path $WorkerDir "logs"
$StartupLog = Join-Path $LogDir "scheduled-worker.log"

New-Item -ItemType Directory -Path $LogDir -Force | Out-Null

$existing = Get-CimInstance Win32_Process |
    Where-Object {
        $_.Name -eq "node.exe" -and
        $_.CommandLine -like "*local_worker.js*"
    }

if ($existing) {
    Add-Content $StartupLog "$(Get-Date -Format s) Worker 已运行，跳过重复启动。"
    exit 0
}

if (-not (Test-Path $WorkerFile)) {
    Add-Content $StartupLog "$(Get-Date -Format s) 找不到 $WorkerFile"
    exit 1
}

Set-Location $WorkerDir

Add-Content $StartupLog "$(Get-Date -Format s) 正在启动 Worker。"

$NodeCommand = Get-Command node -ErrorAction Stop
& $NodeCommand.Source ".\local_worker.js" `
    *>> $StartupLog
