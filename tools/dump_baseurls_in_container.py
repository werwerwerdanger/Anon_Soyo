#!/usr/bin/env python3
"""Runs INSIDE the searxng container.

Authoritative base_url dump: ask SearXNG's own engine loader instead of
scraping module source (which misses generic 'xpath' / 'json_engine' engines
whose address lives in settings.yml rather than in Python).

Loads the IMAGE DEFAULT settings (/usr/local/searxng/searx/settings.yml), so
the local keep_only override does not hide anything.

Output: /tmp/baseurls.txt
"""
import sys

sys.path.insert(0, '/usr/local/searxng')

from searx import settings_loader  # noqa: E402
from searx.engines import load_engines, engines as ENGINES  # noqa: E402

DEFAULT_SETTINGS = '/usr/local/searxng/searx/settings.yml'

loaded = settings_loader.load_settings(DEFAULT_SETTINGS)
# some releases return (settings_dict, error_message), older ones the dict alone
settings = loaded[0] if isinstance(loaded, tuple) else loaded
load_engines(settings['engines'])

rows = []
for name, eng in sorted(ENGINES.items()):
    url = getattr(eng, 'base_url', None)
    search_url = getattr(eng, 'search_url', None)
    api_url = getattr(eng, 'api_url', None)
    # prefer base_url; fall back to search_url / api_url host
    target = url or api_url or ''
    if not target and search_url:
        target = search_url.split('{')[0]
    cat = ','.join(sorted(getattr(eng, 'categories', []) or []))
    rows.append((name, target or '-', cat))

with open('/tmp/baseurls.txt', 'w', encoding='utf-8') as f:
    f.write('total loaded = %d\n' % len(rows))
    for name, url, cat in rows:
        f.write('%-28s %-52s %s\n' % (name, url, cat))

print('loaded=%d' % len(rows))
