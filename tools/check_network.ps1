# check_network.ps1 -- REAL-network reachability check for the search plan
#
# WHY THIS EXISTS:
#   Reachability tests run from inside the AI sandbox are UNRELIABLE.
#   The sandbox forces all outbound HTTP through a local proxy
#   (HTTP_PROXY=http://127.0.0.1:<port>). In direct mode the sandbox blocks
#   everything, including github.com. So "public SearXNG instances time out"
#   measured in the sandbox may simply be proxy policy, not your real ISP.
#
#   This script must be run BY YOU, in your own PowerShell window, with no
#   proxy environment variables set. Only then is the result meaningful.
#
# WHAT IT CHECKS:
#   1. DNS sanity   -- flags GFW-style poisoned answers (face:b00c, 2001::)
#   2. TCP+TLS      -- can we actually open an HTTPS connection
#   3. SearXNG JSON -- does the instance return real JSON (HTTP 200 is not enough)
#   4. Docker Hub   -- can docker pull work, or do we need a mirror
#
# USAGE (run in YOUR terminal, NOT via the AI):
#   .\check_network.ps1
#   .\check_network.ps1 -TimeoutMs 8000
#   .\check_network.ps1 -SkipSearxng
#
# Pure ASCII on purpose: Windows PowerShell 5.1 reads BOM-less .ps1 as ANSI,
# so non-ASCII text here would be corrupted.

[CmdletBinding()]
param(
    [int]$TimeoutMs = 6000,
    [switch]$SkipSearxng,
    [string]$Query = "chengdu university of technology"
)

$ErrorActionPreference = "Continue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# ------------------------------------------------------------ report plumbing
# We collect every line ourselves instead of using Start-Transcript, because
# transcript files inherit the (sometimes very narrow) console width and come
# out badly wrapped.
$script:Report = New-Object System.Collections.Generic.List[string]
$ReportPath = Join-Path $PSScriptRoot "check_network_report.txt"

function Say {
    param(
        [string]$Text = "",
        [string]$Color = "Gray"
    )
    Write-Host $Text -ForegroundColor $Color
    $script:Report.Add($Text)
}

function Head {
    param([string]$Text)
    Say ""
    Say ("=" * 74) "DarkGray"
    Say ("  " + $Text) "Cyan"
    Say ("=" * 74) "DarkGray"
}

# ---------------------------------------------------------------- DNS checks
# GFW DNS poisoning fingerprints seen on this network:
#   - IPv6 under 2a03:2880:*:face:b00c:*  (Facebook block prefix, hijacked)
#   - IPv6 under 2001::                   (Teredo range, never a real server)
function Test-DnsSanity {
    param([string]$Target)

    $aList = @()
    $aaaaList = @()
    $note = ""

    try {
        $all = [System.Net.Dns]::GetHostAddresses($Target)
        foreach ($ip in $all) {
            if ($ip.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork) {
                $aList += $ip.IPAddressToString
            } elseif ($ip.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetworkV6) {
                $aaaaList += $ip.IPAddressToString
            }
        }
    } catch {
        $note = "lookup failed"
    }

    $aStr = "-"
    if ($aList.Count -gt 0) { $aStr = ($aList -join ",") }
    $aaaaStr = "-"
    if ($aaaaList.Count -gt 0) { $aaaaStr = ($aaaaList -join ",") }

    $flags = @()
    if ($aaaaStr -match 'face:b00c') { $flags += "v6-facebook-block" }
    if ($aaaaStr -match '(^|,)2001::') { $flags += "v6-teredo-fake" }

    $poisoned = $false
    if ($flags.Count -gt 0) {
        $poisoned = $true
        $note = ($flags -join "+")
    }

    return [pscustomobject]@{
        Target   = $Target
        A        = $aStr
        AAAA     = $aaaaStr
        Poisoned = $poisoned
        Note     = $note
    }
}

# --------------------------------------------------------------- HTTPS check
# Detect a timeout by ELAPSED TIME, not by matching the exception text:
# on a Chinese-locale Windows the message is localized, and this file must
# stay pure ASCII, so text matching is not reliable here.
function Test-IsTimeout {
    param([object]$Result, [int]$TimeoutMs)
    if ($Result.Ok) { return $false }
    if ($Result.Code -gt 0) { return $false }
    return ($Result.Ms -ge ($TimeoutMs - 400))
}

