#!/usr/bin/env python3
"""Acceptance test: what does MimirLink actually SEE?

Everything so far measured SearXNG's raw output, but MimirLink asks for five
results and feeds those to the model. An engine returning 20 on-topic results
is worthless if ten noisy bing entries outrank them, so the only meaningful
test is the top five, requested exactly the way MimirLink requests them.

The request is a byte-for-byte copy of src/search/providers/searxng.js:
    q, format=json, categories=general, language=<locale>, safesearch=1,
    pageno=1
with maxResults: 5.

Usage:
    python check_top5.py            # install config first, then test
    python check_top5.py --no-install
"""
import json
import os
import re
import subprocess
import sys
import time
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
DEPLOY = os.path.normpath(os.path.join(HERE, '..', 'searxng-deploy'))
LOCAL = os.path.join(DEPLOY, 'settings.local.yml')
LIVE = os.path.join(DEPLOY, 'config', 'settings.yml')
ENV = os.path.join(DEPLOY, '.env')
COMPOSE = 'docker-compose.local.yml'
BASE = 'http://127.0.0.1:8888'

QUERIES = [
    '成都理工大学 2026 年招生简章',
    '蓝桥杯 2026 报名时间',
    'what is the capital of peru',
]


def run(cmd, merge=False, **kw):
    if merge:
        return subprocess.run(cmd, stdout=subprocess.PIPE,
                              stderr=subprocess.STDOUT, text=True, **kw)
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


def urlopen_np(url, timeout=120):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    return opener.open(url, timeout=timeout)


def wait_ready(deadline):
    while time.time() < deadline:
        try:
            with urlopen_np(BASE + '/healthz', timeout=3) as r:
                if r.status == 200:
                    return True
        except Exception:
            pass
        time.sleep(1)
    return False


def install():
    secret = ''
    for line in open(ENV, encoding='utf-8'):
        if line.startswith('SEARXNG_SECRET='):
            secret = line.split('=', 1)[1].strip()
    text = open(LOCAL, encoding='utf-8').read()
    with open(LIVE, 'w', encoding='utf-8', newline='\n') as f:
        f.write(text.replace('__SECRET__', secret))
    out = run(['docker', 'compose', '-f', COMPOSE, 'up', '-d', '--force-recreate'],
              cwd=DEPLOY, merge=True)
    if out.returncode != 0:
        print((out.stdout or '')[-1500:])
        sys.exit('compose failed')
    if not wait_ready(time.time() + 60):
        sys.exit('not ready')
    print('config installed, container up\n')


def mimirlink_search(query, limit=5, locale='zh-cn'):
    """Reproduce src/search/providers/searxng.js exactly."""
    params = urllib.parse.urlencode({
        'q': query,
        'format': 'json',
        'categories': 'general',
        'language': locale,
        'safesearch': '1',
        'pageno': '1',
    })
    t0 = time.time()
    with urlopen_np(BASE + '/search?' + params) as r:
        payload = json.loads(r.read().decode('utf-8'))
    return payload.get('results', []), int((time.time() - t0) * 1000)


def main():
    if '--no-install' not in sys.argv:
        install()

    for q in QUERIES:
        print('=' * 74)
        print('QUERY: %s' % q)
        print('=' * 74)
        try:
            results, ms = mimirlink_search(q)
        except Exception as exc:
            print('  FAILED: %s: %s\n' % (type(exc).__name__, exc))
            continue

        print('  %d results total, %d ms -- MimirLink keeps the first 5:' % (len(results), ms))
        print()
        for i, r in enumerate(results[:5], 1):
            engs = ','.join(r.get('engines', []) or ['?'])
            print('  %d. [%s] %s' % (i, engs, (r.get('title') or '')[:68]))
            print('       %s' % (r.get('url') or '')[:90])
            snippet = re.sub(r'\s+', ' ', r.get('content') or '')[:110]
            if snippet:
                print('       %s' % snippet)
        print()

        # how much of the visible window each engine holds
        share = {}
        for r in results[:5]:
            for e in r.get('engines', []) or ['?']:
                share[e] = share.get(e, 0) + 1
        print('  top-5 attribution: %s'
              % (', '.join('%s=%d' % kv for kv in
                           sorted(share.items(), key=lambda kv: -kv[1])) or '(none)'))
        print()


if __name__ == '__main__':
    main()
