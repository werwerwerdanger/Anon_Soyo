#!/usr/bin/env python3
"""Install the new engine set and validate it against the LIVE config.

Unlike test_engines2.py this does NOT swap settings: it installs
settings.local.yml the same way run-local.ps1 does (substituting __SECRET__,
then force-recreating the container, because SearXNG only reads settings at
boot) and then measures the configuration that will actually serve MimirLink.

Why six identical queries instead of one: the whole point of this hunt is that
an engine can answer and then quietly stop, so a single successful request
proves nothing. Six repeats plus a look at the titles is the minimum bar for
calling an engine usable.

Usage:
    python validate_engines.py            # install + validate
    python validate_engines.py --no-install
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

REPEATS = 6
QUERIES = [
    ('zh', '成都理工大学 2026 年招生简章'),
    ('en', 'what is the capital of peru'),
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
    secret = None
    for line in open(ENV, encoding='utf-8'):
        if line.startswith('SEARXNG_SECRET='):
            secret = line.split('=', 1)[1].strip()
    if not secret:
        sys.exit('no SEARXNG_SECRET in %s' % ENV)

    text = open(LOCAL, encoding='utf-8').read()
    if '__SECRET__' not in text:
        sys.exit('settings.local.yml has no __SECRET__ placeholder')
    text = text.replace('__SECRET__', secret)

    with open(LIVE, 'w', encoding='utf-8', newline='\n') as f:
        f.write(text)
    print('installed settings.local.yml -> config/settings.yml')

    out = run(['docker', 'compose', '-f', COMPOSE, 'up', '-d', '--force-recreate'],
              cwd=DEPLOY, merge=True)
    if out.returncode != 0:
        print((out.stdout or '')[-2000:])
        sys.exit('compose failed -- check keep_only / engines: for a name typo')

    if not wait_ready(time.time() + 60):
        lg = run(['docker', 'logs', '--tail', '40', 'searxng'], merge=True)
        print((lg.stdout or '')[-3000:])
        sys.exit('container never became ready')
    print('container up')


def query(q):
    url = BASE + '/search?q=' + urllib.parse.quote(q) + '&format=json'
    t0 = time.time()
    with urlopen_np(url) as r:
        return json.loads(r.read().decode('utf-8')), int((time.time() - t0) * 1000)


def main():
    if '--no-install' not in sys.argv:
        install()

    try:
        cfg = json.loads(urlopen_np(BASE + '/config').read().decode('utf-8'))
    except Exception as exc:
        sys.exit('cannot read /config: %s' % exc)

    entries = cfg.get('engines', [])
    names = [e['name'] for e in entries]
    cats = dict((e['name'], list(e.get('categories', []))) for e in entries)
    print()
    print('=' * 74)
    print('REGISTERED ENGINES (%d)' % len(names))
    print('=' * 74)
    for e in entries:
        print('  %-16s %-16s %s' % (e['name'], ','.join(e.get('categories', [])),
                                    'on' if e.get('enabled', True) else 'OFF'))
    print()

    results = {}
    for tag, q in QUERIES:
        print('=' * 74)
        print('[%s] %s   x%d' % (tag, q, REPEATS))
        print('=' * 74)
        per_run = []
        titles = {}
        lat = []
        for i in range(1, REPEATS + 1):
            try:
                body, ms = query(q)
            except Exception as exc:
                print('  run %d: FAILED %s' % (i, exc))
                per_run.append({})
                continue
            lat.append(ms)
            counts = {}
            for r in body.get('results', []):
                for e in r.get('engines', []) or ['?']:
                    counts[e] = counts.get(e, 0) + 1
                    titles.setdefault(e, [])
                    t = (r.get('title') or '').strip()[:64]
                    if t and t not in titles[e]:
                        titles[e].append(t)
            per_run.append(counts)
            print('  run %d: %3d results  %5d ms  %s'
                  % (i, len(body.get('results', [])), ms,
                     ' '.join('%s=%d' % (k, v) for k, v in
                              sorted(counts.items(), key=lambda kv: -kv[1]))))
        if lat:
            print('  latency: min %d / max %d ms' % (min(lat), max(lat)))
        print()
        for name in names:
            seq = [r.get(name, 0) for r in per_run]
            results.setdefault(name, {})[tag] = seq
            shape = ''
            if 'general' not in cats.get(name, []):
                shape = '   [category=%s -> never selected by a plain query]' \
                        % ','.join(cats.get(name, []))
            print('  %-16s %s%s' % (name, seq, shape))
            for t in titles.get(name, [])[:2]:
                print('        - %s' % t)
        print()

    # ---- rate-limit recovery -------------------------------------------------
    # Engines here stop answering after a few queries and report no error when
    # they do, which makes "is this a dead engine or an exhausted quota?" the
    # single most operationally important question. Answer it by waiting.
    tag, q = QUERIES[0]
    print('=' * 74)
    print('RATE-LIMIT RECOVERY: waiting 150 s, then re-issuing the Chinese query')
    print('=' * 74)
    time.sleep(150)
    after = []
    for i in range(3):
        try:
            body, ms = query(q)
        except Exception as exc:
            print('  post-wait run %d: FAILED %s' % (i + 1, exc))
            after.append({})
            continue
        counts = {}
        for r in body.get('results', []):
            for e in r.get('engines', []) or ['?']:
                counts[e] = counts.get(e, 0) + 1
        after.append(counts)
        print('  post-wait run %d: %3d results  %5d ms  %s'
              % (i + 1, len(body.get('results', [])), ms,
                 ' '.join('%s=%d' % (k, v) for k, v in
                          sorted(counts.items(), key=lambda kv: -kv[1]))))
    print()

    print('=' * 74)
    print('FINAL VERDICT')
    print('=' * 74)
    for name in names:
        zh = results[name].get('zh', [])
        post = [r.get(name, 0) for r in after]
        if 'general' not in cats.get(name, []):
            verdict = ('NOT SELECTED -- category is %s, so a plain query never '
                       'runs it. Force categories: [general] or drop it.'
                       % ','.join(cats.get(name, [])))
        elif not any(zh) and not any(post):
            verdict = 'DEAD -- 0 results in every run, including after a 150 s wait'
        elif len(set(zh)) == 1 and zh[0] > 0:
            verdict = 'STABLE -- %d results on every run' % zh[0]
        elif any(zh) and not any(post):
            verdict = ('RATE-LIMITED -- answered %d..%d then went to 0 and did '
                       'not recover after 150 s' % (min(v for v in zh if v),
                                                    max(zh)))
        else:
            verdict = ('FLAKY -- %s, recovered to %s after the wait'
                       % (zh, post))
        print('  %-16s %s' % (name, verdict))
        print('       zh runs %s  |  after 150 s wait %s' % (zh, post))


if __name__ == '__main__':
    main()
