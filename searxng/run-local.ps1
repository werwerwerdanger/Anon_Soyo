# SearXNG local deploy - Windows + Docker Desktop, loopback only.
#
# ASCII ONLY. Windows PowerShell 5.1 reads a .ps1 without a BOM as ANSI, so any
# non-ASCII character here would come out garbled.
#
# What it does:
#   1. checks that the Docker daemon is actually up
#   2. writes .env (random secret + port) and config/settings.yml
#   3. starts the container bound to 127.0.0.1 only
#   4. calls the JSON API and prints how many results each engine returned
#
# Re-running is safe: the secret and the existing settings.yml are kept.
#
# Usage:
#   .\run-local.ps1                 deploy and verify
#   .\run-local.ps1 -StartDocker    start Docker Desktop first, wait until ready
#   .\run-local.ps1 -Port 8888      pick a different port
#   .\run-local.ps1 -ForceSettings  rewrite settings.yml from the template
#   .\run-local.ps1 -Down           stop and remove the container
#   .\run-local.ps1 -Check          only test the prerequisites

param(
    [int]$Port = 8888,
    [switch]$ForceSettings,
    [switch]$Down,
    [switch]$Check,
    [switch]$StartDocker,
    [int]$WaitSeconds = 240
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$Root = $PSScriptRoot
$ConfigDir = Join-Path $Root "config"
$EnvFile = Join-Path $Root ".env"
$ComposeFile = Join-Path $Root "docker-compose.local.yml"
$SettingsTemplate = Join-Path $Root "settings.local.yml"
$SettingsTarget = Join-Path $ConfigDir "settings.yml"

Write-Host ""
Write-Host "============== SearXNG local deploy =============="
Write-Host ("  root      : {0}" -f $Root)
Write-Host ("  port      : {0}" -f $Port)
Write-Host ""

# ------------------------------------------------------------------ helpers
function Fail {
    param([string]$Message)
    Write-Host ""
    Write-Host ("[ERROR] " + $Message)
    Write-Host ""
    try { Read-Host "Press Enter to close" } catch { }
    exit 1
}

# Docker Desktop is usually installed per-user on this machine, not under
# C:\Program Files, so probe several known locations.
function Find-DockerDesktop {
    $candidates = @()
    if ($env:LOCALAPPDATA) {
        $candidates += (Join-Path $env:LOCALAPPDATA "Programs\DockerDesktop\Docker Desktop.exe")
    }
    if ($env:ProgramFiles) {
        $candidates += (Join-Path $env:ProgramFiles "Docker\Docker\Docker Desktop.exe")
    }
    $pf86 = [Environment]::GetEnvironmentVariable("ProgramFiles(x86)")
    if ($pf86) {
        $candidates += (Join-Path $pf86 "Docker\Docker\Docker Desktop.exe")
    }
    foreach ($c in $candidates) {
        if ($c -and (Test-Path $c)) { return $c }
    }
    return ""
}

function Test-DockerDaemon {
    try {
        $null = & docker info 2>&1
        return ($LASTEXITCODE -eq 0)
    } catch {
        return $false
    }
}

# -------------------------------------------------------------- prerequisites
Write-Host "--- step 1: prerequisites ---"

$dockerCmd = Get-Command docker -ErrorAction SilentlyContinue
if (-not $dockerCmd) {
    Fail "docker was not found on PATH. Install Docker Desktop first."
}
Write-Host ("  docker cli : {0}" -f $dockerCmd.Source)

if (-not (Test-Path $ComposeFile)) {
    Fail ("missing {0}" -f $ComposeFile)
}
if (-not (Test-Path $SettingsTemplate)) {
    Fail ("missing {0}" -f $SettingsTemplate)
}

$daemonUp = Test-DockerDaemon

# Optionally bring the engine up ourselves. Docker Desktop is a GUI app, so this
# only works when a human is at the desktop running this script (which is the
# intended way to run it).
if ((-not $daemonUp) -and $StartDocker) {
    $desktop = Find-DockerDesktop
    if (-not $desktop) {
        Fail "could not find 'Docker Desktop.exe'. Start it manually, then re-run."
    }
    Write-Host ("  launching  : {0}" -f $desktop)
    try {
        Start-Process -FilePath $desktop | Out-Null
    } catch {
        Fail ("failed to launch Docker Desktop: " + $_.Exception.Message)
    }

    Write-Host ("  waiting for the engine (up to {0}s), first boot is slow..." -f $WaitSeconds)
    $deadline = (Get-Date).AddSeconds($WaitSeconds)
    $tick = 0
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 3
        $tick += 3
        if (Test-DockerDaemon) { $daemonUp = $true; break }
        if ($tick % 30 -eq 0) {
            Write-Host ("    still starting ({0}s)..." -f $tick)
        }
    }
    if ($daemonUp) {
        Write-Host ("  engine     : up after {0}s" -f $tick)
    } else {
        Fail ("engine did not come up within {0}s. Open Docker Desktop and check its status." -f $WaitSeconds)
    }
}

