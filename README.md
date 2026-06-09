# Chinese Pinyin Annotator · 中文注音工具

A static web tool that adds pinyin annotations to Chinese text with CC-CEDICT dictionary lookup. Click any word to see definitions, pinyin, and hear pronunciation.

## Features

- **Pinyin Annotation** — Tone-colored pinyin above Chinese characters
- **Sharded Dictionary** — 22 shards loaded on-demand (no 10MB download at once)
- **Word Lookup** — Click/tap any word to see CC-CEDICT definitions
- **Pronunciation** — Speak button uses browser's Web Speech API
- **Font Size Control** — 5 levels (85%–155%)
- **Progress Bar** — Shows download/parsing progress
- **Responsive** — Desktop, tablet, mobile
- **No Backend** — Fully static, GitHub Pages ready

## Quick Start

### 1. Build the dictionary

```bash
python build_dict.py
```

This reads `dict/cedict_ts.u8` and generates:
- `dict/index.json` — shard index (0.2 KB)
- `dict/00.json` … `dict/20.json` + `dict/other.json` — 22 shard files

### 2. Run locally

```bash
python -m http.server 8080
```

Then open http://localhost:8080

### 3. Deploy to GitHub Pages

Push the repo → Settings → Pages → Source → `main` → Save

## File Structure

```
├── index.html
├── css/style.css
├── js/main.js
├── build_dict.py          ← Python build script (run once)
├── dict/
│   ├── cedict_ts.u8       ← CC-CEDICT raw dictionary (~10 MB)
│   ├── index.json         ← shard index (loaded first)
│   ├── 00.json … 20.json  ← CJK shards (150 KB–1.4 MB each)
│   └── other.json         ← non-CJK entries (35 KB)
└── README.md
```

## How Sharding Works

1. Page loads `dict/index.json` instantly (0.2 KB)
2. User types/enters Chinese text
3. JS scans the text, computes which Unicode-range buckets are needed
4. Only those shard files are fetched in parallel (typically 5–15 shards for a sentence)
5. Loaded shards are cached in memory — subsequent annotations with new characters load only the new shards

On GitHub Pages, each file is served with gzip, further reducing transfer size.

## Dictionary

[CC-CEDICT](https://cc-cedict.org/wiki/) — 125,000+ entries, community-maintained Chinese-English dictionary.

## License

MIT
