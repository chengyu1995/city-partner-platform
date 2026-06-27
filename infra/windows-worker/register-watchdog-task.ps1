param(
  [string]$WorkerDir = "C:\city-partner-worker",
  [string]$WatchdogTaskName = "CityPartnerCodexWorkerWatchdog",
  [string]$WorkerTaskName = "CityPartnerCodexWorker",
  [int]$FrequencyMinutes = 1,
  [switch]$Apply,
  [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$Mode = if ($Apply) { "APPLY" } else { "DRY-RUN" }

function Write-RegisterLog {
  param([string]$Message)
  Write-Host "[$Mode] $Message"
}

function Join-WorkerEnvPath {
  param([string]$Path)

  $fullDir = [System.IO.Path]::GetFullPath($Path).TrimEnd('\')
  $parentDir = Split-Path -Parent $fullDir
  $leafName = Split-Path -Leaf $fullDir
  return Join-Path $parentDir "$leafName.env"
}

function Test-ScheduledTaskExists {
  param([string]$Name)

  $previousErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    & schtasks.exe /Query /TN $Name 2>&1 | Out-Null
    return $LASTEXITCODE -eq 0
  } catch {
    return $false
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
}

function Get-ScheduledTaskSummary {
  param([string]$Name)

  $previousErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    $output = & schtasks.exe /Query /TN $Name /FO LIST /V 2>&1
    if ($LASTEXITCODE -ne 0) {
      return @()
    }

    return [string[]]$output
  } catch {
    return @()
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
}

function ConvertTo-XmlText {
  param([string]$Value)

  return [System.Security.SecurityElement]::Escape($Value)
}

function New-WatchdogTaskXml {
  param(
    [string]$Command,
    [string]$Arguments,
    [int]$Minutes
  )

  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  $userId = ConvertTo-XmlText -Value $identity.User.Value
  $author = ConvertTo-XmlText -Value $identity.Name
  $commandText = ConvertTo-XmlText -Value $Command
  $argumentsText = ConvertTo-XmlText -Value $Arguments
  $startBoundary = (Get-Date).ToString("s")
  $interval = "PT${Minutes}M"

  return @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Author>$author</Author>
    <Description>Runs the City Partner Codex Worker watchdog every $Minutes minute(s).</Description>
  </RegistrationInfo>
  <Triggers>
    <CalendarTrigger>
      <StartBoundary>$startBoundary</StartBoundary>
      <Enabled>true</Enabled>
      <ScheduleByDay>
        <DaysInterval>1</DaysInterval>
      </ScheduleByDay>
      <Repetition>
        <Interval>$interval</Interval>
        <Duration>P1D</Duration>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
    </CalendarTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>$userId</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>HighestAvailable</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <DisallowStartOnRemoteAppSession>false</DisallowStartOnRemoteAppSession>
    <UseUnifiedSchedulingEngine>true</UseUnifiedSchedulingEngine>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT2M</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>$commandText</Command>
      <Arguments>$argumentsText</Arguments>
    </Exec>
  </Actions>
</Task>
"@
}

function Invoke-TaskRegistration {
  param(
    [string]$Name,
    [string]$XmlContent,
    [bool]$Overwrite
  )

  $tempFile = New-TemporaryFile
  try {
    Set-Content -LiteralPath $tempFile.FullName -Value $XmlContent -Encoding Unicode

    $arguments = @("/Create", "/TN", $Name, "/XML", $tempFile.FullName)
    if ($Overwrite) {
      $arguments += "/F"
    }

    $output = & schtasks.exe @arguments 2>&1
    $exitCode = $LASTEXITCODE
    foreach ($line in [string[]]$output) {
      Write-RegisterLog $line
    }

    if ($exitCode -ne 0) {
      throw "schtasks.exe failed with exit code $exitCode"
    }
  } finally {
    Remove-Item -LiteralPath $tempFile.FullName -Force -ErrorAction SilentlyContinue
  }
}

if ($FrequencyMinutes -lt 1) {
  Write-RegisterLog "WATCHDOG_TASK_REGISTER_FAILED"
  throw "FrequencyMinutes must be at least 1."
}

$workerDirExists = Test-Path -LiteralPath $WorkerDir -PathType Container
$watchdogPath = Join-Path $WorkerDir "worker-watchdog.ps1"
$watchdogExists = Test-Path -LiteralPath $watchdogPath -PathType Leaf
$workerEnvPath = Join-WorkerEnvPath -Path $WorkerDir
$workerEnvExists = Test-Path -LiteralPath $workerEnvPath -PathType Leaf
$workerTaskExists = Test-ScheduledTaskExists -Name $WorkerTaskName
$watchdogTaskExists = Test-ScheduledTaskExists -Name $WatchdogTaskName

$watchdogArguments = "-NoProfile -ExecutionPolicy Bypass -File `"$watchdogPath`" -Apply"
$displayCommand = "powershell.exe $watchdogArguments"
$taskXml = New-WatchdogTaskXml -Command "powershell.exe" -Arguments $watchdogArguments -Minutes $FrequencyMinutes

Write-RegisterLog "Mode: $Mode"
Write-RegisterLog "WorkerDir: $WorkerDir"
Write-RegisterLog "WorkerDir exists: $workerDirExists"
Write-RegisterLog "Watchdog script: $watchdogPath"
Write-RegisterLog "Watchdog script exists: $watchdogExists"
Write-RegisterLog "Worker env path: $workerEnvPath"
Write-RegisterLog "Worker env exists: $workerEnvExists"
Write-RegisterLog "Worker task name: $WorkerTaskName"
Write-RegisterLog "Worker task exists: $workerTaskExists"
Write-RegisterLog "Watchdog task name: $WatchdogTaskName"
Write-RegisterLog "Watchdog task exists: $watchdogTaskExists"
Write-RegisterLog "Watchdog command: $displayCommand"
Write-RegisterLog "Frequency minutes: $FrequencyMinutes"
Write-RegisterLog "Highest privileges: true"
Write-RegisterLog "Multiple instances policy: IgnoreNew"
Write-RegisterLog "Execution time limit: PT2M"
Write-RegisterLog "Start when available: true"

if ($watchdogTaskExists) {
  Write-RegisterLog "Current watchdog task configuration:"
  foreach ($line in (Get-ScheduledTaskSummary -Name $WatchdogTaskName)) {
    Write-RegisterLog "  $line"
  }
}

if (-not $Apply) {
  Write-RegisterLog "Dry-run complete. No scheduled task, node process, production file, or env file was modified."
  exit 0
}

if (-not $workerDirExists -or -not $watchdogExists -or -not $workerEnvExists -or -not $workerTaskExists) {
  Write-RegisterLog "Required Worker prerequisites are missing. Watchdog task was not registered."
  Write-RegisterLog "WATCHDOG_TASK_REGISTER_FAILED"
  exit 1
}

if ($watchdogTaskExists -and -not $Force) {
  Write-RegisterLog "Watchdog task already exists. Pass -Force with -Apply to overwrite it."
  Write-RegisterLog "WATCHDOG_TASK_ALREADY_EXISTS"
  exit 0
}

try {
  Invoke-TaskRegistration -Name $WatchdogTaskName -XmlContent $taskXml -Overwrite:([bool]$Force)
  Write-RegisterLog "WATCHDOG_TASK_REGISTERED"
} catch {
  Write-RegisterLog "Register failed: $($_.Exception.Message)"
  Write-RegisterLog "WATCHDOG_TASK_REGISTER_FAILED"
  exit 1
}
