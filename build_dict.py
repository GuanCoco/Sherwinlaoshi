#!/usr/bin/env python3
"""
Build sharded CC-CEDICT JSON dictionary from cedict_ts.u8.

Strategy:
- Split entries by first character's Unicode code point
- CJK Unified Ideographs (U+4E00–U+9FFF): 1024 chars per bucket → ~21 buckets
- Everything else (Latin, numbers, symbols): 1 bucket
- Each bucket → dict/00.json ~ dict/NN.json + dict/other.json
- dict/index.json maps the scheme for the frontend

Output format per shard (compact):
{
  "word": [["pinyin tone marks", "def1 / def2 / ...", "trad_if_different"]],
  ...
}

Usage:
  python build_dict.py
"""

import json
import os
import re
import sys


# ── tone conversion ──────────────────────────────────────────────

def num2mark(syl: str) -> str:
    """chuan2 → chuán; r5 → r (consonant, no mark)"""
    marks = {
        'a': 'aāáǎàa', 'e': 'eēéěèe', 'i': 'iīíǐìi',
        'o': 'oōóǒòo', 'u': 'uūúǔùu', 'v': 'üǖǘǚǜü',
    }
    m = re.match(r'^([a-zA-Z:]+)([1-5])$', syl)
    if not m:
        return syl.lower().replace('v', 'ü')
    v, t = m.groups()
    lv = v.lower()
    # find the vowel that carries the tone
    ti = 0
    if 'a' in lv:       ti = lv.index('a')
    elif 'e' in lv:     ti = lv.index('e')
    elif 'ou' in lv:    ti = lv.index('o')
    else:               ti = min(1, len(lv) - 1)

    target = lv[ti]
    if target not in marks:
        return v.lower().replace('v', 'ü')

    mc = marks[target][int(t)]
    out = []
    for i, c in enumerate(lv):
        out.append(mc if i == ti else c)
    return ''.join(out).replace('v', 'ü')


def pinyin_mark(raw: str) -> str:
    return ' '.join(num2mark(s) for s in raw.split())


# ── bucket assignment ────────────────────────────────────────────

BUCKET_SIZE = 1024
CJK_BASE    = 0x4E00   # start of CJK Unified Ideographs
CJK_END     = 0x9FFF   # end

def bucket_for_char(ch: str) -> int:
    """Return bucket index (0–N) or -1 for non-CJK."""
    cp = ord(ch)
    if CJK_BASE <= cp <= CJK_END:
        return (cp - CJK_BASE) // BUCKET_SIZE
    return -1

def bucket_name(idx: int) -> str:
    if idx < 0:
        return 'other'
    return f'{idx:02d}'


# ── main ─────────────────────────────────────────────────────────

def main():
    base = os.path.dirname(os.path.abspath(__file__))
    src  = os.path.join(base, 'dict', 'cedict_ts.u8')
    out  = os.path.join(base, 'dict')

    if not os.path.exists(src):
        print(f'ERROR: {src} not found!')
        sys.exit(1)

    print(f'Reading {src}  ({os.path.getsize(src)/1e6:.1f} MB) …')

    # buckets: { '00': {word: [[pinyin, defs, trad], …]}, … }
    buckets = {}
    pat = re.compile(r'^(\S+)\s+(\S+)\s+\[(.+?)\]\s+/(.+)/$')
    count = 0

    with open(src, 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line or line[0] == '#':
                continue
            m = pat.match(line)
            if not m:
                continue
            trad, simp, py_raw, defs_raw = m.groups()
            py   = pinyin_mark(py_raw)
            trad = trad if trad != simp else ''
            defs = defs_raw.replace('/', ' / ').strip()
            entry = [py, defs, trad]

            bname = bucket_name(bucket_for_char(simp[0]))
            if bname not in buckets:
                buckets[bname] = {}
            b = buckets[bname]
            if simp not in b:
                b[simp] = []
            b[simp].append(entry)
            count += 1

            if count % 40000 == 0:
                print(f'  {count:,} entries …')

    print(f'Parsed {count:,} entries across {len(buckets)} buckets')

    # ── write index ─────────────────────────────────────────────
    total_buckets = (CJK_END - CJK_BASE + 1 + BUCKET_SIZE - 1) // BUCKET_SIZE
    index = {
        'buckets': total_buckets,
        'base': CJK_BASE,
        'size': BUCKET_SIZE,
        'present': sorted(buckets.keys()),
    }
    idx_path = os.path.join(out, 'index.json')
    with open(idx_path, 'w', encoding='utf-8') as f:
        json.dump(index, f, ensure_ascii=False, separators=(',', ':'))
    print(f'  Index: {idx_path}')

    # ── write shards ────────────────────────────────────────────
    total_mb = 0
    for bname, data in sorted(buckets.items()):
        fpath = os.path.join(out, f'{bname}.json')
        with open(fpath, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, separators=(',', ':'))
        sz = os.path.getsize(fpath)
        total_mb += sz
        print(f'  {bname}.json: {len(data):>6} words  ({sz/1024:7.1f} KB)')

    print(f'\nTotal: {total_mb/1e6:.1f} MB across {len(buckets)} shards')
    print('Done! Refresh the page to use the sharded dictionary.')


if __name__ == '__main__':
    main()