if (-not $daemonUp) {
    Write-Host "  daemon     : NOT RUNNING"
    Write-Host ""
    Write-Host "================================================================"
    Write-Host "  Docker Desktop is installed but its engine is not started."
    Write-Host ""
    Write-Host "  Easiest fix - let this script start it for you:"
    Write-Host "      .\run-local.ps1 -StartDocker"
    Write-Host ""
    Write-Host "  Or start it yourself from the Start menu (Docker Desktop),"
    Write-Host "  wait until the tray icon stops animating, then re-run this."
    Write-Host "================================================================"
    Write-Host ""
    try { Read-Host "Press Enter to close" } catch { }
    exit 1
}
Write-Host "  daemon     : running"

# --- registry mirror check -------------------------------------------------
# registry-1.docker.io, auth.docker.io and production.cloudflare.docker.com are
# all DNS-poisoned on this network (they resolve to Twitter/Facebook addresses),
# so a plain `docker pull` hangs forever. The pull only works when a Chinese
# mirror is in effect. Verify that here rather than discovering it 10 minutes
# into a stalled layer download.
$infoText = ""
try { $infoText = (& docker info 2>&1 | Out-String) } catch { }
$mirrorHosts = @("docker.m.daocloud.io", "docker.1ms.run", "hub.rat.dev")
$activeMirrors = @()
foreach ($m in $mirrorHosts) {
    if ($infoText -match [regex]::Escape($m)) { $activeMirrors += $m }
}
if ($activeMirrors.Count -gt 0) {
    Write-Host ("  mirrors    : {0}" -f ($activeMirrors -join ", "))
    $env:SEARXNG_IMAGE = "searxng/searxng:latest"
} else {
    # No daemon-level mirror. Do not give up: pull straight from a mirror host
    # by fully qualifying the image name. This works even when Docker Desktop
    # has not re-read daemon.json yet.
    Write-Host "  mirrors    : NONE ACTIVE (daemon.json not in effect yet)"
    Write-Host "  fallback   : pulling via docker.m.daocloud.io directly"
    $env:SEARXNG_IMAGE = "docker.m.daocloud.io/searxng/searxng:latest"
    Write-Host ""
    Write-Host "  Note: this still works, but to make it permanent add the mirrors"
    Write-Host "        to daemon.json and restart Docker Desktop:"
    Write-Host "            ..\mimir-tools\fix_docker_mirror.py --apply"
    Write-Host ""
}
Write-Host ""

# -------------------------------------------------------------------- down
if ($Down) {
    Write-Host "--- stopping ---"
    $env:SEARXNG_PORT = "$Port"
    Push-Location $Root
    $downOut = & docker compose -f $ComposeFile down 2>&1
    Pop-Location
    foreach ($line in $downOut) {
        $text = [string]$line
        if ($text.Trim()) { Write-Host ("    " + $text.Trim()) }
    }
    Write-Host ""
    Write-Host "Container stopped. Files under .\config are untouched."
    Write-Host ""
    try { Read-Host "Press Enter to close" } catch { }
    exit 0
}

if ($Check) {
    Write-Host "--- check only ---"
    Write-Host "  prerequisites look fine. Run without -Check to deploy."
    Write-Host ""
    try { Read-Host "Press Enter to close" } catch { }
    exit 0
}

# ------------------------------------------------------------------ secret
Write-Host "--- step 2: configuration ---"
if (-not (Test-Path $ConfigDir)) {
    New-Item -ItemType Directory -Path $ConfigDir | Out-Null
}

$secret = ""
if (Test-Path $EnvFile) {
    foreach ($line in (Get-Content $EnvFile)) {
        if ($line -match '^SEARXNG_SECRET=(.+)$') { $secret = $Matches[1] }
    }
    Write-Host ("  .env       : reusing existing secret ({0} chars)" -f $secret.Length)
}
if (-not $secret) {
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $bytes = New-Object byte[] 32
    $rng.GetBytes($bytes)
    # PowerShell 5.1 has no -join on an expression, build it in a loop
    $sb = New-Object System.Text.StringBuilder
    foreach ($b in $bytes) { [void]$sb.Append($b.ToString("x2")) }
    $secret = $sb.ToString()
    Set-Content -Path $EnvFile -Value ("SEARXNG_SECRET=" + $secret) -Encoding ASCII
    Add-Content -Path $EnvFile -Value ("SEARXNG_PORT=" + $Port) -Encoding ASCII
    Write-Host ("  .env       : generated new secret ({0} chars)" -f $secret.Length)
}

