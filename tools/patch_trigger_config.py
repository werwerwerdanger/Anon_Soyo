# -*- coding: utf-8 -*-
"""Switch both MimirLink instances to name-triggered group replies, and turn on
group-repeat observation so the bot can see group chatter it was not @-ed in.

Why these keys
--------------
buildRoutingDecision() (src/index.js:1594) is the only gate on messages:

    if (event.message_type === 'group') {
        if (messageInfo.replyToBot)     return accept();        // always wins
        if (triggerMode === 'always')   return accept();
        if (triggerMode === 'prefix')   { ... }
        if (triggerMode === 'keyword')  { hasKeyword || isAtMe -> accept }
        if (requireAtInGroup)           { at || prefix || keyword, else skip }
        if (hasPrefix) return accept('prefix');
        if (hasKeyword) return accept('keyword');   // <-- how the name pulls it in
        if (isAtMe)    return accept('at');
        return skip('group_no_trigger_matched');
    }
    // ... private falls through to: return accept('private')

DELIBERATELY NOT triggerMode='keyword'. That branch is checked for private
messages too (`if (triggerMode === 'keyword') return hasKeyword ? ... :
skip('private_keyword_required')`), so switching modes would make the bot ignore
DMs unless they contain its name. `auto` + requireAtInGroup:false gives the same
group behaviour (keyword OR @) while leaving 1:1 chat always answered.
verify_trigger_routing.mjs pins this down with a private-message case.

With the old `auto` + `requireAtInGroup: true`, a group message had to @ the bot
(or reply to it) to get any attention. Worse: index.js:4045 returns early when
routing says no, so those messages never reach sessionManager.addMessage() --
the bot had zero memory of the group.

groupRepeat is the cheap half. With it on, un-triggered group messages are still
enqueued and written to history, but index.js:3377 bails out before the LLM call
(`if (!shouldRunLlm) return`), and a detected repeat is sent directly
(index.js:3370 '[复读] 群聊复读已直发，跳过 LLM'). So group awareness costs zero
tokens; only actual replies cost anything.

NOTE: loadConfig() runs once at startup (src/index.js:1687) and there is no
file watcher, so editing config.json requires a process restart.

Usage:
    python patch_trigger_config.py [--dry-run] [--revert]
"""
import argparse
import json
import pathlib
import shutil
import time

HERE = pathlib.Path(__file__).resolve().parent
STATE_FILE = HERE / '.trigger_config_state.json'
STAMP = time.strftime('%Y%m%d-%H%M%S')

# Each instance answers to its OWN character's names. Two bots in one group both
# reacting to every name would be chaos, so no cross-triggering here.
TARGETS = [
    {
        'name': 'soyo',
        'config': pathlib.Path(r'C:\Users\20633\MimirLink-soyo\config.json'),
        'keywords': ['素世', '长崎素世', '素世酱', 'Soyorin', 'Soyo', 'soyo'],
    },
    {
        'name': 'anon',
        'config': pathlib.Path(r'C:\Users\20633\MimirLink\config.json'),
        'keywords': ['爱音', '千早爱音', '爱音酱', 'Anon', 'anon', 'Ano-chan'],
    },
]

# min triggerCount per normalizeGroupRepeatConfig() is 2; 3 needs three people
# echoing the same line, which is the classic QQ 复读机 threshold rather than an
# accident of two people typing "哈哈哈" at once.
GROUP_REPEAT = {'enabled': True, 'triggerCount': 3, 'cooldownMs': 180000}


def apply(cfg, target, dry):
    chat = cfg.setdefault('chat', {})
    before = {
        'triggerMode': chat.get('triggerMode'),
        'requireAtInGroup': chat.get('requireAtInGroup'),
        'triggerKeywords': chat.get('triggerKeywords'),
        'groupRepeat': chat.get('groupRepeat'),
    }
    chat['triggerMode'] = 'auto'
    chat['requireAtInGroup'] = False
    chat['triggerKeywords'] = list(target['keywords'])
    chat['groupRepeat'] = dict(GROUP_REPEAT)
    after = {
        'triggerMode': chat.get('triggerMode'),
        'requireAtInGroup': chat.get('requireAtInGroup'),
        'triggerKeywords': chat.get('triggerKeywords'),
        'groupRepeat': chat.get('groupRepeat'),
    }
    return before, after


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--revert', action='store_true')
    args = ap.parse_args()

    if args.revert:
        if not STATE_FILE.exists():
            print('no state file %s -- nothing to revert' % STATE_FILE.name)
            return 1
        state = json.loads(STATE_FILE.read_text(encoding='utf-8'))
        for rec in state['instances']:
            path = pathlib.Path(rec['config'])
            path.write_text(json.dumps(rec['before_doc'], ensure_ascii=False, indent=2) + '\n',
                            encoding='utf-8', newline='\n')
            print('reverted %s' % path)
        STATE_FILE.unlink()
        print('state file removed. RESTART both instances to apply.')
        return 0

    print('=' * 70)
    print('patch trigger config  dry-run=%s' % args.dry_run)
    print('=' * 70)

    records = []
    for target in TARGETS:
        path = target['config']
        if not path.exists():
            print('[SKIP] %s does not exist' % path)
            continue
        raw = path.read_text(encoding='utf-8')
        cfg = json.loads(raw)
        before, after = apply(cfg, target, args.dry_run)

        print('')
        print('%s -> %s' % (target['name'], path))
        for key in ('triggerMode', 'requireAtInGroup', 'triggerKeywords', 'groupRepeat'):
            print('  %-16s %s' % (key, before[key]))
            print('  %-16s -> %s' % ('', after[key]))

        if args.dry_run:
            print('  [dry-run] not written')
            continue

        shutil.copy2(path, path.with_name(path.name + '.bak-' + STAMP))
        path.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + '\n',
                        encoding='utf-8', newline='\n')

        # read-back verification: reparse, check intended values, and confirm
        # nothing outside chat.* moved.
        check = json.loads(path.read_text(encoding='utf-8'))
        cchat = check['chat']
        ok = (
            cchat['triggerMode'] == 'auto'
            and cchat['requireAtInGroup'] is False
            and cchat['triggerKeywords'] == list(target['keywords'])
            and cchat['groupRepeat']['enabled'] is True
            and cchat['groupRepeat']['triggerCount'] == 3
        )
        orig = json.loads(raw)
        same_shape = set(orig.keys()) == set(check.keys())
        # deep-compare everything except the four we touched
        stripped_o = json.loads(raw)
        stripped_n = json.loads(json.dumps(check))
        for doc in (stripped_o, stripped_n):
            for k in ('triggerMode', 'requireAtInGroup', 'triggerKeywords', 'groupRepeat'):
                doc['chat'].pop(k, None)
        untouched_equal = stripped_o == stripped_n
        print('  wrote, read-back OK=%s  top-level keys same=%s  rest untouched=%s'
              % (ok, same_shape, untouched_equal))
        if not (ok and same_shape and untouched_equal):
            print('  !! verification failed, restoring backup')
            shutil.copy2(path.with_name(path.name + '.bak-' + STAMP), path)
            return 1
        records.append({'config': str(path), 'before_doc': orig})

    if not args.dry_run and records:
        STATE_FILE.write_text(json.dumps({'stamp': STAMP, 'instances': records},
                                         ensure_ascii=False, indent=2), encoding='utf-8')
        print('')
        print('state saved -> %s (use --revert to undo)' % STATE_FILE.name)
        print('RESTART both MimirLink instances: loadConfig() runs only at startup.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
