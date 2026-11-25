<#
Local development mode: the whole site on this computer (docs/LOCAL-DEV.md).

  .\scripts\dev.ps1 start      containers, dev API, site build and site server
  .\scripts\dev.ps1 start -NoBuild   the same, serving the last build
  .\scripts\dev.ps1 stop       stop the site server and the dev API
  .\scripts\dev.ps1 status     what is running
  .\scripts\dev.ps1 refresh    rebuild the site after Publish
  .\scripts\dev.ps1 reset      put the SAMPLE content back (passkeys kept)
  .\scripts\dev.ps1 reset -Everything   delete the dev database and files

Reads no .env file. The containers are the ones the tests use.
#>
param(
    [Parameter(Position = 0)]
    [ValidateSet("start", "stop", "status", "refresh", "reset")]
    [string]$Action = "status",
    [switch]$NoBuild,
    [switch]$Everything,
    [switch]$Yes
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "dev-common.ps1")

$Python = Join-Path $ApiDir ".venv\Scripts\python.exe"
$ApiPid = Join-Path $RunDir "api.pid"
$ApiLog = Join-Path $RunDir "api.log"
$BootstrapFile = Join-Path $ApiDir ".devmode\bootstrap-token"
$WebScript = Join-Path $PSScriptRoot "dev-web.ps1"
$Containers = @(
    @{ Name = "portfolio-test-db"; Port = 55432; Create = "docker run -d --name portfolio-test-db -e POSTGRES_PASSWORD=postgres -p 127.0.0.1:55432:5432 postgres:17-alpine" },
    @{ Name = "portfolio-test-redis"; Port = 6379; Create = "docker run -d --name portfolio-test-redis -p 127.0.0.1:6379:6379 redis:7-alpine" }
)

function Test-Docker {
    cmd /c "docker info >nul 2>&1"
    return $LASTEXITCODE -eq 0
}

function Get-ContainerState([string]$Name) {
    $state = cmd /c "docker inspect -f {{.State.Running}} $Name 2>nul"
    if ($LASTEXITCODE -ne 0) { return "missing" }
    if ("$state".Trim() -eq "true") { return "running" }
    return "stopped"
}

function Start-Containers {
    Write-Host "Reading: Docker (docker info) and the containers portfolio-test-db and portfolio-test-redis."
    if (-not (Test-Docker)) {
        throw "Docker is not running. Start Docker Desktop, wait until it says it is running, then try again."
    }
    foreach ($container in $Containers) {
        $state = Get-ContainerState $container.Name
        if ($state -eq "missing") {
            throw ("The container $($container.Name) does not exist. Create it once with:`n  " +
                $container.Create + "`nthen run .\scripts\dev.ps1 start again.")
        }
        if ($state -eq "stopped") {
            Write-Host "Starting the container $($container.Name) (docker start)."
            cmd /c "docker start $($container.Name) >nul"
            if ($LASTEXITCODE -ne 0) { throw "docker start $($container.Name) failed." }
        } else {
            Write-Host "The container $($container.Name) is running (port $($container.Port))."
        }
    }
    Write-Host "Waiting for Postgres in portfolio-test-db to accept connections."
    $until = (Get-Date).AddSeconds(30)
    do {
        cmd /c "docker exec portfolio-test-db pg_isready -U postgres >nul 2>&1"
        if ($LASTEXITCODE -eq 0) { return }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $until)
    throw "Postgres in portfolio-test-db did not become ready."
}

function Assert-Python {
    if (-not (Test-Path $Python)) {
        throw "The API's virtual environment is missing ($Python). See docs\LOCAL-DEV.md, first-time setup."
    }
}

function Invoke-Launcher([string[]]$Arguments) {
    Push-Location $ApiDir
    try { & $Python -m devmode @Arguments } finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) { throw "python -m devmode $($Arguments -join ' ') stopped with an error (see above)." }
}