# ----------------------------------------------------------------- settings
# SearXNG reads settings.yml once, at process start. Rewriting the file while
# the container runs has NO effect, which is a nasty trap: you re-run this
# script with -ForceSettings, everything looks green, and you are still talking
# to the old engine set. So track whether the file's content actually changed
# and force a recreate when it did.
$settingsChanged = $false
if ((Test-Path $SettingsTarget) -and (-not $ForceSettings)) {
    Write-Host "  settings   : keeping existing config\settings.yml"
} else {
    $oldHash = ""
    if (Test-Path $SettingsTarget) {
        $oldHash = (Get-FileHash -Path $SettingsTarget -Algorithm SHA256).Hash
    }
    $template = Get-Content $SettingsTemplate -Raw -Encoding UTF8
    $written = $template.Replace("__SECRET__", $secret)
    # Write WITHOUT a BOM: PS 5.1's -Encoding UTF8 always adds one, and a BOM in
    # a YAML file is unnecessary noise.
    [System.IO.File]::WriteAllText($SettingsTarget, $written, (New-Object System.Text.UTF8Encoding($false)))
    if (Test-Path $SettingsTarget) {
        $newHash = (Get-FileHash -Path $SettingsTarget -Algorithm SHA256).Hash
        if ($oldHash -and $oldHash -ne $newHash) { $settingsChanged = $true }
        elseif (-not $oldHash) { $settingsChanged = $true }
    }
    if ($settingsChanged) {
        Write-Host "  settings   : wrote config\settings.yml (CHANGED)"
    } else {
        Write-Host "  settings   : wrote config\settings.yml (identical to before)"
    }
}

# -------------------------------------------------------------- limiter.toml
# ./config is mounted over /etc/searxng, which SHADOWS the image's own
# /etc/searxng/limiter.toml. Without a replacement SearXNG logs this on boot:
#     WARNING:searx.botdetection.config: missing config file:
#     /etc/searxng/limiter.toml
# Bot detection is off anyway (server.limiter: false), so this is cosmetic --
# but a clean log makes real problems easier to spot.
$LimiterTemplate = Join-Path $Root "limiter.local.toml"
$LimiterTarget = Join-Path $ConfigDir "limiter.toml"
if (Test-Path $LimiterTemplate) {
    $needCopy = $true
    if (Test-Path $LimiterTarget) {
        $h1 = (Get-FileHash -Path $LimiterTemplate -Algorithm SHA256).Hash
        $h2 = (Get-FileHash -Path $LimiterTarget -Algorithm SHA256).Hash
        if ($h1 -eq $h2) { $needCopy = $false }
    }
    if ($needCopy) {
        Copy-Item -Path $LimiterTemplate -Destination $LimiterTarget -Force
        Write-Host "  limiter    : wrote config\limiter.toml"
        $settingsChanged = $true
    } else {
        Write-Host "  limiter    : config\limiter.toml up to date"
    }
}
Write-Host ""

# --------------------------------------------------------------------- run
Write-Host "--- step 3: start container ---"
$env:SEARXNG_PORT = "$Port"
Push-Location $Root
if ($settingsChanged) {
    Write-Host "  configuration under .\config changed -> forcing a container recreate"
    Write-Host "  so SearXNG actually reloads it (it only reads these files at startup)."
    $composeOut = & docker compose -f $ComposeFile up -d --force-recreate 2>&1
} else {
    $composeOut = & docker compose -f $ComposeFile up -d 2>&1
}
$upCode = $LASTEXITCODE
Pop-Location

