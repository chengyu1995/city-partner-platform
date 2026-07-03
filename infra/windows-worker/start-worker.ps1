$ErrorActionPreference = "Stop"

chcp 65001 | Out-Null
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$WorkerDir = Split-Path -Parent $PSCommandPath
$WorkerFile = Join-Path $WorkerDir "local_worker.js"
$LogDir = Join-Path $WorkerDir "logs"
$StartupLog = Join-Path $LogDir "scheduled-worker.log"

New-Item -ItemType Directory -Path $LogDir -Force | Out-Null

if (-not (Test-Path $WorkerFile)) {
  Add-Content $StartupLog "$(Get-Date -Format s) 找不到 local_worker.js：$WorkerFile"
  throw "找不到 local_worker.js：$WorkerFile"
}

$existing = Get-CimInstance Win32_Process |
  Where-Object {
    $_.CommandLine -like "*local_worker.js*"
  }

if ($existing) {
  Add-Content $StartupLog "$(Get-Date -Format s) Worker 已在运行，跳过重复启动。"
  Write-Host "Worker 已在运行，跳过重复启动。"
  exit 0
}

$node = Get-Command node.exe -ErrorAction Stop | Select-Object -First 1

Add-Content $StartupLog ""
Add-Content $StartupLog "$(Get-Date -Format s) 正在后台启动 Worker"
Add-Content $StartupLog "$(Get-Date -Format s) WorkerDir=$WorkerDir"
Add-Content $StartupLog "$(Get-Date -Format s) WorkerFile=$WorkerFile"
Add-Content $StartupLog "$(Get-Date -Format s) Node=$($node.Source)"

$cmd = "cd /d `"$WorkerDir`" && `"$($node.Source)`" `"$WorkerFile`" >> `"$StartupLog`" 2>&1"

Start-Process -FilePath "cmd.exe" -ArgumentList "/c", $cmd -WorkingDirectory $WorkerDir -WindowStyle Hidden

Start-Sleep -Seconds 3

$running = Get-CimInstance Win32_Process |
  Where-Object {
    $_.CommandLine -like "*local_worker.js*"
  }

if (-not $running) {
  Add-Content $StartupLog "$(Get-Date -Format s) Worker 启动失败，未发现 local_worker.js 进程。"
  throw "Worker 启动失败，未发现 local_worker.js 进程。"
}

Write-Host "Worker 后台启动成功。"
Write-Host "日志文件：$StartupLog"
