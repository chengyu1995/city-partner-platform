Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$WorkerRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$TempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("worker-git-integration-" + [System.Guid]::NewGuid().ToString("N"))
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$SafetyRunnerPath = Join-Path $TempRoot "safety-runner.js"

$SafetyRunner = @'
const fs = require("fs");
const path = require("path");
const fn = process.argv[2];
const payloadPath = process.argv[3];
const workerRoot = process.argv[4];
const safety = require(path.join(workerRoot, "git-safety"));
const args = JSON.parse(fs.readFileSync(payloadPath, "utf8"));

if (
  ["assertCleanStatusEntries", "getStatusPaths", "getTrackedStatusPaths"].includes(fn) &&
  !Array.isArray(args[0])
) {
  args[0] = [args[0]];
}

if (["validateCommittablePaths", "validateStagedPaths"].includes(fn) && !Array.isArray(args[0])) {
  args[0] = [args[0]];
}

if (fn === "validateStagedPaths" && !Array.isArray(args[1])) {
  args[1] = [args[1]];
}

try {
  const result = safety[fn](...args);
  process.stdout.write(JSON.stringify({ threw: false, result }));
} catch (error) {
  process.stdout.write(JSON.stringify({ threw: true, message: error.message }));
}
'@

function Assert-True {
  param(
    [bool]$Condition,
    [string]$Message
  )

  if (-not $Condition) {
    throw $Message
  }
}

function Assert-Equal {
  param(
    $Actual,
    $Expected,
    [string]$Message
  )

  if ($Actual -ne $Expected) {
    throw "$Message Expected=[$Expected] Actual=[$Actual]"
  }
}

function ConvertTo-Array {
  param($Value)

  if ($null -eq $Value) {
    return @()
  }

  if ($Value -is [array]) {
    return @($Value)
  }

  return @($Value)
}

function Assert-ArrayEqual {
  param(
    $Actual,
    [string[]]$Expected,
    [string]$Message
  )

  $actualArray = @(ConvertTo-Array $Actual)

  Assert-Equal $actualArray.Count $Expected.Count $Message

  for ($index = 0; $index -lt $Expected.Count; $index += 1) {
    Assert-Equal ([string]$actualArray[$index]) $Expected[$index] $Message
  }
}

function Write-TestFile {
  param(
    [string]$Root,
    [string]$RelativePath,
    [string]$Content
  )

  $absolutePath = Join-Path $Root $RelativePath
  $directory = Split-Path -Parent $absolutePath

  if ($directory -and -not (Test-Path -LiteralPath $directory)) {
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
  }

  [System.IO.File]::WriteAllText($absolutePath, $Content, $Utf8NoBom)
}

function ConvertTo-ProcessArguments {
  param([string[]]$Arguments)

  $escaped = foreach ($argument in $Arguments) {
    $value = [string]$argument

    if ($value -notmatch '[\s"]') {
      $value
      continue
    }

    $value = $value -replace '(\\*)"', '$1$1\"'
    $value = $value -replace '(\\+)$', '$1$1'
    '"' + $value + '"'
  }

  return ($escaped -join " ")
}

function Invoke-ProcessText {
  param(
    [string]$FileName,
    [string[]]$Arguments,
    [string]$WorkingDirectory = $WorkerRoot
  )

  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $FileName
  $startInfo.WorkingDirectory = $WorkingDirectory
  $startInfo.UseShellExecute = $false
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $startInfo.StandardOutputEncoding = $Utf8NoBom
  $startInfo.StandardErrorEncoding = $Utf8NoBom
  $startInfo.Arguments = ConvertTo-ProcessArguments -Arguments $Arguments

  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $startInfo
  [void]$process.Start()
  $stdout = $process.StandardOutput.ReadToEnd()
  $stderr = $process.StandardError.ReadToEnd()
  $process.WaitForExit()

  if ($process.ExitCode -ne 0) {
    throw "Command failed: $FileName $($Arguments -join ' ')`n$stderr`n$stdout"
  }

  return $stdout
}

function Invoke-Git {
  param(
    [string]$Repo,
    [string[]]$Arguments
  )

  return Invoke-ProcessText -FileName "git" -Arguments (@("-c", "core.quotepath=false") + $Arguments) -WorkingDirectory $Repo
}

function Invoke-Safety {
  param(
    [string]$FunctionName,
    [object[]]$Arguments
  )

  $payloadPath = Join-Path $TempRoot ("payload-" + [System.Guid]::NewGuid().ToString("N") + ".json")
  [System.IO.File]::WriteAllText($payloadPath, (ConvertTo-Json -InputObject $Arguments -Compress -Depth 20), $Utf8NoBom)

  try {
    $json = Invoke-ProcessText -FileName "node" -Arguments @($SafetyRunnerPath, $FunctionName, $payloadPath, $WorkerRoot) -WorkingDirectory $WorkerRoot
    return $json | ConvertFrom-Json
  } finally {
    Remove-Item -LiteralPath $payloadPath -Force -ErrorAction SilentlyContinue
  }
}

