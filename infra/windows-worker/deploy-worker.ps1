param(
  [string]$SourceDir = $PSScriptRoot,
  [string]$TargetDir = "C:\city-partner-worker",
  [string]$BackupRoot = "C:\city-partner-worker-backups",
  [string]$TaskName = "CityPartnerCodexWorker",
  [switch]$Apply,
  [switch]$SkipRestart
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$Mode = if ($Apply) { "APPLY" } else { "DRY-RUN" }
$RequiredSourceFiles = @(
  "local_worker.js",
  "start-worker.ps1",
  "package.json",
  "git-safety.js",
  "verify-worker.ps1"
)
$BackupFileNames = @(
  "local_worker.js",
  "start-worker.ps1",
  "package.json",
  "package-lock.json",
  "git-safety.js",
  "verify-worker.ps1",
  "README.md"
)

function Write-DeployLog {
  param([string]$Message)
  Write-Host "[$Mode] $Message"
}

function ConvertTo-SafeLogLine {
  param([string]$Line)

  $safe = $Line
  $safe = $safe -replace "(?i)(token|secret|password|private[_ -]?key)(\s*[:=]\s*)\S+", '$1$2[REDACTED]'
  $safe = $safe -replace "(?i)(bearer\s+)[A-Za-z0-9._~+/-]+", '$1[REDACTED]'
  $safe = $safe -replace "-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----", "[REDACTED_PRIVATE_KEY]"
  return $safe
}

function Write-SafeCommandOutput {
  param([string[]]$Lines)

  foreach ($line in $Lines) {
    Write-DeployLog (ConvertTo-SafeLogLine -Line $line)
  }
}

function Resolve-ExistingDirectory {
  param(
    [string]$Path,
    [string]$Label
  )

  if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
    throw "$Label does not exist: $Path"
  }

  return (Resolve-Path -LiteralPath $Path).Path
}