# docker compose writes its progress ("Container searxng Recreate") to stderr.
# PowerShell 5.1 turns every stderr line into a NativeCommandError block, which
# makes a perfectly successful run look like a crash. Print the text plainly.
foreach ($line in $composeOut) {
    $text = [string]$line
    if ($text.Trim()) { Write-Host ("    " + $text.Trim()) }
}
if ($upCode -ne 0) {
    Write-Host ""
    Write-Host "[ERROR] docker compose failed. Show the logs with:"
    Write-Host ("        docker compose -f `"{0}`" logs --tail 60" -f $ComposeFile)
    Write-Host ""
    try { Read-Host "Press Enter to close" } catch { }
    exit 1
}
Write-Host ""

Write-Host "--- step 4: wait for the web server ---"
$ready = $false
for ($i = 0; $i -lt 30; $i++) {
    try {
        $null = Invoke-WebRequest -Uri ("http://127.0.0.1:{0}/" -f $Port) -UseBasicParsing -TimeoutSec 5
        $ready = $true
        break
    } catch {
        Start-Sleep -Seconds 2
    }
}
if ($ready) {
    Write-Host "  web server : up"
} else {
    Write-Host "  web server : no response after 60s"
    Write-Host ("  check logs : docker compose -f `"{0}`" logs --tail 60" -f $ComposeFile)
}
Write-Host ""

# ----------------------------------------------------------------- verify
Write-Host "--- step 5: JSON API self check ---"
$url = "http://127.0.0.1:{0}/search?q=test&format=json&language=zh-CN" -f $Port
try {
    $resp = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 25
    Write-Host ("  GET /search?format=json  ->  HTTP {0}" -f $resp.StatusCode)
    $payload = $resp.Content | ConvertFrom-Json
    $results = @($payload.results)
    Write-Host ("  results                  ->  {0}" -f $results.Count)

    $byEngine = @{}
    foreach ($r in $results) {
        $name = [string]$r.engine
        if (-not $name) { $name = "?" }
        if ($byEngine.ContainsKey($name)) {
            $byEngine[$name] = $byEngine[$name] + 1
        } else {
            $byEngine[$name] = 1
        }
    }
    if ($byEngine.Count -gt 0) {
        $parts = @()
        foreach ($k in ($byEngine.Keys | Sort-Object)) { $parts += ("{0}={1}" -f $k, $byEngine[$k]) }
        Write-Host ("  by engine                ->  {0}" -f ($parts -join ", "))
    }

    # Which engines REFUSED to answer. SearXNG reports this as a list of
    # [engine, reason] pairs; the reason is the whole diagnosis
    # (e.g. "CAPTCHA", "Suspended: CAPTCHA", "unexpected crash", "timeout").
    $unresp = $payload.unresponsive_engines
    if ($unresp -and @($unresp).Count -gt 0) {
        $u = @()
        foreach ($item in @($unresp)) {
            $name = [string]$item[0]
            $why = [string]$item[1]
            $u += ("{0}: {1}" -f $name, $why)
        }
        Write-Host ("  unresponsive             ->  {0}" -f ($u -join "; "))
    }

    foreach ($r in ($results | Select-Object -First 3)) {
        $t = [string]$r.title
        if ($t.Length -gt 58) { $t = $t.Substring(0, 58) }
        Write-Host ("    - [{0}] {1}" -f $r.engine, $t)
    }

    if ($results.Count -eq 0) {
        Write-Host ""
        Write-Host "  [WARN] 0 results."
        Write-Host ""
        Write-Host "  Read the 'unresponsive' line above first - it distinguishes the"
        Write-Host "  three very different causes:"
        Write-Host "    (nothing listed)  -> no engine was SELECTED."
        Write-Host "                         keep_only only keeps engines; it does not"
        Write-Host "                         enable them. Check the 'engines:' block."
        Write-Host "    CAPTCHA           -> that engine is blocking this network."
        Write-Host "    unexpected crash  -> a bug in the engine module itself."
        Write-Host "    timeout           -> the engine is slow or unreachable."
        Write-Host ""
        Write-Host "  Diagnose per engine with:"
        Write-Host "      ..\mimir-tools\probe_searxng_engines.py"
    }
} catch {
    Write-Host ("  [ERROR] request failed: {0}" -f $_.Exception.Message)
    Write-Host "          HTTP 403 means the json format is missing from settings.yml."
    Write-Host ("  check logs : docker compose -f `"{0}`" logs --tail 60" -f $ComposeFile)
}
Write-Host ""

Write-Host "==================== done ===================="
Write-Host ("  searxng url : http://127.0.0.1:{0}" -f $Port)
Write-Host "  stop it     : .\run-local.ps1 -Down"
Write-Host ("  logs        : docker compose -f `"{0}`" logs -f" -f $ComposeFile)
Write-Host ""
Write-Host "  Point MimirLink at it:"
Write-Host "    ai.tools.webSearch.searxngBaseUrl = ""http://127.0.0.1:$Port"""
Write-Host "    ai.tools.webSearch.provider       = ""searxng"""
Write-Host "  Or keep Bocha as the main provider and add SearXNG as a fallback:"
Write-Host "    ai.tools.webSearch.provider           = ""bocha"""
Write-Host "    ai.tools.webSearch.fallbackProviders  = [""searxng""]"
Write-Host "=============================================="
Write-Host ""
try { Read-Host "Press Enter to close" } catch { }