function Assert-SafetyPass {
  param(
    [string]$FunctionName,
    [object[]]$Arguments
  )

  $result = Invoke-Safety -FunctionName $FunctionName -Arguments $Arguments
  if ($result.threw) {
    throw "$FunctionName failed: $($result.message)"
  }
  if ($result.PSObject.Properties.Name -contains "result") {
    return $result.result
  }

  return $null
}

function Assert-SafetyFail {
  param(
    [string]$FunctionName,
    [object[]]$Arguments,
    [string]$ExpectedMessagePart
  )

  $result = Invoke-Safety -FunctionName $FunctionName -Arguments $Arguments
  Assert-True $result.threw "$FunctionName was expected to fail"
  Assert-True ([string]$result.message).Contains($ExpectedMessagePart) "$FunctionName failed with unexpected message: $($result.message)"
  return $result.message
}

function Get-StatusEntries {
  param([string]$Repo)

  $status = Invoke-Git -Repo $Repo -Arguments @("status", "--porcelain=v1", "-z")
  return Assert-SafetyPass -FunctionName "parseGitStatusPorcelain" -Arguments @($status)
}

function Get-StatusPaths {
  param($Entries)

  return Assert-SafetyPass -FunctionName "getStatusPaths" -Arguments @($Entries)
}

function Get-CachedNames {
  param([string]$Repo)

  $names = Invoke-Git -Repo $Repo -Arguments @("diff", "--cached", "--name-only")
  return @($names -split "`r?`n" | Where-Object { $_ })
}

function New-TestRepo {
  param([string]$Name)

  $repo = Join-Path $TempRoot $Name
  New-Item -ItemType Directory -Path $repo -Force | Out-Null
  Invoke-Git -Repo $repo -Arguments @("init") | Out-Null
  Invoke-Git -Repo $repo -Arguments @("config", "user.name", "Worker Safety Test") | Out-Null
  Invoke-Git -Repo $repo -Arguments @("config", "user.email", "worker-test@example.invalid") | Out-Null
  Invoke-Git -Repo $repo -Arguments @("config", "core.quotepath", "false") | Out-Null
  Write-TestFile -Root $repo -RelativePath "tracked.txt" -Content "initial`n"
  Invoke-Git -Repo $repo -Arguments @("add", "--", "tracked.txt") | Out-Null
  Invoke-Git -Repo $repo -Arguments @("commit", "-m", "initial") | Out-Null
  return $repo
}

function Pass {
  param([string]$Name)
  Write-Host "PASS $Name"
}

