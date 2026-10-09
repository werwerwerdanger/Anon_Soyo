#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Verify the COMPLETE docker pull path through a mirror, down to the layer blob.

WHY THIS IS NEEDED
------------------
Checking that a mirror serves the image MANIFEST is not enough. Docker pulls in
three hops:

    1. /v2/                              -> auth realm
    2. <realm>?scope=...                 -> bearer token
    3. /v2/<repo>/manifests/<tag>        -> manifest (a small JSON)
    4. /v2/<repo>/blobs/<digest>         -> the actual LAYERS (the big bytes)

Hop 4 is where pulls silently die. If the mirror answers hop 4 with a 302 to
production.cloudflare.docker.com, and that CDN is DNS-poisoned -- which it IS on
this network (measured: 104.244.46.186 = Twitter address, plus the GFW
2a03:2880:*:face:b00c:* IPv6 fingerprint) -- then docker pull will print
"Pulling fs layer..." and hang at 0% forever, even though everything up to the
manifest looked perfectly healthy.

This script therefore:
    A. resolves the upstream blob CDN and reports whether it is poisoned
    B. walks hops 1-3 for each mirror
    C. requests hop 4 WITHOUT following redirects, then inspects the Location:
         - 200 with a real Content-Length  -> mirror serves blobs itself (GOOD)
         - 302 to its OWN host             -> mirror proxies blobs      (GOOD)
         - 302 to a POISONED host          -> pull will hang            (BAD)

Usage:
    python verify_docker_blobs.py
    python verify_docker_blobs.py --image searxng/searxng
