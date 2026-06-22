param(
  [int]$Port = 3000,
  [switch]$NoBrowser,
  [switch]$NoInstall
)

$ErrorActionPreference = "Stop"

$repoRoot = $PSScriptRoot
$runtimeDir = Join-Path $repoRoot ".data\runtime"
$pidPath = Join-Path $runtimeDir "dev-local.pid"
$portPath = Join-Path $runtimeDir "dev-local.port"
$logPath = Join-Path $runtimeDir "dev-local.log"
$errPath = Join-Path $runtimeDir "dev-local.err.log"
$lockPath = Join-Path $runtimeDir "dev-local.lock"

Set-Location $repoRoot
New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null

function Enter-LaunchLock {
  param(
    [string]$Path,
    [int]$TimeoutSeconds = 30
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    try {
      return [System.IO.File]::Open(
        $Path,
        [System.IO.FileMode]::OpenOrCreate,
        [System.IO.FileAccess]::ReadWrite,
        [System.IO.FileShare]::None
      )
    } catch {
      Start-Sleep -Milliseconds 200
    }
  }

  throw "Another dev-local launch is still in progress. Try again in a few seconds."
}

function Test-PortInUse {
  param([int]$TargetPort)

  try {
    return [bool](Get-NetTCPConnection -LocalPort $TargetPort -State Listen -ErrorAction Stop)
  } catch {
    return $false
  }
}

function Find-AvailablePort {
  param([int]$PreferredPort)

  $candidate = $PreferredPort
  while (Test-PortInUse -TargetPort $candidate) {
    $candidate += 1
  }

  return $candidate
}

function Get-ProcessByPidFile {
  $rawPid = Get-Content -Path $pidPath -ErrorAction SilentlyContinue | Select-Object -First 1
  $processId = 0
  if (-not [int]::TryParse([string]$rawPid, [ref]$processId)) {
    return $null
  }

  try {
    return Get-Process -Id $processId -ErrorAction Stop
  } catch {}

  return $null
}

function Read-PortFromCommandLine {
  param(
    [string]$CommandLine,
    [int]$FallbackPort
  )

  if ($CommandLine -match "--port\s+([0-9]+)") {
    return [int]$Matches[1]
  }

  return $FallbackPort
}

function Find-ExistingDevServer {
  $pidFileProcess = if (Test-Path $pidPath) { Get-ProcessByPidFile } else { $null }
  $pidFilePort = if (Test-Path $portPath) { Get-Content -Path $portPath -ErrorAction SilentlyContinue | Select-Object -First 1 } else { $Port }

  if ($pidFileProcess -and (Wait-ForLocalUrl -Url "http://127.0.0.1:$pidFilePort" -TimeoutSeconds 2)) {
    return [pscustomobject]@{
      Port = [int]$pidFilePort
      Process = $pidFileProcess
    }
  }

  try {
    $candidate = Get-CimInstance Win32_Process -ErrorAction Stop |
      Where-Object {
        $_.CommandLine -and
        $_.CommandLine -match "--port\s+[0-9]+" -and
        (
          ($_.CommandLine.Contains($repoRoot) -and $_.CommandLine -match "next") -or
          $_.CommandLine -match "run\s+dev:(app|full)"
        )
      } |
      Select-Object -First 1
  } catch {
    $candidate = $null
  }

  if (-not $candidate) {
    Remove-Item -Path $pidPath -Force -ErrorAction SilentlyContinue
    Remove-Item -Path $portPath -Force -ErrorAction SilentlyContinue
    return $null
  }

  $candidatePort = Read-PortFromCommandLine -CommandLine $candidate.CommandLine -FallbackPort $Port
  if (-not (Wait-ForLocalUrl -Url "http://127.0.0.1:$candidatePort" -TimeoutSeconds 2)) {
    return $null
  }

  try {
    $process = Get-Process -Id $candidate.ProcessId -ErrorAction Stop
    Set-Content -Path $pidPath -Value $process.Id
    Set-Content -Path $portPath -Value $candidatePort
    return [pscustomobject]@{
      Port = $candidatePort
      Process = $process
    }
  } catch {
    return $null
  }
}

function Wait-ForLocalUrl {
  param(
    [string]$Url,
    [int]$TimeoutSeconds = 90
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    try {
      Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2 | Out-Null
      return $true
    } catch {
      Start-Sleep -Milliseconds 900
    }
  }

  return $false
}

function Open-LocalUrl {
  param([string]$Url)

  try {
    Start-Process -FilePath "rundll32.exe" -ArgumentList @("url.dll,FileProtocolHandler", $Url)
  } catch {
    Start-Process $Url
  }
}

$launchLock = Enter-LaunchLock -Path $lockPath
try {
  if (-not (Test-Path (Join-Path $repoRoot "package.json"))) {
    throw "package.json was not found in $repoRoot"
  }

  if (-not (Test-Path (Join-Path $repoRoot "node_modules")) -and -not $NoInstall) {
    if (Test-Path (Join-Path $repoRoot "package-lock.json")) {
      & npm.cmd ci
    } else {
      & npm.cmd install
    }
  }

  $existing = Find-ExistingDevServer
  if ($existing) {
    $url = "http://localhost:$($existing.Port)"
    Write-Output "4lpha 0G dev server already tracked."
    Write-Output "PID: $($existing.Process.Id)"
    Write-Output "URL: $url"
    Write-Output "Logs: $logPath"
    Write-Output "Errors: $errPath"
    if (-not $NoBrowser) {
      Open-LocalUrl -Url $url
    }
    exit 0
  }

  $selectedPort = Find-AvailablePort -PreferredPort $Port
  $listenUrl = "http://127.0.0.1:$selectedPort"
  $openUrl = "http://localhost:$selectedPort"
  $arguments = @("run", "dev:full", "--", "--hostname", "127.0.0.1", "--port", [string]$selectedPort)

  Set-Content -Path $logPath -Value ""
  Set-Content -Path $errPath -Value ""

  $process = Start-Process `
    -FilePath "npm.cmd" `
    -ArgumentList $arguments `
    -WorkingDirectory $repoRoot `
    -RedirectStandardOutput $logPath `
    -RedirectStandardError $errPath `
    -PassThru `
    -WindowStyle Hidden

  Set-Content -Path $pidPath -Value $process.Id
  Set-Content -Path $portPath -Value $selectedPort

  if (-not (Wait-ForLocalUrl -Url $listenUrl)) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    Write-Output "4lpha 0G dev server did not respond within the timeout."
    Write-Output "PID: $($process.Id)"
    Write-Output "URL: $openUrl"
    Write-Output "Logs: $logPath"
    Write-Output "Errors: $errPath"
    exit 1
  }

  Write-Output "4lpha 0G dev server is ready."
  Write-Output "PID: $($process.Id)"
  Write-Output "URL: $openUrl"
  Write-Output "Logs: $logPath"
  Write-Output "Errors: $errPath"

  if (-not $NoBrowser) {
    Open-LocalUrl -Url $openUrl
  }
} finally {
  $launchLock.Dispose()
}
