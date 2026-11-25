<#
Public site in local development mode (docs/LOCAL-DEV.md). The site is a
static export: it reads the published content once, at build time, from the
dev API. A change published in the admin shows only after a new build.

  .\scripts\dev-web.ps1 build     build web\out from the dev API
  .\scripts\dev-web.ps1 serve     serve web\out on http://localhost:3000
  .\scripts\dev-web.ps1 stop      stop that server
  .\scripts\dev-web.ps1 refresh   build, then restart the server (after Publish)
#>
param(
    [Parameter(Position = 0)]
    [ValidateSet("build", "serve", "stop", "refresh")]
    [string]$Action = "refresh"
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "dev-common.ps1")

$PidFile = Join-Path $RunDir "web.pid"
$BuildLog = Join-Path $RunDir "web-build.log"
$ServeLog = Join-Path $RunDir "web.log"

# What the build sees. CF_PAGES would make it a Cloudflare Pages build, which
# needs production values, so it is cleared. The Turnstile key is Cloudflare's
# test site key, which always passes.
$BuildEnv = @{
    API_BASE_URL = "http://localhost:8000"
    SITE_ORIGIN = "http://localhost:3000"
    TURNSTILE_SITE_KEY = "1x00000000000000000000AA"
    NEXT_PUBLIC_PRIVACY_EMAIL = $null
    SKIP_SITE_FETCH = $null
    CF_PAGES = $null
}
$ServeEnv = @{
    PORT = "3000"
    HOSTNAME = "localhost"
    STATIC_ROOT = $null
}

function Invoke-SiteBuild {
    Write-Host "Reading the published content from the dev API ($ApiHealth)."
    if (-not (Test-Url $ApiHealth)) {
        throw "The dev API is not answering. Start it first: .\scripts\dev.ps1 start"
    }
    Initialize-RunDir
    Write-Host "Building the site into web\out (replaces the last build; a minute or two). Log: $BuildLog"
    Push-Location $WebDir
    try {
        Invoke-WithEnv $BuildEnv { cmd /c "npm run build > `"$BuildLog`" 2>&1" }
        if ($LASTEXITCODE -ne 0) {
            Show-LogTail $BuildLog 25
            throw "The site build failed (see above)."
        }
    } finally { Pop-Location }
    Write-Host "Site built."
}

function Start-Site {
    if (Get-Recorded $PidFile "cmd") {
        Write-Host "The site server is already running on $WebUrl"
        return
    }
    if (-not (Test-Path (Join-Path $WebDir "out\_headers"))) {
        throw "There is no build yet. Run: .\scripts\dev-web.ps1 build"
    }
    $owner = Get-PortOwner 3000
    if ($owner) { throw "Port 3000 is already in use by $owner. Stop it, then try again." }
    Initialize-RunDir
    Write-Host "Starting the site server on $WebUrl (serves web\out with its _headers). Log: $ServeLog"
    $process = Invoke-WithEnv $ServeEnv {
        Start-Background $WebDir "node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/serve-static.ts" $ServeLog
    }
    Set-Content -Path $PidFile -Value $process.Id -Encoding ascii
    if (-not (Wait-Url $WebUrl 30 $process)) {
        Show-LogTail $ServeLog
        throw "The site server did not start."
    }
    Write-Host "The site is up on $WebUrl"
}

function Stop-Site { Stop-Recorded $PidFile "cmd" "The site server" }

switch ($Action) {
    "build" { Invoke-SiteBuild }
    "serve" { Start-Site }
    "stop" { Stop-Site }
    "refresh" {
        Invoke-SiteBuild
        Stop-Site
        Start-Site
    }
}