"""
import argparse
import json
import re
import socket
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request

MIRRORS = [
    "https://docker.m.daocloud.io",
    "https://docker.1ms.run",
    "https://hub.rat.dev",
]

UA = "docker/29.6.2"

ACCEPT = ", ".join([
    "application/vnd.docker.distribution.manifest.v2+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.oci.image.index.v1+json",
])

CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE

POISON_PATTERNS = [
    re.compile(r"face:b00c", re.I),
    re.compile(r"^2001::"),
]


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


_plain = urllib.request.build_opener(
    urllib.request.HTTPSHandler(context=CTX)
)
_manual = urllib.request.build_opener(
    NoRedirect(), urllib.request.HTTPSHandler(context=CTX)
)


def fetch(url, headers=None, redirect=True, method="GET", read=True):
    opener = _plain if redirect else _manual
    req = urllib.request.Request(
        url, headers={"User-Agent": UA, **(headers or {})}, method=method
    )
    try:
        with opener.open(req, timeout=20) as r:
            body = r.read() if read else b""
            return r.status, {k.lower(): v for k, v in r.headers.items()}, body, None
    except urllib.error.HTTPError as e:
        body = e.read() if read else b""
        return e.code, {k.lower(): v for k, v in (e.headers or {}).items()}, body, None
    except Exception as e:
        return None, {}, b"", str(e)[:100]


def dns_state(host):
    try:
        infos = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
    except Exception:
        return "DNS-FAIL", [], []
    v4, v6 = set(), set()
    for info in infos:
        ip = info[4][0]
        (v6 if ":" in ip else v4).add(ip)
    v4, v6 = sorted(v4), sorted(v6)
    for pat in POISON_PATTERNS:
        for ip in v6:
            if pat.search(ip):
                return "POISONED", v4, v6
    return "clean", v4, v6


def get_token(mirror, repo):
    st, hd, _, err = fetch(mirror.rstrip("/") + "/v2/")
    if st is None:
        return None, f"/v2/ unreachable: {err}"
    if st == 200:
        return None, None  # anonymous, no token needed
    auth = hd.get("www-authenticate", "")
    m = re.search(r'realm="([^"]+)"', auth)
    if not m:
        return None, f"no realm (status {st})"
    realm = m.group(1)
    svc = re.search(r'service="([^"]+)"', auth)
    params = {"scope": f"repository:{repo}:pull"}
    if svc:
        params["service"] = svc.group(1)
    url = realm + ("&" if "?" in realm else "?") + urllib.parse.urlencode(params)
    st2, _, body, err2 = fetch(url)
    if st2 != 200:
        return None, f"token endpoint HTTP {st2} {err2 or ''}"
    try:
        return json.loads(body.decode())["token"], None
    except Exception as e:
        return None, f"token parse: {e}"


def walk(mirror, repo, tag):
    """Return dict with the result of each hop."""
    out = {"mirror": mirror, "hops": {}, "ok": False, "detail": ""}
    base = mirror.rstrip("/")

    token, err = get_token(mirror, repo)
    if err:
        out["detail"] = err
        return out
    out["hops"]["token"] = "ok" if token else "anonymous"

    hdr = {"Accept": ACCEPT}
    if token:
        hdr["Authorization"] = f"Bearer {token}"

    # hop 3a: tag -> index/manifest
    st, hd, body, err = fetch(f"{base}/v2/{repo}/manifests/{tag}", hdr)
    if st != 200:
        out["detail"] = f"manifest HTTP {st} {err or ''}"
        return out
    try:
        payload = json.loads(body.decode())
    except Exception as e:
        out["detail"] = f"manifest parse: {e}"
        return out

    # hop 3b: if it is a multi-arch index, descend to linux/amd64
    if "manifests" in payload:
        plats = payload.get("manifests", [])
        out["hops"]["index"] = f"{len(plats)} platforms"
        pick = None
        for m in plats:
            p = m.get("platform", {})
            if p.get("os") == "linux" and p.get("architecture") == "amd64":
                pick = m
                break
        if pick is None:
            out["detail"] = "no linux/amd64 in index"
            return out
        st, hd, body, err = fetch(f"{base}/v2/{repo}/manifests/{pick['digest']}", hdr)
        if st != 200:
            out["detail"] = f"amd64 manifest HTTP {st} {err or ''}"
            return out
        try:
            payload = json.loads(body.decode())
        except Exception as e:
            out["detail"] = f"amd64 manifest parse: {e}"
            return out

    layers = payload.get("layers") or []
    if not layers:
        out["detail"] = "manifest has no layers"
        return out
    out["hops"]["layers"] = len(layers)
    out["layer_bytes"] = sum(int(x.get("size") or 0) for x in layers)

    # hop 4: the blob -- the one that actually matters
    target = layers[0]
    url = f"{base}/v2/{repo}/blobs/{target['digest']}"
    st, hd, _, err = fetch(url, hdr, redirect=False, method="HEAD")
    if st is None:
        # some registries reject HEAD; retry with a ranged GET
        st, hd, _, err = fetch(url, {**hdr, "Range": "bytes=0-1"}, redirect=False, read=False)

    out["hops"]["blob_status"] = st
    location = hd.get("location") or ""
    out["blob_location"] = location

    if st == 200:
        out["ok"] = True
        size = hd.get("content-length") or "?"
        out["detail"] = f"blob served directly by mirror (content-length={size})"
    elif st in (301, 302, 303, 307, 308) and location:
        dest = urllib.parse.urlparse(location).hostname or ""
        state, _, _ = dns_state(dest)
        if state == "clean" or dest.endswith(urllib.parse.urlparse(base).hostname or ""):
            out["ok"] = True
            out["detail"] = f"blob 302 -> {dest} [{state}] (OK)"
        else:
            out["ok"] = False
            out["detail"] = f"blob 302 -> {dest} [{state}] -- PULL WILL HANG"
    else:
        out["detail"] = f"blob HTTP {st} {err or ''}"
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--image", default="searxng/searxng")
    ap.add_argument("--tag", default="latest")
    args = ap.parse_args()

    print("=" * 78)
    print("A. UPSTREAM BLOB CDN")
    print("=" * 78)
    cdn_bad = False
    for host in ["production.cloudflare.docker.com", "registry-1.docker.io", "auth.docker.io"]:
        state, v4, v6 = dns_state(host)
        if state != "clean":
            cdn_bad = True
        print(f"  {'FAIL' if state != 'clean' else 'PASS'}  {host:<36} {state}")
        print(f"        v4={','.join(v4) or '-'}")
        if v6:
            print(f"        v6={','.join(v6)}")

    print()
    print("=" * 78)
    print(f"B. FULL PULL PATH  ({args.image}:{args.tag})")
    print("=" * 78)

    good, bad = [], []
    for mirror in MIRRORS:
        host = urllib.parse.urlparse(mirror).netloc
        r = walk(mirror, args.image, args.tag)
        print(f"  {'PASS' if r['ok'] else 'FAIL'}  {host}")
        for k, v in r["hops"].items():
            print(f"        {k:<12} {v}")
        print(f"        detail       {r['detail']}")
        if r.get("layer_bytes"):
            print(f"        total layers {r['layer_bytes'] / 1048576:.1f} MB")
        (good if r["ok"] else bad).append(host)

    print()
    print("=" * 78)
    print("VERDICT")
    print("=" * 78)
    if cdn_bad:
        print("  upstream blob CDN is poisoned -> a mirror that proxies blobs is REQUIRED.")
    if good:
        print(f"  mirrors with a WORKING full pull path: {', '.join(good)}")
        print("  -> docker pull will succeed once daemon.json lists them.")
        print("     python fix_docker_mirror.py --apply   (then restart Docker Desktop)")
        return 0
    print("  NO mirror delivered the blob -> docker pull WILL hang at 0%.")
    print("  -> host SearXNG on the aliyun ECS instead of locally.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