try {
  New-Item -ItemType Directory -Path $TempRoot -Force | Out-Null
  [System.IO.File]::WriteAllText($SafetyRunnerPath, $SafetyRunner, $Utf8NoBom)
  Push-Location $WorkerRoot

  Invoke-ProcessText -FileName "git" -Arguments @("--version") -WorkingDirectory $WorkerRoot | Write-Host

  $repo = New-TestRepo -Name "clean"
  $status = Invoke-Git -Repo $repo -Arguments @("status", "--porcelain=v1", "-z")
  Assert-Equal $status "" "clean worktree status must be empty"
  Pass "scenario 1 clean worktree"

  $repo = New-TestRepo -Name "modified"
  Write-TestFile -Root $repo -RelativePath "tracked.txt" -Content "changed`n"
  $paths = Get-StatusPaths -Entries (Get-StatusEntries -Repo $repo)
  Assert-ArrayEqual $paths @("tracked.txt") "modified path should be parsed"
  Assert-SafetyPass -FunctionName "validateCommittablePaths" -Arguments @($paths, @{ projectRoot = $repo }) | Out-Null
  Pass "scenario 2 modified file"

  $repo = New-TestRepo -Name "added"
  Write-TestFile -Root $repo -RelativePath "new.txt" -Content "new`n"
  Invoke-Git -Repo $repo -Arguments @("add", "--", "new.txt") | Out-Null
  $cached = Get-CachedNames -Repo $repo
  $validated = Assert-SafetyPass -FunctionName "validateStagedPaths" -Arguments @(@("new.txt"), $cached)
  Assert-ArrayEqual $validated @("new.txt") "added file should be exactly staged"
  Pass "scenario 3 added file"

  $repo = New-TestRepo -Name "deleted"
  Remove-Item -LiteralPath (Join-Path $repo "tracked.txt") -Force
  Invoke-Git -Repo $repo -Arguments @("add", "--", "tracked.txt") | Out-Null
  $cached = Get-CachedNames -Repo $repo
  Assert-ArrayEqual $cached @("tracked.txt") "deleted file should appear in cached names"
  Pass "scenario 4 deleted file"

  $repo = New-TestRepo -Name "renamed"
  Invoke-Git -Repo $repo -Arguments @("mv", "tracked.txt", "renamed.txt") | Out-Null
  $entries = Get-StatusEntries -Repo $repo
  Assert-Equal ([string]$entries[0].path) "renamed.txt" "rename new path should be parsed"
  Assert-Equal ([string]$entries[0].originalPath) "tracked.txt" "rename original path should be parsed"
  $paths = Get-StatusPaths -Entries $entries
  Assert-ArrayEqual $paths @("renamed.txt") "rename old path must not be a task path"
  $cached = Get-CachedNames -Repo $repo
  Assert-SafetyPass -FunctionName "validateStagedPaths" -Arguments @(@("renamed.txt"), $cached) | Out-Null
  Pass "scenario 5 renamed file"

  $repo = New-TestRepo -Name "spaces"
  Write-TestFile -Root $repo -RelativePath "file with spaces.txt" -Content "space`n"
  Invoke-Git -Repo $repo -Arguments @("add", "--", "file with spaces.txt") | Out-Null
  $cached = Get-CachedNames -Repo $repo
  $validated = Assert-SafetyPass -FunctionName "validateStagedPaths" -Arguments @(@("file with spaces.txt"), $cached)
  Assert-ArrayEqual $validated @("file with spaces.txt") "space path should remain whole"
  Pass "scenario 6 space filename"

  $repo = New-TestRepo -Name "unicode"
  Write-TestFile -Root $repo -RelativePath "中文文件.txt" -Content "unicode`n"
  Invoke-Git -Repo $repo -Arguments @("add", "--", "中文文件.txt") | Out-Null
  $cached = Get-CachedNames -Repo $repo
  $validated = Assert-SafetyPass -FunctionName "validateStagedPaths" -Arguments @(@("中文文件.txt"), $cached)
  Assert-ArrayEqual $validated @("中文文件.txt") "unicode path should be recognized"
  Pass "scenario 7 Chinese filename"

  $repo = New-TestRepo -Name "extra-staged"
  Write-TestFile -Root $repo -RelativePath "expected.txt" -Content "expected`n"
  Write-TestFile -Root $repo -RelativePath "extra.txt" -Content "extra`n"
  Invoke-Git -Repo $repo -Arguments @("add", "--", "expected.txt", "extra.txt") | Out-Null
  $cached = Get-CachedNames -Repo $repo
  Assert-SafetyFail -FunctionName "validateStagedPaths" -Arguments @(@("expected.txt"), $cached) -ExpectedMessagePart "extra.txt" | Out-Null
  Invoke-Git -Repo $repo -Arguments @("restore", "--staged", "--", "expected.txt", "extra.txt") | Out-Null
  Assert-True (Test-Path -LiteralPath (Join-Path $repo "expected.txt")) "expected file should remain after unstaging"
  Assert-True (Test-Path -LiteralPath (Join-Path $repo "extra.txt")) "extra file should remain after unstaging"
  Assert-ArrayEqual (Get-CachedNames -Repo $repo) @() "cached names should be empty after unstaging"
  Pass "scenario 8 extra staged pollution"

  $blocked = @(".env", "config/.env", "infra/windows-worker/.env", "logs/worker.log", "backup.bak", "folder/file.BAK")
  foreach ($item in $blocked) {
    $isSensitive = Assert-SafetyPass -FunctionName "isSensitivePath" -Arguments @($item)
    Assert-True ([bool]$isSensitive) "sensitive path was not blocked: $item"
  }

  $allowed = @(".env.example", "infra/windows-worker/.env.example", "README.md", "src/example.ts")
  foreach ($item in $allowed) {
    $isSensitive = Assert-SafetyPass -FunctionName "isSensitivePath" -Arguments @($item)
    Assert-True (-not [bool]$isSensitive) "safe path was blocked: $item"
  }
  Pass "scenario 9 sensitive path rules"

  $repo = New-TestRepo -Name "preexisting-pollution"
  Write-TestFile -Root $repo -RelativePath "preexisting.txt" -Content "do not remove`n"
  $before = [System.IO.File]::ReadAllText((Join-Path $repo "preexisting.txt"), $Utf8NoBom)
  $entries = Get-StatusEntries -Repo $repo
  Assert-SafetyFail -FunctionName "assertCleanStatusEntries" -Arguments @($entries) -ExpectedMessagePart "preexisting.txt" | Out-Null
  $after = [System.IO.File]::ReadAllText((Join-Path $repo "preexisting.txt"), $Utf8NoBom)
  Assert-Equal $after $before "preexisting file content must not change"
  Assert-True (Test-Path -LiteralPath (Join-Path $repo "preexisting.txt")) "preexisting file must remain"
  Pass "scenario 10 preexisting worktree pollution"

  Write-Host "GIT_INTEGRATION_TESTS_PASSED"
} finally {
  Pop-Location -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $TempRoot) {
    Remove-Item -LiteralPath $TempRoot -Recurse -Force
  }
}
