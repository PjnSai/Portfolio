# Shared by dev.ps1 and dev-web.ps1 (local development mode, docs/LOCAL-DEV.md).
# Works in Windows PowerShell 5.1 and PowerShell 7.

$Repo = Split-Path -Parent $PSScriptRoot
$ApiDir = Join-Path $Repo "api"
$WebDir = Join-Path $Repo "web"
$RunDir = Join-Path $ApiDir ".devmode\run"
$ApiHealth = "http://127.0.0.1:8000/healthz"
$WebUrl = "http://localhost:3000/"

function Initialize-RunDir {
    if (-not (Test-Path $RunDir)) { New-Item -ItemType Directory -Force $RunDir | Out-Null }
}

# Sets environment variables for this process while the block runs, then puts
# the old values back, so the caller's window is left as it was.
function Invoke-WithEnv([hashtable]$Values, [scriptblock]$Block) {
    $saved = @{}
    foreach ($name in $Values.Keys) {
        $saved[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
        [Environment]::SetEnvironmentVariable($name, $Values[$name], "Process")
    }
    try { & $Block }
    finally {
        foreach ($name in $saved.Keys) {
            [Environment]::SetEnvironmentVariable($name, $saved[$name], "Process")
        }
    }
}

function Test-Url([string]$Url) {
    try {
        $answer = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 3
        return $answer.StatusCode -eq 200
    } catch { return $false }
}

# Waits until the address answers 200, the process stops, or time runs out.
function Wait-Url([string]$Url, [int]$Seconds, $Process) {
    $until = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $until) {
        if (Test-Url $Url) { return $true }
        if ($Process -and $Process.HasExited) { return $false }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

function Get-PortOwner([int]$Port) {
    try {
        $found = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop |
            Select-Object -First 1
    } catch { return $null }
    if (-not $found) { return $null }
    $process = Get-Process -Id $found.OwningProcess -ErrorAction SilentlyContinue
    if ($process) { return "$($process.ProcessName) (process $($process.Id))" }
    return "process $($found.OwningProcess)"
}

# The process recorded in a .pid file, if it is still running and is the
# kind expected (a stale file can name a process that has since been reused).
function Get-Recorded([string]$PidFile, [string]$Name) {
    if (-not (Test-Path $PidFile)) { return $null }
    $id = (Get-Content $PidFile -TotalCount 1).Trim()
    $process = Get-Process -Id $id -ErrorAction SilentlyContinue
    if ($process -and $process.ProcessName -eq $Name) { return $process }
    return $null
}

function Stop-Recorded([string]$PidFile, [string]$Name, [string]$What) {
    $process = Get-Recorded $PidFile $Name
    if ($process) {
        Write-Host "Stopping $What (process $($process.Id) and its children)."
        cmd /c "taskkill /PID $($process.Id) /T /F >nul 2>&1"
    } else {
        Write-Host "$What is not running (nothing recorded in $PidFile)."
    }
    if (Test-Path $PidFile) { Remove-Item $PidFile -Force }
}

# Starts a command in a hidden window with its output in a log file. It goes
# through cmd so the new process shares no handles with this window, and the
# recorded process is cmd: stopping it with its children stops the command.
function Start-Background([string]$Directory, [string]$Command, [string]$Log) {
    $line = "/s /c `"$Command > `"$Log`" 2>&1`""
    return Start-Process -FilePath "cmd.exe" -ArgumentList $line -WorkingDirectory $Directory `
        -WindowStyle Hidden -PassThru
}

function Show-LogTail([string]$Path, [int]$Lines = 15) {
    if (Test-Path $Path) {
        Write-Host "Last lines of ${Path}:"
        Get-Content $Path -Tail $Lines | ForEach-Object { Write-Host "  $_" }
    }
}
