#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Verify a Docker registry mirror can ACTUALLY serve the searxng/searxng image,
and that its token-auth endpoint is not collateral damage of DNS poisoning.

WHY THIS IS NEEDED
------------------
On this machine registry-1.docker.io is DNS-poisoned: it resolves to
192.133.77.145, which is a Twitter address (and the AAAA record lands in the
GFW's 2a03:2880:*:face:b00c:* fingerprint). So a plain
`docker pull searxng/searxng` hangs forever.

An HTTP 401 on /v2/ only proves a mirror is ALIVE. It does NOT prove:
  (a) the mirror has the image we want, or
  (b) the mirror's token endpoint is reachable.

(b) is the subtle one. Docker fetches a bearer token from the realm advertised
in the mirror's WWW-Authenticate header. If that realm happens to be
auth.docker.io, the pull dies even though the mirror itself is fine.
auth.docker.io is ALSO poisoned here (157.240.10.41 = Facebook). Fortunately
all three working mirrors use their own auth realm instead.

This script performs the full Docker Registry v2 flow:
    1. GET /v2/                                  -> read WWW-Authenticate realm
    2. GET <realm>?service=<svc>&scope=...       -> anonymous bearer token
    3. GET /v2/<repo>/manifests/<tag>            -> the real manifest
and separately checks DNS for the auth endpoints.

Usage:
    python verify_docker_mirror.py
    python verify_docker_mirror.py --image searxng/searxng --tag latest
"""
import argparse
import json
import re
import socket
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

MIRRORS = [
    "https://docker.m.daocloud.io",
    "https://docker.1ms.run",
    "https://hub.rat.dev",
    "https://docker.nju.edu.cn",
    # reference: the upstream we measured as poisoned
    "https://registry-1.docker.io",
]

# Endpoints Docker would need if we did NOT use a mirror.
# These are here purely to document WHY a mirror is mandatory.
UPSTREAM_ENDPOINTS = [
    "registry-1.docker.io",
    "auth.docker.io",
    "production.cloudflare.docker.com",
]

CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE

UA = "docker/29.6.2"

MANIFEST_ACCEPT = ", ".join([
    "application/vnd.docker.distribution.manifest.v2+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.oci.image.index.v1+json",
])

# GFW poisoning fingerprints
POISON_PATTERNS = [
    re.compile(r"face:b00c", re.I),      # AAAA hijack -> Facebook prefix
    re.compile(r"^2001::"),              # AAAA in the Teredo range
]


def http(url, headers=None, timeout=12):
    req = urllib.request.Request(url, headers={"User-Agent": UA, **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=CTX) as r:
            return r.status, dict(r.headers), r.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers or {}), e.read()
    except Exception as e:
        return None, {}, str(e).encode()


def resolve(host):
    try:
        infos = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
    except Exception as e:
        return [], str(e)
    v4, v6 = set(), set()
    for info in infos:
        ip = info[4][0]
        (v6 if ":" in ip else v4).add(ip)
    return sorted(v4), sorted(v6)


def dns_verdict(host):
    v4, v6 = resolve(host)
    if not v4 and not v6:
        return "DNS-FAIL", [], []
    for pat in POISON_PATTERNS:
        for ip in v6:
            if pat.search(ip):
                return "POISONED", v4, v6
    return "clean", v4, v6


def get_token(auth_header, repo):
    m = re.search(r'realm="([^"]+)"', auth_header or "")
    if not m:
        return None, None, "no realm in WWW-Authenticate"
    realm = m.group(1)
    svc = re.search(r'service="([^"]+)"', auth_header or "")
    params = {"scope": f"repository:{repo}:pull"}
    if svc:
        params["service"] = svc.group(1)
    url = realm + ("&" if "?" in realm else "?") + urllib.parse.urlencode(params)
    status, _, body = http(url)
    if status != 200:
        return None, realm, f"token endpoint HTTP {status}"
    try:
        return json.loads(body.decode())["token"], realm, None
    except Exception as e:
        return None, realm, f"token parse: {e}"


def probe(mirror, repo, tag):
    """Return (ok, detail, ms, realm, realm_status)."""
    t0 = time.time()

    status, headers, body = http(mirror.rstrip("/") + "/v2/")
    if status is None:
        return False, f"unreachable: {body[:50].decode('utf-8', 'replace')}", 0, "", ""

    auth = headers.get("WWW-Authenticate") or headers.get("Www-Authenticate") or ""
    token, realm, err = None, "", ""
    if auth:
        token, realm, err = get_token(auth, repo)
        if token is None:
            return False, f"auth failed: {err}", 0, realm or "", ""

    # is the realm host itself healthy? (this is the subtle failure mode)
    realm_status = ""
    if realm:
        rhost = urllib.parse.urlparse(realm).hostname or ""
        verdict, _, _ = dns_verdict(rhost)
        realm_status = f"{rhost} [{verdict}]"

    h = {"Accept": MANIFEST_ACCEPT}
    if token:
        h["Authorization"] = f"Bearer {token}"
    murl = f"{mirror.rstrip('/')}/v2/{repo}/manifests/{tag}"
    st2, hd2, bd2 = http(murl, h)
    ms = int((time.time() - t0) * 1000)

    if st2 != 200:
        snippet = bd2[:80].decode("utf-8", "replace").replace("\n", " ")
        return False, f"manifest HTTP {st2}: {snippet}", ms, realm, realm_status

    ctype = (hd2.get("Content-Type") or hd2.get("content-type") or "").lower()
    try:
        payload = json.loads(bd2.decode())
    except Exception:
        return False, f"manifest not JSON (ctype={ctype})", ms, realm, realm_status

    if "manifests" in payload:  # multi-arch index
        plats = [
            f"{m.get('platform', {}).get('os')}/{m.get('platform', {}).get('architecture')}"
            for m in payload.get("manifests", [])
        ]
        return True, f"multi-arch index, {len(plats)} platforms: {', '.join(plats[:4])}", ms, realm, realm_status

    layers = payload.get("layers") or []
    return True, f"single manifest, {len(layers)} layers", ms, realm, realm_status


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--image", default="searxng/searxng")
    ap.add_argument("--tag", default="latest")
    args = ap.parse_args()

    print("=" * 78)
    print("A. UPSTREAM ENDPOINTS (what a plain `docker pull` would need)")
    print("=" * 78)
    upstream_bad = []
    for host in UPSTREAM_ENDPOINTS:
        verdict, v4, v6 = dns_verdict(host)
        mark = "FAIL" if verdict != "clean" else "PASS"
        if verdict != "clean":
            upstream_bad.append(host)
        print(f"  {mark}  {host:<38} {verdict:<9} v4={','.join(v4) or '-'}")
        if v6:
            print(f"        {'':<38} {'':<9} v6={','.join(v6)}")

    print()
    print("=" * 78)
    print(f"B. MIRRORS  (image: {args.image}:{args.tag})")
    print("=" * 78)
    any_ok = False
    for m in MIRRORS:
        ok, detail, ms, realm, realm_status = probe(m, args.image, args.tag)
        host = urllib.parse.urlparse(m).netloc
        print(f"  {'PASS' if ok else 'FAIL'}  {host:<26} {ms:>6}ms  {detail}")
        if realm_status:
            print(f"        auth realm: {realm_status}")
        if ok:
            any_ok = True

    print()
    print("=" * 78)
    print("VERDICT")
    print("=" * 78)
    if upstream_bad:
        print(f"  upstream blocked/poisoned : {', '.join(upstream_bad)}")
        print("  -> a registry MIRROR is mandatory; plain docker pull cannot work.")
    else:
        print("  upstream endpoints are clean -> a mirror is optional.")

    if any_ok:
        print("  at least one mirror serves the image -> `docker pull` will work.")
        print("  make sure ~/.docker/daemon.json lists these mirrors, then restart")
        print("  Docker Desktop for it to take effect:")
        print("      python fix_docker_mirror.py --apply")
        return 0

    print("  NO mirror could serve the image -> `docker pull` will hang/fail.")
    print("  fall back to hosting SearXNG on the aliyun ECS instead.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
