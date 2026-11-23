# NapCat Launcher - one account per invocation.
#
# The account is chosen with -QQ, and the OneBot endpoint printed below is read
# from that account's own config\onebot11_<QQ>.json. So this one script serves
# any number of accounts (Anon on 2424, Soyo on 4242, ...).
#
# Before first use of a new account, create its config files with:
#   .\add-napcat-account.ps1 -QQ <number>
#
# NOTE: keep this file ASCII-only. Windows PowerShell 5.1 reads non-BOM
# .ps1 files as ANSI, so non-ASCII chars here would come out garbled.
#
# Usage:
#   .\launch-napcat.ps1             -> quick-login as 2458713318 (no QR)
#   .\launch-napcat.ps1 -QQ ""      -> force QR-code login
#   .\launch-napcat.ps1 -QQ 123456  -> quick-login as another saved account
#   .\launch-napcat.ps1 -QQ 123456 -WebUiPort 6100
#                                   -> use a per-instance WebUI port, needed
#                                      when another NapCat already owns 6099
param([string]$QQ = "2458713318", [switch]$Force, [int]$WebUiPort = 0)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$napcatDir = "C:\Users\20633\NapCat"
$qqPath = "C:\Program Files\Tencent\QQNT\QQ.exe"

$env:NAPCAT_PATCH_PACKAGE = "$napcatDir\qqnt.json"
$env:NAPCAT_LOAD_PATH = "$napcatDir\loadNapCat.js"
$env:NAPCAT_INJECT_PATH = "$napcatDir\NapCatWinBootHook.dll"
$env:NAPCAT_LAUNCHER_PATH = "$napcatDir\NapCatWinBootMain.exe"
$env:NAPCAT_MAIN_PATH = "$napcatDir\napcat.mjs"

# The NapCat WebUI port lives in ONE global file (config\webui.json, port 6099),
# so a second instance started for another account would fight the first one for
# that same port. napcat.mjs reads NAPCAT_WEBUI_PREFERRED_PORT and forwards it to
# its worker, so -WebUiPort gives this instance its own WebUI port.
# Leave -WebUiPort at 0 to keep whatever config\webui.json says.
$webUiShown = "6099 (default from config\webui.json)"
if ($WebUiPort -gt 0) {
    $env:NAPCAT_WEBUI_PREFERRED_PORT = "$WebUiPort"
    $webUiShown = "$WebUiPort (-WebUiPort override)"
}

# Show which OneBot endpoint this account actually serves. Hard-coding the port
# here used to print "2424" for every account, which sends you hunting for a
# connection problem that does not exist.
$wsInfo = "QR-code login mode - the account is not known until you scan"
$onebotCfg = ""
if ($QQ) {
    $wsInfo = "no config\onebot11_$QQ.json yet - run: .\add-napcat-account.ps1 -QQ $QQ"
    $onebotCfg = Join-Path $napcatDir "config\onebot11_$QQ.json"
}
if ($onebotCfg -and (Test-Path $onebotCfg)) {
    try {
        $cfgObj = Get-Content $onebotCfg -Raw -Encoding UTF8 | ConvertFrom-Json
        $eps = @()
        foreach ($srv in @($cfgObj.network.websocketServers)) {
            if ($srv -and $srv.enable) {
                $eps += ("{0}:{1}" -f $srv.host, $srv.port)
            }
        }
        if ($eps.Count -gt 0) {
            $wsInfo = ($eps -join ', ')
        } else {
            $wsInfo = "config found, but no ENABLED websocket server"
        }
    } catch {
        $wsInfo = "config found, but it could not be parsed"
    }
}

Write-Host "========================================"
Write-Host ("NapCat account : {0}" -f $QQ)
Write-Host ("OneBot WS      : {0}" -f $wsInfo)
Write-Host ("WebUI port     : {0}" -f $webUiShown)
Write-Host "========================================"
Write-Host ""

$files = @($qqPath, $env:NAPCAT_LAUNCHER_PATH, $env:NAPCAT_INJECT_PATH, $env:NAPCAT_MAIN_PATH)
foreach ($f in $files) {
    if (-not (Test-Path $f)) {
        Write-Host "[ERROR] Missing file: $f"
        Read-Host "Press Enter to exit"
        exit 1
    }
}

$mainPath = $env:NAPCAT_MAIN_PATH -replace '\\', '/'
"(async () => {await import(""file:///$mainPath"")})()" | Out-File -FilePath $env:NAPCAT_LOAD_PATH -Encoding ascii -NoNewline
Write-Host "[OK] loadNapCat.js -> $mainPath"
Write-Host ""

# NOTE: pass args bare. Escaped quotes (`"..`") become literal quote chars
# inside argv and the launcher then dies with Error Code 87.
# Quick-login: pass the QQ NUMBER BARELY (the launcher turns it into
# "--enable-logging -q <number>" itself). Passing "-q <n>" does NOT work.
# ---- guard: never run the same account twice ------------------------------
# Two headless QQ processes on the SAME account kick each other offline, and
# every extra launch is another real login request that can trip QQ's risk
# control (Login Error, ErrType: 1 / ErrCode: 1). Different accounts are fine.
if ($QQ -and -not $Force) {
    if ($QQ -notmatch '^\d{5,12}$') {
        Write-Host "[WARN] QQ value '$QQ' is not a plain number - duplicate check skipped."
    }
    else {
        $pattern = "(^|\D)$QQ(\D|$)"
        $running = @(
            Get-CimInstance Win32_Process -Filter "Name = 'QQ.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -and ([string]$_.CommandLine) -match $pattern }
        )
        if ($running.Count -gt 0) {
            Write-Host ""
            Write-Host "================================================================"
            Write-Host ("[BLOCKED] Account {0} already has {1} QQ.exe instance(s) running." -f $QQ, $running.Count)
            foreach ($p in $running) { Write-Host ("          pid={0}" -f $p.ProcessId) }
            Write-Host ""
            Write-Host "Two instances on the same account kick each other offline, and every"
            Write-Host "extra launch is a real login request that can trip QQ risk control."
            Write-Host ""
            Write-Host "  - to just look   : close that NapCat window instead"
            Write-Host "  - to force start : re-run with  -Force"
            Write-Host "================================================================"
            Read-Host "Press Enter to close"
            exit 1
        }
    }
}

# ---- working directory ----------------------------------------------------
# QQ/NapCat drop their cache (guild1.db and friends) into the CURRENT DIRECTORY.
# This script is reached from the desktop start-*.cmd, whose cwd is the Desktop,
# so that cache used to land on the user desktop and keep growing there.
# Pin the cwd to the NapCat folder so stray files stay inside the install dir.
Set-Location $napcatDir

if ($QQ) {
    Write-Host "Quick-login as $QQ (no QR scan needed)..."
    Write-Host ""
    & $env:NAPCAT_LAUNCHER_PATH $qqPath $env:NAPCAT_INJECT_PATH $QQ
} else {
    Write-Host "QR-code login mode - scan the QR shown below."
    Write-Host ""
    & $env:NAPCAT_LAUNCHER_PATH $qqPath $env:NAPCAT_INJECT_PATH
}

Write-Host ""
Write-Host "NapCat exited."
Read-Host "Press Enter to close this window"
