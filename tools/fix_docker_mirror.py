#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Configure Docker registry mirrors for Docker Desktop on this machine.

WHY: registry-1.docker.io is unreachable from this network
     (measured: curl https://registry-1.docker.io/v2/ -> code=000, 10s hang).
     Without a mirror, `docker pull searxng/searxng:latest` will hang forever.

Verified-reachable mirrors from this machine:
     docker.m.daocloud.io   -> 401 (normal unauthenticated /v2/ response = OK)
     docker.1ms.run         -> 401 (OK)
     hub.rat.dev            -> 302 (OK)

The file edited is ~/.docker/daemon.json, which is exactly the file that
Docker Desktop's "Settings -> Docker Engine" JSON editor writes to.

Usage:
    python fix_docker_mirror.py --show
    python fix_docker_mirror.py --apply
    python fix_docker_mirror.py --revert
"""
import argparse
import json
import os
import shutil
import sys
import time

DAEMON = os.path.join(os.path.expanduser("~"), ".docker", "daemon.json")

MIRRORS = [
    "https://docker.m.daocloud.io",
    "https://docker.1ms.run",
    "https://hub.rat.dev",
]


def load():
    if not os.path.exists(DAEMON):
        return {}
    with open(DAEMON, "rb") as fh:
        raw = fh.read().decode("utf-8-sig").strip()
    if not raw:
        return {}
    return json.loads(raw)


def save(data, tag):
    os.makedirs(os.path.dirname(DAEMON), exist_ok=True)
    if os.path.exists(DAEMON):
        bak = f"{DAEMON}.bak-{tag}"
        shutil.copy2(DAEMON, bak)
        print(f"backup   : {bak}")
    with open(DAEMON, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(data, fh, indent=2, ensure_ascii=False)
        fh.write("\n")
    print(f"written  : {DAEMON}")


def show():
    print(f"file     : {DAEMON}")
    print(f"exists   : {os.path.exists(DAEMON)}")
    try:
        data = load()
    except Exception as e:
        print(f"parse    : FAILED ({e})")
        return 1
    print("current  :")
    print(json.dumps(data, indent=2, ensure_ascii=False))
    mirrors = data.get("registry-mirrors") or []
    print()
    if mirrors:
        print(f"mirrors  : {len(mirrors)} configured")
        for m in mirrors:
            print(f"  - {m}")
    else:
        print("mirrors  : NONE  -> docker pull from Docker Hub will hang")
    return 0


def apply():
    data = load()
    old = list(data.get("registry-mirrors") or [])
    merged = []
    for m in MIRRORS + old:
        if m not in merged:
            merged.append(m)
    data["registry-mirrors"] = merged
    tag = time.strftime("%Y%m%d-%H%M%S")
    save(data, tag)
    print("mirrors  :")
    for m in merged:
        print(f"  - {m}")
    print()
    print("NEXT: restart Docker Desktop (or:  Docker Desktop -> Settings ->")
    print("      Docker Engine should now show these mirrors) for it to apply.")
    return 0


def revert():
    d = os.path.dirname(DAEMON)
    baks = sorted(
        (f for f in os.listdir(d) if f.startswith("daemon.json.bak-")), reverse=True
    )
    if not baks:
        print("no backup found")
        return 1
    src = os.path.join(d, baks[0])
    shutil.copy2(src, DAEMON)
    print(f"restored : {DAEMON}")
    print(f"from     : {src}")
    return 0


def main():
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--show", action="store_true")
    g.add_argument("--apply", action="store_true")
    g.add_argument("--revert", action="store_true")
    args = ap.parse_args()
    if args.show:
        return show()
    if args.apply:
        return apply()
    return revert()


if __name__ == "__main__":
    sys.exit(main())