function Test-IsUnderPath {
  param(
    [string]$ChildPath,
    [string]$ParentPath
  )

  $fullChild = [System.IO.Path]::GetFullPath($ChildPath).TrimEnd('\')
  $fullParent = [System.IO.Path]::GetFullPath($ParentPath).TrimEnd('\')
  return $fullChild.Equals($fullParent, [System.StringComparison]::OrdinalIgnoreCase) -or
    $fullChild.StartsWith("$fullParent\", [System.StringComparison]::OrdinalIgnoreCase)
}

function Get-RelativePath {
  param(
    [string]$BasePath,
    [string]$FullPath
  )

  $baseUri = [System.Uri](([System.IO.Path]::GetFullPath($BasePath).TrimEnd('\') + "\"))
  $fullUri = [System.Uri]([System.IO.Path]::GetFullPath($FullPath))
  return [System.Uri]::UnescapeDataString($baseUri.MakeRelativeUri($fullUri).ToString()).Replace("/", "\")
}

function Join-WorkerEnvPath {
  param([string]$WorkerDir)

  $fullDir = [System.IO.Path]::GetFullPath($WorkerDir).TrimEnd('\')
  $parentDir = Split-Path -Parent $fullDir
  $leafName = Split-Path -Leaf $fullDir
  return Join-Path $parentDir "$leafName.env"
}

function Assert-SafeDeploymentPaths {
  param(
    [string]$ResolvedSourceDir,
    [string]$ResolvedTargetDir,
    [string]$ResolvedBackupRoot
  )

  $scriptDir = [System.IO.Path]::GetFullPath($PSScriptRoot)
  if (-not (Test-IsUnderPath -ChildPath $ResolvedSourceDir -ParentPath $scriptDir)) {
    throw "SourceDir must be the script directory or a child path of it: $ResolvedSourceDir"
  }

  $allowedTarget = [System.IO.Path]::GetFullPath("C:\city-partner-worker")
  $allowedBackup = [System.IO.Path]::GetFullPath("C:\city-partner-worker-backups")
  if (-not ([System.IO.Path]::GetFullPath($ResolvedTargetDir).TrimEnd('\').Equals($allowedTarget.TrimEnd('\'), [System.StringComparison]::OrdinalIgnoreCase))) {
    throw "TargetDir is outside the approved production worker directory: $ResolvedTargetDir"
  }
  if (-not ([System.IO.Path]::GetFullPath($ResolvedBackupRoot).TrimEnd('\').Equals($allowedBackup.TrimEnd('\'), [System.StringComparison]::OrdinalIgnoreCase))) {
    throw "BackupRoot is outside the approved worker backup directory: $ResolvedBackupRoot"
  }
}

function Get-DeploymentPlan {
  param([string]$ResolvedSourceDir)

  $copyFiles = New-Object System.Collections.Generic.List[string]
  $skipFiles = New-Object System.Collections.Generic.List[string]
  $reportedSkippedDirs = New-Object "System.Collections.Generic.HashSet[string]"
  $sourceEnvPath = Join-WorkerEnvPath -WorkerDir $ResolvedSourceDir

  if (Test-Path -LiteralPath $sourceEnvPath -PathType Leaf) {
    throw "Source env file is forbidden: $sourceEnvPath"
  }

  $items = Get-ChildItem -LiteralPath $ResolvedSourceDir -Recurse -File -Force

  foreach ($dirName in @("logs", "node_modules", "tests")) {
    $dirPath = Join-Path $ResolvedSourceDir $dirName
    if (Test-Path -LiteralPath $dirPath -PathType Container) {
      [void]$reportedSkippedDirs.Add($dirName)
      $skipFiles.Add("$dirName\ ($dirName directory)")
    }
  }

  foreach ($item in $items) {
    $relativePath = Get-RelativePath -BasePath $ResolvedSourceDir -FullPath $item.FullName
    $parts = $relativePath -split "\\"
    $skipReason = $null

    if ($item.Name -eq ".env") {
      throw "SourceDir contains forbidden .env file. Remove it before deployment."
    } elseif ($parts -contains "logs") {
      $skipReason = "logs directory"
    } elseif ($parts -contains "node_modules") {
      $skipReason = "node_modules directory"
    } elseif ($parts -contains "tests") {
      $skipReason = "tests directory"
    } elseif ($item.Name -like "*.bak") {
      $skipReason = "*.bak file"
    } elseif ($item.Name -eq "deploy-worker.ps1") {
      $skipReason = "deployment script is not copied by default"
    }

    if ($skipReason) {
      $topLevel = $parts[0]
      if (-not ($skipReason -like "*directory" -and $reportedSkippedDirs.Contains($topLevel))) {
        $skipFiles.Add("$relativePath ($skipReason)")
      }
    } else {
      $copyFiles.Add($relativePath)
    }
  }

  return [pscustomobject]@{
    Copy = $copyFiles
    Skip = $skipFiles
  }
}

function Write-DeploymentPlan {
  param($Plan)

  Write-DeployLog "Files planned for copy:"
  foreach ($file in $Plan.Copy) {
    Write-DeployLog "  COPY $file"
  }

  Write-DeployLog "Files planned to skip:"
  foreach ($file in $Plan.Skip) {
    Write-DeployLog "  SKIP $file"
  }
}

function Invoke-CheckedCommand {
  param(
    [string]$FileName,
    [string[]]$Arguments,
    [string]$WorkingDirectory
  )

  Write-DeployLog "Running: $FileName $($Arguments -join ' ')"
  $output = & $FileName @Arguments 2>&1
  $exitCode = $LASTEXITCODE
  Write-SafeCommandOutput -Lines ([string[]]$output)

  if ($exitCode -ne 0) {
    throw "Command failed with exit code ${exitCode}: $FileName $($Arguments -join ' ')"
  }

  return [string[]]$output
}

function Stop-WorkerTask {
  param([string]$Name)

  Write-DeployLog "Stopping scheduled task: $Name"
  Stop-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
}

function Start-WorkerTask {
  param([string]$Name)

  Write-DeployLog "Starting scheduled task: $Name"
  Start-ScheduledTask -TaskName $Name
}

function Stop-WorkerProcesses {
  Write-DeployLog "Stopping node.exe processes whose command line contains local_worker.js"
  $processes = Get-CimInstance Win32_Process |
    Where-Object {
      $_.Name -eq "node.exe" -and
      $_.CommandLine -like "*local_worker.js*"
    }

  foreach ($process in $processes) {
    Write-DeployLog "Stopping process id $($process.ProcessId)"
    Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
  }
}

function Test-WorkerProcessExists {
  $processes = Get-CimInstance Win32_Process |
    Where-Object {
      $_.Name -eq "node.exe" -and
      $_.CommandLine -like "*local_worker.js*"
    }

  return [bool]$processes
}

function Backup-WorkerFiles {
  param(
    [string]$ResolvedTargetDir,
    [string]$TargetEnvPath,
    [string]$BackupDir,
    [string]$BackupEnvPath
  )

  New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null
  Write-DeployLog "Backup directory: $BackupDir"

  foreach ($fileName in $BackupFileNames) {
    $sourcePath = Join-Path $ResolvedTargetDir $fileName
    if (Test-Path -LiteralPath $sourcePath -PathType Leaf) {
      Copy-Item -LiteralPath $sourcePath -Destination (Join-Path $BackupDir $fileName) -Force
      Write-DeployLog "Backed up $fileName"
    }
  }

  if (Test-Path -LiteralPath $TargetEnvPath -PathType Leaf) {
    Copy-Item -LiteralPath $TargetEnvPath -Destination $BackupEnvPath -Force
    Write-DeployLog "Backed up production env file without printing contents."
  }
}

function Copy-WorkerFiles {
  param(
    [string]$ResolvedSourceDir,
    [string]$ResolvedTargetDir,
    $Plan
  )

  foreach ($relativePath in $Plan.Copy) {
    $sourcePath = Join-Path $ResolvedSourceDir $relativePath
    $targetPath = Join-Path $ResolvedTargetDir $relativePath
    $targetParent = Split-Path -Parent $targetPath
    New-Item -ItemType Directory -Path $targetParent -Force | Out-Null
    Copy-Item -LiteralPath $sourcePath -Destination $targetPath -Force
    Write-DeployLog "Copied $relativePath"
  }
}

function Restore-WorkerBackup {
  param(
    [string]$BackupDir,
    [string]$BackupEnvPath,
    [string]$ResolvedTargetDir,
    [string]$TargetEnvPath,
    [string]$Name
  )

  Write-DeployLog "Starting rollback from backup: $BackupDir"
  Stop-WorkerTask -Name $Name
  Stop-WorkerProcesses

  foreach ($fileName in $BackupFileNames) {
    $backupPath = Join-Path $BackupDir $fileName
    if (Test-Path -LiteralPath $backupPath -PathType Leaf) {
      Copy-Item -LiteralPath $backupPath -Destination (Join-Path $ResolvedTargetDir $fileName) -Force
      Write-DeployLog "Restored $fileName"
    }
  }

  if ((Test-Path -LiteralPath $BackupEnvPath -PathType Leaf) -and
      -not (Test-Path -LiteralPath $TargetEnvPath -PathType Leaf)) {
    Copy-Item -LiteralPath $BackupEnvPath -Destination $TargetEnvPath -Force
    Write-DeployLog "Restored missing production env file without printing contents."
  }

  Start-WorkerTask -Name $Name
  Write-DeployLog "WORKER_DEPLOYMENT_ROLLED_BACK"
}

function Assert-VerificationPassed {
  param([string]$ResolvedSourceDir)

  Push-Location $ResolvedSourceDir
  try {
    $output = Invoke-CheckedCommand -FileName "powershell.exe" -Arguments @(
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      "verify-worker.ps1"
    ) -WorkingDirectory $ResolvedSourceDir

    if (-not ($output -contains "WORKER_VERIFICATION_PASSED")) {
      throw "verify-worker.ps1 did not output WORKER_VERIFICATION_PASSED"
    }
  } finally {
    Pop-Location
  }
}

function Assert-RequiredSourceFiles {
  param([string]$ResolvedSourceDir)

  foreach ($fileName in $RequiredSourceFiles) {
    $path = Join-Path $ResolvedSourceDir $fileName
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
      throw "Required source file is missing: $fileName"
    }
  }
}

$ResolvedSourceDir = Resolve-ExistingDirectory -Path $SourceDir -Label "SourceDir"
$SourceEnvPath = Join-WorkerEnvPath -WorkerDir $ResolvedSourceDir
$TargetEnvPath = Join-WorkerEnvPath -WorkerDir $TargetDir
$BackupEnvPathPattern = Join-Path $BackupRoot "yyyyMMdd-HHmmss.env"
$Plan = Get-DeploymentPlan -ResolvedSourceDir $ResolvedSourceDir

Write-DeployLog "SourceDir: $ResolvedSourceDir"
Write-DeployLog "Source env path forbidden for deployment: $SourceEnvPath"
Write-DeployLog "TargetDir: $TargetDir"
Write-DeployLog "Production env path: $TargetEnvPath"
Write-DeployLog "BackupRoot: $BackupRoot"
Write-DeployLog "BackupDir: $BackupRoot\<yyyyMMdd-HHmmss>"
Write-DeployLog "Backup env path: $BackupEnvPathPattern"
Write-DeployLog "TaskName: $TaskName"
Write-DeployLog "SkipRestart: $([bool]$SkipRestart)"
Write-DeployLog "Default mode is dry-run. Pass -Apply to deploy."
Assert-RequiredSourceFiles -ResolvedSourceDir $ResolvedSourceDir
Write-DeploymentPlan -Plan $Plan

if (-not $Apply) {
  Write-DeployLog "Dry-run complete. No scheduled task, node process, production file, backup, or env file was modified."
  Write-DeployLog "Apply mode will verify source files, check target paths, create backup, copy allowed files, run node syntax checks, and restart the scheduled task unless -SkipRestart is set."
  exit 0
}

$ResolvedTargetDir = Resolve-ExistingDirectory -Path $TargetDir -Label "TargetDir"
$ResolvedBackupRoot = [System.IO.Path]::GetFullPath($BackupRoot)
Assert-SafeDeploymentPaths -ResolvedSourceDir $ResolvedSourceDir -ResolvedTargetDir $ResolvedTargetDir -ResolvedBackupRoot $ResolvedBackupRoot
if (-not (Test-Path -LiteralPath $ResolvedBackupRoot -PathType Container)) {
  New-Item -ItemType Directory -Path $ResolvedBackupRoot -Force | Out-Null
}
$ResolvedBackupRoot = (Resolve-Path -LiteralPath $ResolvedBackupRoot).Path

$TargetEnvPath = Join-WorkerEnvPath -WorkerDir $ResolvedTargetDir
Assert-RequiredSourceFiles -ResolvedSourceDir $ResolvedSourceDir
Assert-VerificationPassed -ResolvedSourceDir $ResolvedSourceDir

if (-not (Test-Path -LiteralPath $TargetEnvPath -PathType Leaf)) {
  throw "Production env file is missing: $TargetEnvPath"
}

$BackupDir = Join-Path $ResolvedBackupRoot (Get-Date -Format "yyyyMMdd-HHmmss")
$BackupEnvPath = Join-WorkerEnvPath -WorkerDir $BackupDir
Write-DeployLog "Backup directory: $BackupDir"
Write-DeployLog "Backup env path: $BackupEnvPath"

try {
  Backup-WorkerFiles -ResolvedTargetDir $ResolvedTargetDir -TargetEnvPath $TargetEnvPath -BackupDir $BackupDir -BackupEnvPath $BackupEnvPath
  Stop-WorkerTask -Name $TaskName
  Stop-WorkerProcesses
  Copy-WorkerFiles -ResolvedSourceDir $ResolvedSourceDir -ResolvedTargetDir $ResolvedTargetDir -Plan $Plan

  Push-Location $ResolvedTargetDir
  try {
    Invoke-CheckedCommand -FileName "node" -Arguments @("--check", "local_worker.js") -WorkingDirectory $ResolvedTargetDir | Out-Null
    Invoke-CheckedCommand -FileName "node" -Arguments @("--check", "git-safety.js") -WorkingDirectory $ResolvedTargetDir | Out-Null
  } finally {
    Pop-Location
  }

  if ((Test-Path -LiteralPath (Join-Path $ResolvedTargetDir "package.json") -PathType Leaf) -and
      -not (Test-Path -LiteralPath (Join-Path $ResolvedTargetDir "node_modules") -PathType Container)) {
    Write-DeployLog "package.json exists but node_modules is missing. Run npm install manually in the target directory if dependencies are required."
  }

  if (-not $SkipRestart) {
    Start-WorkerTask -Name $TaskName
    Start-Sleep -Seconds 5
    if (-not (Test-WorkerProcessExists)) {
      throw "Worker process did not start after scheduled task restart."
    }
  } else {
    Write-DeployLog "SkipRestart was set. Scheduled task was not restarted and process check was skipped."
  }

  Write-DeployLog "WORKER_DEPLOYMENT_SUCCEEDED"
} catch {
  Write-DeployLog "Deployment failed: $(ConvertTo-SafeLogLine -Line $_.Exception.Message)"
  if (Test-Path -LiteralPath $BackupDir -PathType Container) {
    Restore-WorkerBackup -BackupDir $BackupDir -BackupEnvPath $BackupEnvPath -ResolvedTargetDir $ResolvedTargetDir -TargetEnvPath $TargetEnvPath -Name $TaskName
  }
  exit 1
}
