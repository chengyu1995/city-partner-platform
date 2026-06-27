param(
  [string]$WorkerDir = "C:\city-partner-worker",
  [string]$TaskName = "CityPartnerCodexWorker",
  [int]$MaxFetchFailed = 5,
  [switch]$Apply
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$Mode = if ($Apply) { "APPLY" } else { "DRY-RUN" }
$ProcessCheckAvailable = $true

function Write-WatchdogLog {
  param([string]$Message)
  Write-Host "[$Mode] $Message"
}

function Test-WorkerProcess {
  try {
    $script:ProcessCheckAvailable = $true
    $processes = Get-CimInstance Win32_Process -ErrorAction Stop |
      Where-Object {
        $_.Name -eq "node.exe" -and
        $_.CommandLine -like "*local_worker.js*"
      }

    return @($processes)
  } catch {
    $script:ProcessCheckAvailable = $false
    Write-WatchdogLog "WARNING: unable to inspect node.exe command lines: $($_.Exception.Message)"
    return @()
  }
}

function Get-WorkerTask {
  param([string]$Name)

  try {
    return Get-ScheduledTask -TaskName $Name -ErrorAction Stop
  } catch {
    return $null
  }
}

function Get-RecentFetchFailedCount {
  param([string]$LogPath)

  if (-not (Test-Path -LiteralPath $LogPath -PathType Leaf)) {
    return [pscustomobject]@{
      Exists = $false
      Count = 0
      TailCount = 0
    }
  }

  $tail = @(Get-Content -LiteralPath $LogPath -Tail 100 -ErrorAction Stop)
  $count = 0

  for ($i = $tail.Count - 1; $i -ge 0; $i--) {
    $line = [string]$tail[$i]
    if ($line -match "(?i)fetch failed") {
      $count++
      continue
    }

    if ($line.Trim().Length -eq 0) {
      continue
    }

    break
  }

  return [pscustomobject]@{
    Exists = $true
    Count = $count
    TailCount = $tail.Count
  }
}

function Start-WorkerScheduledTask {
  param(
    [string]$Name,
    [bool]$CanApply
  )

  if (-not $CanApply) {
    Write-WatchdogLog "Would start scheduled task: $Name"
    return
  }

  Write-WatchdogLog "Starting scheduled task: $Name"
  Start-ScheduledTask -TaskName $Name
}

Write-WatchdogLog "Mode: $Mode"
Write-WatchdogLog "WorkerDir: $WorkerDir"
Write-WatchdogLog "TaskName: $TaskName"
Write-WatchdogLog "MaxFetchFailed: $MaxFetchFailed"
if (-not $Apply) {
  Write-WatchdogLog "Dry-run is the default. No scheduled task, node process, file, or env file will be modified."
}

$workerFile = Join-Path $WorkerDir "local_worker.js"
$envFile = Join-Path $WorkerDir ".env"
$logFile = Join-Path (Join-Path $WorkerDir "logs") "scheduled-worker.log"

$workerDirExists = Test-Path -LiteralPath $WorkerDir -PathType Container
$workerFileExists = Test-Path -LiteralPath $workerFile -PathType Leaf
$envFileExists = Test-Path -LiteralPath $envFile -PathType Leaf

Write-WatchdogLog "WorkerDir exists: $workerDirExists"
Write-WatchdogLog "local_worker.js exists: $workerFileExists"
Write-WatchdogLog ".env exists: $envFileExists"

$task = Get-WorkerTask -Name $TaskName
$taskExists = $null -ne $task
$taskState = if ($taskExists) { [string]$task.State } else { "Missing" }
Write-WatchdogLog "Scheduled task exists: $taskExists"
Write-WatchdogLog "Scheduled task state: $taskState"

$workerProcesses = @(Test-WorkerProcess)
$workerRunning = $workerProcesses.Count -gt 0
Write-WatchdogLog "local_worker.js process check available: $ProcessCheckAvailable"
Write-WatchdogLog "local_worker.js process exists: $workerRunning"
if ($workerRunning) {
  $processIds = ($workerProcesses | ForEach-Object { $_.ProcessId }) -join ", "
  Write-WatchdogLog "local_worker.js process ids: $processIds"
}

$fetchFailed = Get-RecentFetchFailedCount -LogPath $logFile
Write-WatchdogLog "scheduled-worker.log exists: $($fetchFailed.Exists)"
if ($fetchFailed.Exists) {
  Write-WatchdogLog "Checked scheduled-worker.log recent lines: $($fetchFailed.TailCount)"
  Write-WatchdogLog "Trailing fetch failed count: $($fetchFailed.Count)"
  if ($fetchFailed.Count -ge $MaxFetchFailed) {
    Write-WatchdogLog "WARNING: trailing fetch failed count is at or above threshold."
  }
}

$needsStart = $false
if (-not $taskExists) {
  Write-WatchdogLog "Scheduled task is missing; cannot recover until it is registered."
  $needsStart = $true
} elseif ($taskState -ne "Running") {
  Write-WatchdogLog "Scheduled task is not Running."
  $needsStart = $true
}

if (-not $workerRunning) {
  Write-WatchdogLog "Worker process is not running."
  $needsStart = $true
}

if (-not $workerDirExists -or -not $workerFileExists) {
  Write-WatchdogLog "Required worker files are missing; scheduled task start may fail."
}

if (-not $needsStart -and $workerRunning) {
  Write-WatchdogLog "WORKER_WATCHDOG_HEALTHY"
  exit 0
}

if (-not $Apply) {
  if ($taskExists) {
    Start-WorkerScheduledTask -Name $TaskName -CanApply:$false
  } else {
    Write-WatchdogLog "Would start scheduled task, but the scheduled task is missing: $TaskName"
  }
  Write-WatchdogLog "Dry-run complete. Pass -Apply to start the scheduled task."
  exit 0
}

if (-not $taskExists) {
  Write-WatchdogLog "WORKER_WATCHDOG_FAILED"
  exit 1
}

try {
  Start-WorkerScheduledTask -Name $TaskName -CanApply:$true
  Start-Sleep -Seconds 5

  $workerProcessesAfterStart = @(Test-WorkerProcess)
  if (-not $ProcessCheckAvailable) {
    Write-WatchdogLog "local_worker.js process check is unavailable after recovery."
    Write-WatchdogLog "WORKER_WATCHDOG_FAILED"
    exit 1
  } elseif ($workerProcessesAfterStart.Count -gt 0) {
    Write-WatchdogLog "local_worker.js process exists after recovery: True"
    Write-WatchdogLog "WORKER_WATCHDOG_RECOVERED"
    exit 0
  }

  Write-WatchdogLog "local_worker.js process exists after recovery: False"
  Write-WatchdogLog "WORKER_WATCHDOG_FAILED"
  exit 1
} catch {
  Write-WatchdogLog "Recovery failed: $($_.Exception.Message)"
  Write-WatchdogLog "WORKER_WATCHDOG_FAILED"
  exit 1
}
