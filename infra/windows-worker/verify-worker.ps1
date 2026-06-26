Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$WorkerRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

function Invoke-CheckedCommand {
  param(
    [string]$FileName,
    [string[]]$Arguments
  )

  & $FileName @Arguments

  if ($LASTEXITCODE -ne 0) {
    throw "Command failed with exit code ${LASTEXITCODE}: $FileName $($Arguments -join ' ')"
  }
}

function Assert-FileDoesNotMatch {
  param(
    [string]$Path,
    [string]$Pattern,
    [string]$Message
  )

  $content = Get-Content -LiteralPath $Path -Raw

  if ($content -match $Pattern) {
    throw $Message
  }
}

Push-Location $WorkerRoot

try {
  Invoke-CheckedCommand -FileName "node" -Arguments @("--version")
  Invoke-CheckedCommand -FileName "git" -Arguments @("--version")
  Invoke-CheckedCommand -FileName "node" -Arguments @("--check", "local_worker.js")
  Invoke-CheckedCommand -FileName "node" -Arguments @("--check", "git-safety.js")
  Invoke-CheckedCommand -FileName "npm" -Arguments @("test")
  Invoke-CheckedCommand -FileName "powershell.exe" -Arguments @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "tests/git-integration.ps1")

  Assert-FileDoesNotMatch -Path "local_worker.js" -Pattern "git\s+add\s+-A" -Message "local_worker.js contains unrestricted git add"
  Assert-FileDoesNotMatch -Path "local_worker.js" -Pattern "reset[`"'\s,]+--hard|reset\s+--hard" -Message "local_worker.js contains destructive reset"
  Assert-FileDoesNotMatch -Path "local_worker.js" -Pattern "clean[`"'\s,]+-fd|clean\s+-fd" -Message "local_worker.js contains destructive clean"

  $integrationScript = "tests/git-integration.ps1"
  Assert-FileDoesNotMatch -Path $integrationScript -Pattern ("\bgit\s+pu" + "sh\b") -Message "integration script contains remote write command"
  Assert-FileDoesNotMatch -Path $integrationScript -Pattern "WORKER_API_URL" -Message "integration script references worker API URL"
  Assert-FileDoesNotMatch -Path $integrationScript -Pattern ([regex]::Escape("C:\city-partner-" + "worker.env")) -Message "integration script references production env file"

  Write-Host "WORKER_VERIFICATION_PASSED"
} finally {
  Pop-Location
}
