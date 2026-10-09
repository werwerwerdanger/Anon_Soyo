#!/usr/bin/env python3
"""Runs INSIDE the searxng container.

Step 1 of the engine hunt: figure out which candidate engines could possibly
work from this network, without paying SearXNG's 10s per-engine timeout.

Method: for every candidate engine, read its module file, pull out base_url,
then TCP-connect to host:443 with a short timeout.  A search engine whose
front page does not even complete a TCP handshake cannot possibly return
results, so this kills most of the list for free.

Output: /tmp/reach.txt  (copied out by the caller)
"""
import concurrent.futures as cf
import os
import re
import socket
import sys

sys.path.insert(0, '/usr/local/searxng')

SETTINGS = '/usr/local/searxng/searx/settings.yml'
ENGINE_DIR = '/usr/local/searxng/searx/engines'

# Engines worth testing for a chat bot doing general web search.
# Chinese first (that is the actual workload), then general/metasearch.
CANDIDATES = [
    # --- baseline: known state ---
    'bing',
    'baidu',
    # --- mainland Chinese ---
    'baidu kaifa',
    'sogou',
    'sogou wechat',
    '360search',
    'quark',
    'chinaso news',
    'sina',
    'bilibili',
    'acfun',
    # --- metasearch / aggregators ---
    'dogpile',
    'metacrawler',
    'zapmeta',
    'fireball',
    'privacywall',
    'tusksearch',
    'startpagina',
    'xprivo',
    'vuhuv',
    'luxxle',
    'searchzee',
    # --- real independent indexes ---
    'mojeek',
    'marginalia',
    'wiby',
    'yacy',
    'mwmbl',
    'right dao',
    'stract',
    'seekr',
    'gabanza',
    'cl0q',
    'artic',
    'kukei',
    'littlelayer',
    'seekninja',
    'unobtanium',
    'neosearch',
    'resulthunter',
    'zoo search',
    's1search',
    'searchmysite',
    'searchrockit',
    'rawweb',
    'findborg',
    'iseek',
    'mozhi',
    'yep',
    'boardreader',
    'crowdview',
    'encyclosearch',
    'xonaly',
    # --- the usual internationals (expected to fail, measured anyway) ---
    'duckduckgo',
    'google',
    'startpage',
    'brave',
    'qwant',
    'yandex',
    'yahoo',
    'naver',
    'seznam',
    'swisscows',
    'exaapi',
]


def parse_settings():
    """name -> (engine_module, base_url_override)"""
    text = open(SETTINGS, encoding='utf-8').read()
    out = {}
    cur = None
    for line in text.split('\n'):
        m = re.match(r'^  - name: (.*)$', line)
        if m:
            cur = m.group(1).strip().strip('"').strip("'")
            out.setdefault(cur, {'engine': None, 'base_url': None})
            continue
        if cur is None:
            continue
        m = re.match(r'^    (engine|base_url): (.*)$', line)
        if m:
            key = m.group(1)
            val = m.group(2).strip().strip('"').strip("'")
            if out[cur][key] is None:
                out[cur][key] = val
    return out


def find_base_urls():
    """engine module -> base_url literal, scraped out of the module source."""
    found = {}
    for fn in os.listdir(ENGINE_DIR):
        if not fn.endswith('.py'):
            continue
        mod = fn[:-3]
        try:
            src = open(os.path.join(ENGINE_DIR, fn), encoding='utf-8').read()
        except OSError:
            continue
        hits = re.findall(r'(?m)^base_url\s*[:=][^=]*?[\'"](https?://[^\'"]+)[\'"]', src)
        if hits:
            found[mod] = hits[0]
    return found


def host_of(url):
    m = re.match(r'https?://([^/:]+)', url or '')
    return m.group(1) if m else None


def tcp_ok(host, port=443, timeout=4.0):
    try:
        infos = socket.getaddrinfo(host, port, proto=socket.IPPROTO_TCP)
    except OSError as exc:
        return False, 'dns:%s' % exc.__class__.__name__, None
    ip = infos[0][4][0]
    s = socket.socket(infos[0][0], socket.SOCK_STREAM)
    s.settimeout(timeout)
    try:
        s.connect(infos[0][4])
        return True, 'ok', ip
    except OSError as exc:
        return False, 'tcp:%s' % exc.__class__.__name__, ip
    finally:
        s.close()


def main():
    settings = parse_settings()
    mods = find_base_urls()
    rows = []
    for name in CANDIDATES:
        entry = settings.get(name)
        if entry is None:
            rows.append((name, '-', 'NOT-IN-SETTINGS', '-'))
            continue
        mod = entry['engine'] or name.replace(' ', '_')
        url = entry['base_url'] or mods.get(mod) or mods.get(mod.replace('-', '_'))
        host = host_of(url)
        if not host:
            rows.append((name, mod, 'NO-BASE-URL', '-'))
            continue
        rows.append((name, mod, url, host))

    # resolve + connect in parallel; DNS here can block for seconds
    to_probe = [r for r in rows if r[3] != '-']
    results = {}
    with cf.ThreadPoolExecutor(max_workers=24) as pool:
        futs = {pool.submit(tcp_ok, r[3]): r[0] for r in to_probe}
        for fut in cf.as_completed(futs):
            results[futs[fut]] = fut.result()

    ok, bad = [], []
    for name, mod, url, host in rows:
        if host == '-':
            bad.append((name, mod, url, host, 'n/a', '-'))
            continue
        good, why, ip = results.get(name, (False, 'not-probed', None))
        rec = (name, mod, url, host, why, ip)
        (ok if good else bad).append(rec)

    with open('/tmp/reach.txt', 'w', encoding='utf-8') as f:
        f.write('=== REACHABLE (tcp 443 ok) : %d ===\n' % len(ok))
        for n, m, u, h, w, ip in ok:
            f.write('%-22s %-20s %-34s %s\n' % (n, m, h, ip))
        f.write('\n=== UNREACHABLE : %d ===\n' % len(bad))
        for n, m, u, h, w, ip in bad:
            f.write('%-22s %-20s %-34s %-14s %s\n' % (n, m, h, w, ip))
    print('ok=%d bad=%d' % (len(ok), len(bad)))


if __name__ == '__main__':
    main()
