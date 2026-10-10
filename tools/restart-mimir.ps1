# MimirLink one-click restart (both instances)
# Usage:  & "C:\Users\20633\WorkBuddy\2026-05-28-17-36-40\mimir-tools\restart-mimir.ps1"
#
# Notes:
#   * NapCat / QQ are GUI apps and are NOT touched here - start them by hand.
#   * Logs: <instance>\logs\mimirlink-<date>.log   (the app writes these itself)
#   * Health: search "onebot=connected" in <instance>\logs\
#
# Launch method: Win32_Process.Create (WMI), NOT Start-Process.
#   Start-Process children belong to the caller's session/job. When the caller
#   is a transient shell (e.g. a one-off tool call), the children are killed the
#   moment that shell exits. The script still printed "LISTENING" because it
#   checked 18s later, so it looked like a success. WMI Create produces a truly
#   detached process that survives its parent.
#   Trade-off: WMI cannot redirect stdout/stderr, so no _boot_out.log. The app
#   logs everything it needs to logs\ itself, and syntax is pre-checked below.

$ErrorActionPreference = 'Continue'

$Node  = 'C:\Program Files\nodejs\node.exe'
$Dirs  = @('C:\Users\20633\MimirLink-soyo', 'C:\Users\20633\MimirLink')
$Ports = @(8002, 8001)

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

Write-Host '=== start (detached via Win32_Process.Create) ==='
foreach ($d in $Dirs) {
    if (-not (Test-Path (Join-Path $d 'src\index.js'))) { continue }
    $cmd = '"{0}" src/index.js' -f $Node
    $r = ([wmiclass]'Win32_Process').Create($cmd, $d)
    if ($r.ReturnValue -eq 0) {
        Write-Host ("  started: {0}  (pid {1})" -f $d, $r.ProcessId)
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
