# Add a SECOND NapCat account - config files only, no QQ login happens here.
#
# NapCat keeps its configuration per account, keyed by the QQ number:
#
#   config\napcat_<QQ>.json            account / behaviour settings
#   config\napcat_protocol_<QQ>.json   protocol-side network settings
#   config\onebot11_<QQ>.json          OneBot 11 network settings  <-- the one that matters
#
# This clones those three from an existing account and rewrites the OneBot
# websocket port, so a second QQ account can drive a second MimirLink instance.
#
# Why a separate account instead of reusing the first one: two NapCat instances
# logged into the SAME QQ number kick each other offline, and every extra launch
# is another real login request that can trip QQ risk control. Different
# accounts are fine.
#
# ASCII ONLY. Windows PowerShell 5.1 reads a .ps1 without a BOM as ANSI, so any
# non-ASCII character would come out garbled.
#
# Usage:
#   .\add-napcat-account.ps1 -QQ 123456789
#   .\add-napcat-account.ps1 -QQ 123456789 -Port 4242
#   .\add-napcat-account.ps1 -QQ 123456789 -Force        overwrite existing files
#   .\add-napcat-account.ps1 -QQ 123456789 -Token abc    force a specific token
#
# Then start it with:
#   .\launch-napcat.ps1 -QQ 123456789

param(
    [Parameter(Mandatory = $true)][string]$QQ,
    [int]$Port = 4242,
    [string]$Token = '',
    [string]$Template = '2458713318',
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

$napcatDir = $PSScriptRoot
$configDir = Join-Path $napcatDir 'config'

Write-Host "========================================"
Write-Host "  Add NapCat account"
Write-Host "  new QQ   : $QQ"
Write-Host "  OneBot WS: 127.0.0.1:$Port"
Write-Host "  template : $Template"
Write-Host "========================================"
Write-Host ""

# ---- 1. validate the account number ----------------------------------------
if ($QQ -notmatch '^\d{5,12}$') {
    Write-Host "[ERROR] -QQ must be 5-12 digits, got '$QQ'."
    exit 1
}
if ($QQ -eq $Template) {
    Write-Host "[ERROR] $QQ is the template account itself, nothing to add."
    exit 1
}

$tplOnebot = Join-Path $configDir "onebot11_$Template.json"
if (-not (Test-Path $tplOnebot)) {
    Write-Host "[ERROR] Template config not found: $tplOnebot"
    exit 1
}

$targetOnebot = Join-Path $configDir "onebot11_$QQ.json"
if ((Test-Path $targetOnebot) -and -not $Force) {
    Write-Host "[BLOCKED] $targetOnebot already exists."
    Write-Host "          Re-run with -Force to overwrite it."
    exit 1
}

# ---- 2. make sure the port is not already taken ----------------------------
$conflicts = @()
Get-ChildItem $configDir -Filter 'onebot11_*.json' -ErrorAction SilentlyContinue | ForEach-Object {
    if ($_.Name -eq "onebot11_$QQ.json") { return }
    try {
        $cfg = Get-Content $_.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
        foreach ($srv in @($cfg.network.websocketServers)) {
            if ($srv -and $srv.port -eq $Port) {
                $conflicts += "$($_.Name) [name=$($srv.name)]"
            }
        }
    } catch {
        # an unreadable config should not block us, just mention it
        Write-Host "[WARN] Could not parse $($_.Name), skipped the port check for it."
    }
}
if ($conflicts.Count -gt 0) {
    Write-Host "[BLOCKED] Port $Port is already claimed by: $($conflicts -join ', ')"
    Write-Host "          Choose another -Port value, they must not collide."
    exit 1
}

# ---- 3. clone the account-level configs (plain copies) ---------------------
foreach ($prefix in @('napcat', 'napcat_protocol')) {
    $from = Join-Path $configDir "${prefix}_$Template.json"
    $to = Join-Path $configDir "${prefix}_$QQ.json"
    if ((Test-Path $from) -and (-not (Test-Path $to) -or $Force)) {
        Copy-Item $from $to -Force
        Write-Host "[OK] ${prefix}_$QQ.json  <- copied"
    } else {
        Write-Host "[--] ${prefix}_$QQ.json  (kept as-is)"
    }
}

# ---- 4. rewrite the OneBot config -------------------------------------------
# Text replacement rather than ConvertTo-Json: PowerShell 5.1 serialises a
# single-element array as a bare object, which would quietly corrupt
# websocketServers. The template only ever holds one server entry, so a
# count-limited regex replace is both simpler and safer.
$text = Get-Content $tplOnebot -Raw -Encoding UTF8

$rxName = [regex]'("name"\s*:\s*")[^"]*(")'
$text = $rxName.Replace($text, ('${1}ws-soyo-' + $Port + '${2}'), 1)

$rxPort = [regex]'("port"\s*:\s*)\d+'
$text = $rxPort.Replace($text, ('${1}' + $Port), 1)

$effectiveToken = $Token
if (-not $effectiveToken) {
    # NOTE: write it as a variable first. '[regex]'x'.Match(...)' looks fine but
    # PowerShell parses it as [regex]('x'.Match(...)) -- it calls .Match on the
    # STRING and then tries to cast the result. That fails at runtime with
    # "[System.String] does not contain a method named Match".
    $rxTokenRead = [regex]'("token"\s*:\s*")([^"]*)(")'
    $mTok = $rxTokenRead.Match($text)
    if ($mTok.Success) { $effectiveToken = $mTok.Groups[2].Value }
}

if ($Token) {
    $rxToken = [regex]'("token"\s*:\s*")[^"]*(")'
    $text = $rxToken.Replace($text, ('${1}' + $Token + '${2}'), 1)
}

[System.IO.File]::WriteAllText($targetOnebot, $text, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "[OK] onebot11_$QQ.json  <- port $Port"

# ---- 5. verify what we just wrote ------------------------------------------
$verify = Get-Content $targetOnebot -Raw -Encoding UTF8 | ConvertFrom-Json
$srv = @($verify.network.websocketServers)[0]
Write-Host ""
Write-Host "---- verification ----------------------------------------"
Write-Host ("  file    : onebot11_$QQ.json")
Write-Host ("  name    : {0}" -f $srv.name)
Write-Host ("  host    : {0}:{1}" -f $srv.host, $srv.port)
Write-Host ("  enable  : {0}" -f $srv.enable)
Write-Host ("  token   : {0} chars" -f ([string]$srv.token).Length)
Write-Host ""

# ---- 6. tell the user what to do next --------------------------------------
Write-Host "========================================"
Write-Host "  Next steps"
Write-Host "========================================"
Write-Host "1. Make sure the MimirLink instance that talks to this account has"
Write-Host "   the SAME token, and points at the same port:"
Write-Host ("     onebot.url          = ws://127.0.0.1:{0}" -f $Port)
Write-Host ("     onebot.accessToken  = {0} chars, must match" -f $effectiveToken.Length)
Write-Host ""
Write-Host "2. Log the account in (a QR code will appear, scan it once):"
Write-Host ("     .\launch-napcat.ps1 -QQ {0}" -f $QQ)
Write-Host ""
Write-Host "3. Then start the matching MimirLink instance."
Write-Host ""
