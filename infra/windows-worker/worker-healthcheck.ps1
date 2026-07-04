param(
  [switch]$StopExistingWorker,
  [switch]$RecoverPreview
)

$ErrorActionPreference = "Stop"

chcp 65001 | Out-Null
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$WorkerDir = Split-Path -Parent $PSCommandPath
$ProjectDir = Resolve-Path (Join-Path $WorkerDir "..\..")
$RecoveryFile = Join-Path $WorkerDir "worker-recovery.js"
$LogDir = Join-Path $WorkerDir "logs"
$HealthLog = Join-Path $LogDir "worker-healthcheck.log"

New-Item -ItemType Directory -Path $LogDir -Force | Out-Null

if (-not (Test-Path $RecoveryFile)) {
  Add-Content $HealthLog "$(Get-Date -Format s) missing worker-recovery.js: $RecoveryFile"
  throw "missing worker-recovery.js: $RecoveryFile"
}

$node = Get-Command node.exe -ErrorAction Stop | Select-Object -First 1
$args = @($RecoveryFile, "preflight", $ProjectDir.Path)

if ($StopExistingWorker) {
  $args += "--include-worker"
}

Add-Content $HealthLog ""
Add-Content $HealthLog "$(Get-Date -Format s) worker healthcheck started"
Add-Content $HealthLog "$(Get-Date -Format s) ProjectDir=$($ProjectDir.Path)"

try {
  $preflight = & $node.Source @args 2>&1
  Add-Content $HealthLog $preflight
  Write-Host "Worker healthcheck completed."
} catch {
  Add-Content $HealthLog "$(Get-Date -Format s) worker healthcheck failed: $($_.Exception.Message)"
  throw
}

if ($RecoverPreview) {
  Add-Content $HealthLog "$(Get-Date -Format s) local preview recovery started"
  try {
    $preview = & $node.Source $RecoveryFile "recover-preview" $ProjectDir.Path 2>&1
    Add-Content $HealthLog $preview
    Write-Host "Local preview recovery completed."
  } catch {
    Add-Content $HealthLog "$(Get-Date -Format s) local preview recovery failed: $($_.Exception.Message)"
    throw
  }
}

Write-Host "Healthcheck log: $HealthLog"