function Start-Api {
    if (Get-Recorded $ApiPid "cmd") {
        Write-Host "The dev API is already running on $ApiHealth"
        return
    }
    $owner = Get-PortOwner 8000
    if ($owner) { throw "Port 8000 is already in use by $owner. Stop it, then try again." }
    Initialize-RunDir
    Write-Host "Starting the dev API on http://127.0.0.1:8000 (python -m devmode serve). Log: $ApiLog"
    $process = Start-Background $ApiDir "`"$Python`" -m devmode serve" $ApiLog
    Set-Content -Path $ApiPid -Value $process.Id -Encoding ascii
    if (-not (Wait-Url $ApiHealth 90 $process)) {
        Show-LogTail $ApiLog
        Stop-Recorded $ApiPid "cmd" "The dev API"
        throw "The dev API did not start (see above)."
    }
    Write-Host "The dev API is up."
}

function Stop-Api { Stop-Recorded $ApiPid "cmd" "The dev API" }

function Show-Start {
    $token = ""
    if (Test-Path $BootstrapFile) { $token = (Get-Content $BootstrapFile -TotalCount 1).Trim() }
    Write-Host ""
    Write-Host "Local mode is running. Nothing here reaches the live site."
    Write-Host "  Public site:  http://localhost:3000"
    Write-Host "  Admin:        http://localhost:3000/desk"
    Write-Host "  API:          http://127.0.0.1:8000"
    Write-Host "  Logs:         $RunDir"
    Write-Host ""
    Write-Host "First time only (no local passkey yet):"
    Write-Host "  1. Open http://localhost:3000/desk/setup in Edge or Chrome."
    Write-Host "  2. Paste this set-up token: $token"
    Write-Host "  3. Choose Create passkey and use Windows Hello."
    Write-Host "  4. Store the recovery key it shows, tick the box, then sign in."
    Write-Host "After that, sign in at http://localhost:3000/desk with the passkey."
    Write-Host "After Publish in the admin, run .\scripts\dev.ps1 refresh to rebuild the public site."
}

function Show-Status {
    Write-Host "Reading: Docker, the two containers, $ApiHealth and $WebUrl"
    if (-not (Test-Docker)) {
        Write-Host "  Docker:        not running (start Docker Desktop)"
    } else {
        Write-Host "  Docker:        running"
        foreach ($container in $Containers) {
            Write-Host ("  {0,-22} {1}" -f "$($container.Name):", (Get-ContainerState $container.Name))
        }
    }
    $api = "not answering"
    if (Test-Url $ApiHealth) { $api = "running" }
    $web = "not answering"
    if (Test-Url $WebUrl) { $web = "running" }
    Write-Host "  Dev API:       $api (http://127.0.0.1:8000)"
    Write-Host "  Site server:   $web (http://localhost:3000)"
}

function Confirm-Reset {
    if ($Yes) { return $true }
    $answer = Read-Host "Type yes to go ahead"
    return $answer -eq "yes"
}

switch ($Action) {
    "start" {
        Start-Containers
        Assert-Python
        Write-Host "Creating the dev database portfolio_dev with SAMPLE content, only if it does not exist yet."
        Invoke-Launcher @("seed", "--if-new")
        Start-Api
        if ($NoBuild) { & $WebScript serve } else { & $WebScript refresh }
        Show-Start
    }
    "stop" {
        & $WebScript stop
        Stop-Api
        Write-Host "The containers are left running (they are shared with the tests)."
    }
    "status" { Show-Status }
    "refresh" { & $WebScript refresh }
    "reset" {
        Assert-Python
        if ($Everything) {
            Write-Host "This stops local mode and deletes the database portfolio_dev, the local media and CV files"
            Write-Host "and the set-up token. Your local passkey stops working: you make a new one after the next start"
            Write-Host "(and can remove the old one from Windows Hello). The live site is not touched."
        } else {
            Write-Host "This replaces the content, CV versions, messages, contacts, blocklist, counts and alerts in"
            Write-Host "portfolio_dev with the SAMPLE content. Passkeys, sessions and the audit log are kept."
            Write-Host "The live site is not touched."
        }
        if (-not (Confirm-Reset)) {
            Write-Host "Nothing changed."
            return
        }
        if ($Everything) {
            & $WebScript stop
            Stop-Api
            Invoke-Launcher @("drop")
            Write-Host "Run .\scripts\dev.ps1 start to begin again."
        } else {
            Invoke-Launcher @("seed", "--reset")
            if (Test-Url $ApiHealth) { & $WebScript refresh }
            else { Write-Host "The dev API is not running: the site is rebuilt at the next start." }
        }
    }
}