function Test-Https {
    param([string]$Url, [int]$TimeoutMs)

    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        $req = [System.Net.HttpWebRequest]::Create($Url)
        $req.Method = "GET"
        $req.Timeout = $TimeoutMs
        $req.ReadWriteTimeout = $TimeoutMs
        $req.UserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
        $req.AllowAutoRedirect = $true
        $req.ServerCertificateValidationCallback = { $true }
        $resp = $req.GetResponse()
        $code = [int]$resp.StatusCode
        $ctype = [string]$resp.ContentType
        $sr = New-Object System.IO.StreamReader($resp.GetResponseStream())
        $body = $sr.ReadToEnd()
        $sr.Close()
        $resp.Close()
        $sw.Stop()
        return [pscustomobject]@{
            Ok = $true; Code = $code; Ctype = $ctype
            Ms = $sw.ElapsedMilliseconds; Body = $body; Error = ""
        }
    } catch [System.Net.WebException] {
        $sw.Stop()
        $code = 0
        $r = $_.Exception.Response
        if ($r -ne $null) { $code = [int]$r.StatusCode }
        return [pscustomobject]@{
            Ok = $false; Code = $code; Ctype = ""
            Ms = $sw.ElapsedMilliseconds; Body = ""
            Error = $_.Exception.Message
        }
    } catch {
        $sw.Stop()
        return [pscustomobject]@{
            Ok = $false; Code = 0; Ctype = ""
            Ms = $sw.ElapsedMilliseconds; Body = ""
            Error = $_.Exception.Message
        }
    }
}

# =========================================================================
# 0. environment sanity: are we behind a proxy right now?
# =========================================================================
Head "0. ENVIRONMENT"

$proxyNames = @("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy")
$proxyFound = @()
foreach ($n in $proxyNames) {
    $v = [Environment]::GetEnvironmentVariable($n)
    if ($v) { $proxyFound += ("{0} = {1}" -f $n, $v) }
}

if ($proxyFound.Count -gt 0) {
    Say "  WARNING: proxy env vars are set. Results reflect the PROXY," "Yellow"
    Say "           not your direct ISP path." "Yellow"
    foreach ($line in $proxyFound) { Say ("    " + $line) "Yellow" }
} else {
    Say "  no proxy env vars -- results reflect your real network path" "Green"
}
Say ("  PowerShell: {0}" -f $PSVersionTable.PSVersion) "Gray"

# =========================================================================
# 1. DNS sanity
# =========================================================================
Head "1. DNS SANITY (poisoning detection)"

$dnsTargets = @(
    "www.baidu.com",
    "searx.be",
    "priv.au",
    "opnxng.com",
    "searx.space",
    "registry-1.docker.io",
    "docker.m.daocloud.io"
)

Say ("  {0,-26} {1,-16} {2,-42} {3}" -f "HOST", "A", "AAAA", "FLAG") "DarkGray"

$poisonedHosts = @()
foreach ($t in $dnsTargets) {
    $r = Test-DnsSanity -Target $t
    $flag = "clean"
    $color = "Gray"
    if ($r.Poisoned) {
        $flag = "POISONED: " + $r.Note
        $color = "Red"
        $poisonedHosts += $t
    } elseif ($r.A -eq "-" -and $r.AAAA -eq "-") {
        $flag = "no answer"
        $color = "Yellow"
    }
    if ($r.Note -eq "lookup failed") { $flag = "lookup failed"; $color = "Yellow" }
    Say ("  {0,-26} {1,-16} {2,-42} {3}" -f $r.Target, $r.A, $r.AAAA, $flag) $color
}

# =========================================================================
# 2. HTTPS reachability
# =========================================================================
Head "2. HTTPS REACHABILITY"

$httpsTargets = @(
    @{ N = "baidu (baseline)";    U = "https://www.baidu.com" }
    @{ N = "aliyun-ecs (yours)";  U = "https://47.109.76.66/" }
    @{ N = "dockerhub upstream";  U = "https://registry-1.docker.io/v2/" }
    @{ N = "mirror daocloud";     U = "https://docker.m.daocloud.io/v2/" }
    @{ N = "mirror 1ms.run";      U = "https://docker.1ms.run/v2/" }
    @{ N = "mirror rat.dev";      U = "https://hub.rat.dev/v2/" }
    @{ N = "github (control)";    U = "https://github.com/" }
)

Say ("  {0,-24} {1,-6} {2,-8} {3}" -f "TARGET", "CODE", "MS", "NOTE") "DarkGray"

$httpsResult = @{}
foreach ($t in $httpsTargets) {
    $r = Test-Https -Url $t.U -TimeoutMs $TimeoutMs
    $note = ""
    $color = "Red"
    if ($r.Ok) {
        $note = "reachable"
        $color = "Green"
    } elseif (Test-IsTimeout -Result $r -TimeoutMs $TimeoutMs) {
        $note = "TIMEOUT (blocked / blackholed)"
    } elseif ($r.Code -gt 0) {
        $note = "HTTP $($r.Code) -- reachable, app-level response"
        $color = "Yellow"
    } else {
        $note = $r.Error
    }
    Say ("  {0,-24} {1,-6} {2,-8} {3}" -f $t.N, $r.Code, $r.Ms, $note) $color
    $httpsResult[$t.N] = $r
}

