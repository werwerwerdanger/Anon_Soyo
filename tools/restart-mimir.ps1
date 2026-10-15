# MimirLink one-click restart (both instances)
# Usage:  & "C:\Users\20633\WorkBuddy\2026-05-28-17-36-40\mimir-tools\restart-mimir.ps1"
#
# Notes:
#   * NapCat / QQ are GUI apps and are NOT touched here - start them by hand.
#   * Logs: <instance>\logs\mimirlink-<date>.log   (the app writes these itself)
#   * Health: search "onebot=connected" in <instance>\logs\
#
# Launch method: Win32_Process.Create (WMI), NOT Start-Process.
#   Why not plain `Start-Process`: Start-Process children belong to the caller's
#   session/job. When the caller is a transient shell (e.g. a one-off tool call),
#   the children are killed the moment that shell exits. The script still printed
#   "LISTENING" because it checked 18s later, so it looked like a success.
#   WMI Create produces a truly detached process that survives its parent.
#   Side effect: WMI gives the console app its OWN console window. That is WANTED
#   here (the user watches it). Pass -Hidden for a silent launch (VBS shim +
#   SW_HIDE) -- note -Hidden also means no live console output at all.
#   Trade-off: WMI cannot redirect stdout/stderr, so no _boot_out.log. The app
#   logs everything it needs to logs\ itself, and syntax is pre-checked below.

# -Instance: both (default) | anon | soyo   -- restart only one side.
# -Hidden: run with NO console window (VBS shim + SW_HIDE). Default is VISIBLE --
#          the user explicitly wants to watch the node console (2026-10-14).
param(
    [ValidateSet('both','anon','soyo')][string]$Instance = 'both',
    [switch]$Hidden
)

$ErrorActionPreference = 'Continue'

$Node  = 'C:\Program Files\nodejs\node.exe'
$AllDirs  = @('C:\Users\20633\MimirLink-soyo', 'C:\Users\20633\MimirLink')
$AllPorts = @(8002, 8001)
switch ($Instance) {
    'anon'  { $Dirs = @('C:\Users\20633\MimirLink');      $Ports = @(8001) }
    'soyo'  { $Dirs = @('C:\Users\20633\MimirLink-soyo'); $Ports = @(8002) }
    default { $Dirs = $AllDirs; $Ports = $AllPorts }
}

# PowerShell 5.1 compares env names case-insensitively. If both HTTP_PROXY and
# http_proxy exist, process creation throws a dictionary error. Drop the
# lowercase duplicates in this session only.
foreach ($n in @('http_proxy', 'https_proxy', 'all_proxy', 'no_proxy')) {
    if (Test-Path "Env:$n") { Remove-Item "Env:$n" -ErrorAction SilentlyContinue }
}

if (-not (Test-Path $Node)) { $Node = 'node' }

Write-Host '=== preflight: node --check ==='
foreach ($d in $Dirs) {
    $entry = Join-Path $d 'src\index.js'
    if (-not (Test-Path $entry)) { Write-Host ("  [SKIP] no src\index.js under {0}" -f $d); continue }
    $null = & $Node --check $entry 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Host ("  OK   {0}" -f $d)
    } else {
        Write-Host ("  FAIL {0}  <-- fix syntax before restarting" -f $d)
    }
}

Write-Host '=== stop ==='
foreach ($port in $Ports) {
    $conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if (-not $conns) {
        Write-Host ("  port {0}: nothing listening" -f $port)
        continue
    }
    foreach ($c in $conns) {
        Write-Host ("  port {0}: stopping pid {1}" -f $port, $c.OwningProcess)
        Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
    }
}
Start-Sleep -Seconds 3

if ($Hidden) {
    Write-Host '=== start (detached, console HIDDEN) ==='
} else {
    Write-Host '=== start (detached, visible node console) ==='
}
foreach ($d in $Dirs) {
    if (-not (Test-Path (Join-Path $d 'src\index.js'))) { continue }
    if (-not $Hidden) {
        # DEFAULT: WMI-create node.exe directly. The user WANTS this window visible --
        # it is how they can tell the bot is up and read what it prints live.
        # NOTE: Win32_Process.Create gives a console app its OWN new console window.
        $cmd = '"{0}" src/index.js' -f $Node
        $r = ([wmiclass]'Win32_Process').Create($cmd, $d)
        if ($r.ReturnValue -eq 0) {
            Write-Host ("  started(visible): {0}  (node pid {1})" -f $d, $r.ProcessId)
        } else {
            Write-Host ("  [FAIL] {0}  ReturnValue={1}" -f $d, $r.ReturnValue)
        }
        continue
    }
    # -Hidden: go through a VBS shim using WScript.Shell.Run(cmd, 0, False)
    #   * window style 0 = hidden  -> no console window at all
    #   * bWaitOnReturn=False      -> wscript exits at once, node keeps running
    #                                 (same detachment as WMI: survives its parent)
    #   * the shim lives at <instance>\_launch_hidden.vbs so it can be inspected
    #     or run by hand
    # NOTE: the pid we get back here is wscript's, not node's. The real node pid is
    # resolved below from the listening port.
    $vbs = Join-Path $d '_launch_hidden.vbs'
    $vbsBody = "Set sh = CreateObject(""WScript.Shell"")" + "`r`n" +
               "sh.CurrentDirectory = ""$d""" + "`r`n" +
               "sh.Run """"""$Node"""" src\index.js"", 0, False" + "`r`n"
    [System.IO.File]::WriteAllText($vbs, $vbsBody, (New-Object System.Text.ASCIIEncoding))
    $r = ([wmiclass]'Win32_Process').Create('wscript.exe //nologo "{0}"' -f $vbs, $d)
    if ($r.ReturnValue -eq 0) {
        Write-Host ("  started(hidden): {0}" -f $d)
    } else {
        Write-Host ("  [FAIL] {0}  ReturnValue={1}" -f $d, $r.ReturnValue)
    }
}
Start-Sleep -Seconds 18

Write-Host '=== status ==='
foreach ($port in $Ports) {
    $c = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if ($c) {
        Write-Host ("  port {0}: LISTENING (pid {1})" -f $port, $c.OwningProcess)
    } else {
        Write-Host ("  port {0}: NOT LISTENING  <-- check logs\mimirlink-<date>.log" -f $port)
    }
}
Write-Host ''
Write-Host 'Health line: search "onebot=connected" in <instance>\logs\'