# =========================================================================
# 3. SearXNG public instances -- Content-Type application/json is mandatory
# =========================================================================
$usableInstances = @()
if (-not $SkipSearxng) {
    Head "3. PUBLIC SEARXNG INSTANCES (json api)"
    Say "  An HTTP 200 is NOT enough: many instances disable json and return" "DarkGray"
    Say "  an HTML page, or serve an anti-bot interstitial, both with 200." "DarkGray"
    Say ""

    $instances = @(
        "https://searx.be"
        "https://priv.au"
        "https://opnxng.com"
        "https://search.inetol.net"
        "https://searxng.site"
        "https://paulgo.io"
        "https://searx.tiekoetter.com"
        "https://baresearch.org"
    )
    $enc = [System.Uri]::EscapeDataString($Query)

    Say ("  {0,-32} {1,-6} {2,-8} {3}" -f "INSTANCE", "CODE", "MS", "RESULT") "DarkGray"

    foreach ($base in $instances) {
        $url = "{0}/search?q={1}&format=json" -f $base, $enc
        $r = Test-Https -Url $url -TimeoutMs $TimeoutMs
        $hname = ([System.Uri]$base).Host
        $label = ""
        $color = "Red"

        if (-not $r.Ok) {
            if (Test-IsTimeout -Result $r -TimeoutMs $TimeoutMs) { $label = "TIMEOUT" }
            else { $label = "unreachable: " + $r.Error }
        } elseif ($r.Ctype -notmatch "json") {
            $label = "HTTP $($r.Code) but NOT json -> json format disabled"
            $color = "Yellow"
        } else {
            $parsed = $null
            try { $parsed = $r.Body | ConvertFrom-Json } catch { }
            if ($parsed -ne $null -and $parsed.results -ne $null) {
                $n = @($parsed.results).Count
                $label = "USABLE -- $n results"
                $color = "Green"
                $usableInstances += $base
            } else {
                $label = "json, but no usable results key"
                $color = "Yellow"
            }
        }
        Say ("  {0,-32} {1,-6} {2,-8} {3}" -f $hname, $r.Code, $r.Ms, $label) $color
    }
}

# =========================================================================
# VERDICT
# =========================================================================
Head "VERDICT"

$dockerHubOk = $false
if ($httpsResult.ContainsKey("dockerhub upstream")) {
    $d = $httpsResult["dockerhub upstream"]
    if ($d.Ok -or $d.Code -eq 401 -or $d.Code -eq 403) { $dockerHubOk = $true }
}

$mirrorOk = $false
foreach ($m in @("mirror daocloud", "mirror 1ms.run", "mirror rat.dev")) {
    if ($httpsResult.ContainsKey($m)) {
        $x = $httpsResult[$m]
        if ($x.Ok -or $x.Code -eq 401 -or $x.Code -eq 403 -or $x.Code -eq 302) { $mirrorOk = $true }
    }
}

$ecsOk = $false
if ($httpsResult.ContainsKey("aliyun-ecs (yours)")) { $ecsOk = $httpsResult["aliyun-ecs (yours)"].Ok }

Say ""
if ($poisonedHosts.Count -gt 0) {
    Say ("  DNS poisoning detected on: {0}" -f ($poisonedHosts -join ", ")) "Red"
    Say "  -> those hosts are unreachable no matter which tool you use." "Red"
}

if ($usableInstances.Count -gt 0) {
    Say ("  Usable public SearXNG: {0}" -f ($usableInstances -join ", ")) "Green"
    Say "  -> a FREE, KEYLESS search route EXISTS on this network." "Green"
} else {
    Say "  No usable public SearXNG instance." "Yellow"
    Say "  -> the free route must be SELF-HOSTED (docker locally, or aliyun ecs)." "Yellow"
}

Say ""
if ($dockerHubOk) {
    Say "  Docker Hub: DIRECTLY reachable -> docker pull works as-is." "Green"
} elseif ($mirrorOk) {
    Say "  Docker Hub: NOT reachable, but a MIRROR is." "Yellow"
    Say "  -> registry-mirrors IS required. Fix with:" "Yellow"
    Say "       python fix_docker_mirror.py --apply   (then restart Docker Desktop)" "Yellow"
} else {
    Say "  Docker Hub AND all mirrors blocked -> docker pull CANNOT work here." "Red"
}

Say ""
if ($ecsOk) {
    Say "  Aliyun ECS: reachable -> hosting SearXNG there is viable." "Green"
} else {
    Say "  Aliyun ECS: NOT reachable -> check the instance / security group." "Red"
}

$script:Report | Out-File -FilePath $ReportPath -Encoding UTF8
Say ""
Say ("  report saved: {0}" -f $ReportPath) "DarkGray"
Say ""
