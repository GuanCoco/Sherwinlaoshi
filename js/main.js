/**
 * Chinese Pinyin Annotator
 * ========================
 * - Sharded CC-CEDICT dictionary (22 files, on-demand loading)
 * - Pinyin annotation via pinyin-pro (CDN)
 * - Word segmentation via FMM + dictionary
 * - Click → definition popover + pronunciation (Web Speech API)
 * - Font size controls
 * - Fully static, GitHub Pages ready
 */

/* ================================================================
   CONFIG
   ================================================================ */
const CFG = Object.freeze({
    DICT_DIR: 'dict',
    INDEX: 'dict/index.json',
    CJK_BASE: 0x4E00,
    CJK_BUCKET: 1024,
    CHINESE_RE: /[\u4e00-\u9fff\u3400-\u4dbf]/,
    POPOVER_W: 380,
    POPOVER_GAP: 8,
    FONT_SIZES: [0.85, 1, 1.15, 1.35, 1.55],
    FONT_DEFAULT: 2,
});

/* ================================================================
   STATE
   ================================================================ */
const S = {
    dict: new Map(),          // merged dictionary
    loaded: new Set(),        // bucket names already loaded
    bucketList: [],           // list of bucket names from index
    maxWordLen: 0,
    ready: false,
    active: null,
    fontSize: CFG.FONT_DEFAULT,
};

/* ================================================================
   DOM
   ================================================================ */
const E = {};
function byId(id) { return document.getElementById(id); }

/* ================================================================
   INIT
   ================================================================ */
window.addEventListener('DOMContentLoaded', () => {
    E.textIn     = byId('textInput');
    E.btnDo      = byId('btnAnnotate');
    E.btnClr     = byId('btnClear');
    E.btnEx      = byId('btnExample');
    E.btnCp      = byId('btnCopy');
    E.charCnt    = byId('charCount');
    E.dictBar    = byId('dictStatus');
    E.dictMsg    = byId('dictMsg');
    E.dictPct    = byId('dictPct');
    E.outSec     = byId('outputSection');
    E.ann        = byId('annotatedText');
    E.empty      = byId('emptyState');
    E.pop        = byId('popover');
    E.pw         = byId('popoverWord');
    E.pp         = byId('popoverPinyin');
    E.pd         = byId('popoverDefs');
    E.pSpk       = byId('popoverSpeak');
    E.pCls       = byId('popoverClose');
    E.pBd        = byId('popoverBackdrop');
    E.btnFm      = byId('btnFontMinus');
    E.btnFp      = byId('btnFontPlus');
    E.fsLabel    = byId('fontSizeLabel');

    bind();
    changeFont(0);
    loadIndex().then(() => E.ann && changeFont(0));
});

/* ================================================================
   EVENTS
   ================================================================ */
function bind() {
    E.textIn.addEventListener('input', onInput);
    E.btnDo.addEventListener('click', annotate);
    E.btnClr.addEventListener('click', clearAll);
    E.btnEx.addEventListener('click', loadEx);
    E.btnCp.addEventListener('click', copyOut);
    E.pSpk.addEventListener('click', e => { e.stopPropagation(); speak(); });
    E.pCls.addEventListener('click', hidePop);
    E.pBd.addEventListener('click', hidePop);
    E.btnFm.addEventListener('click', () => changeFont(-1));
    E.btnFp.addEventListener('click', () => changeFont(1));
    document.addEventListener('keydown', e => { if (e.key === 'Escape') hidePop(); });
    document.addEventListener('click', e => {
        if (E.pop.classList.contains('on') &&
            !e.target.closest('.wg') &&
            !e.target.closest('#popover'))
            hidePop();
    });
    window.addEventListener('resize', () => {
        if (E.pop.classList.contains('on') && S.active) placePop(S.active);
    });
}

/* ================================================================
   DICTIONARY LOADING  (index → shards on demand)
   ================================================================ */
function setDict(text, pct) {
    E.dictMsg.textContent = text;
    if (pct === null) {
        E.dictPct.textContent = '';
        E.dictBar.style.width = '100%';
    } else {
        E.dictPct.textContent = pct + '%';
        E.dictBar.style.width = pct + '%';
    }
}

async function loadIndex() {
    setDict('Loading index…', null);
    try {
        const r = await fetch(CFG.INDEX);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const idx = await r.json();
        S.bucketList = idx.present; // e.g. ['00','01',…,'other']
        setDict('Ready — enter text to load needed shards', null);
    } catch (e) {
        console.error(e);
        setDict('Index not found. Run build_dict.py first.', null);
    }
}

/** Return bucket name for a character */
function bucketOf(ch) {
    const cp = ch.codePointAt(0);
    if (cp >= CFG.CJK_BASE && cp <= 0x9FFF) {
        return String(Math.floor((cp - CFG.CJK_BASE) / CFG.CJK_BUCKET)).padStart(2, '0');
    }
    // Check CJK Extension A
    if (cp >= 0x3400 && cp <= 0x4DBF) {
        return String(21 + Math.floor((cp - 0x3400) / CFG.CJK_BUCKET)).padStart(2, '0');
    }
    return 'other';
}

/** Load all buckets needed for the given text */
async function loadNeeded(text) {
    const needed = new Set();
    for (const ch of text) {
        if (CFG.CHINESE_RE.test(ch)) needed.add(bucketOf(ch));
    }
    // Also always load 'other' for Latin entries
    needed.add('other');

    const toLoad = [...needed].filter(b => !S.loaded.has(b) && S.bucketList.includes(b));
    if (toLoad.length === 0) return;

    const total = toLoad.length;
    let done = 0;
    setDict(`Loading ${total} shard${total>1?'s':''}…`, 0);

    // Load in parallel
    await Promise.all(toLoad.map(async bname => {
        try {
            const r = await fetch(`${CFG.DICT_DIR}/${bname}.json`);
            if (!r.ok) throw new Error('HTTP ' + r.status);
            const data = await r.json();
            mergeShard(data);
            S.loaded.add(bname);
            done++;
            setDict(`Loading shards…`, Math.round(done / total * 100));
        } catch (e) {
            console.warn('Shard ' + bname + ':', e.message);
        }
    }));

    setDict(`Ready · ${S.dict.size.toLocaleString()} words`, null);
}

/** Merge a shard's entries into S.dict */
function mergeShard(shard) {
    for (const [word, items] of Object.entries(shard)) {
        const entries = items.map(([py, defs, trad]) => ({
            p: py,
            d: defs.split(' / ').filter(Boolean),
            t: trad || '',
        }));
        if (S.dict.has(word)) {
            S.dict.get(word).push(...entries);
        } else {
            S.dict.set(word, entries);
        }
        if (word.length > S.maxWordLen) S.maxWordLen = word.length;
    }
}

/* ================================================================
   TEXT INPUT
   ================================================================ */
function onInput() {
    const t = E.textIn.value;
    const cn = (t.match(CFG.CHINESE_RE) || []).length;
    E.charCnt.textContent = cn ? `${cn} Chinese (${t.length} total)` : `${t.length} chars`;
    if (E.outSec.style.display !== 'none') {
        E.outSec.style.display = 'none';
        E.empty.style.display = '';
    }
    hidePop();
}

function clearAll() {
    E.textIn.value = '';
    E.charCnt.textContent = '0 chars';
    E.outSec.style.display = 'none';
    E.empty.style.display = '';
    E.ann.innerHTML = '';
    hidePop();
}

function loadEx() {
    const ex = [
        '今天天气真好，我想出去散步。',
        '人工智能正在改变我们的生活方式。',
        '学习中文需要持之以恒的努力和练习。',
        '北京大学是中国最著名的大学之一。',
        '他从小就对中国传统文化非常感兴趣。',
        '随着科技的发展，我们的生活变得越来越方便。',
        '这个餐厅的菜很好吃，环境也不错。',
        '读书破万卷，下笔如有神。',
    ];
    E.textIn.value = ex[Math.floor(Math.random() * ex.length)];
    E.textIn.dispatchEvent(new Event('input'));
    setTimeout(annotate, 200);
}

/* ================================================================
   ANNOTATION PIPELINE
   ================================================================ */
async function annotate() {
    const text = E.textIn.value.trim();
    if (!text) return E.textIn.focus();
    hidePop();

    // Load needed dictionary shards
    await loadNeeded(text);

    // character-level pinyin
    let cpy = null;
    if (typeof pinyinPro !== 'undefined') {
        try {
            cpy = pinyinPro.pinyin(text, { toneType: 'symbol', type: 'array' });
        } catch (_) {}
    }

    const segs = segment(text);
    render(segs, cpy);
    E.outSec.style.display = '';
    E.empty.style.display = 'none';
}

/* ================================================================
   WORD SEGMENTATION  (FMM)
   ================================================================ */
function segment(text) {
    const out = [];
    let i = 0;
    while (i < text.length) {
        if (!CFG.CHINESE_RE.test(text[i])) {
            let j = i + 1;
            while (j < text.length && !CFG.CHINESE_RE.test(text[j])) j++;
            const chunk = text.slice(i, j);
            if (/^\s+$/.test(chunk)) {
                for (let k = 0; k < chunk.length; k++) out.push({ t: chunk[k], ty: 'sp' });
            } else {
                out.push({ t: chunk, ty: 'ot' });
            }
            i = j;
            continue;
        }
        // Forward Maximum Matching
        let hit = null;
        const lim = Math.min(S.maxWordLen || 6, text.length - i);
        for (let len = lim; len >= 1; len--) {
            const w = text.slice(i, i + len);
            if (S.dict.has(w)) { hit = w; break; }
        }
        if (hit) {
            out.push({ t: hit, ty: 'wd', e: S.dict.get(hit) });
            i += hit.length;
        } else {
            out.push({ t: text[i], ty: 'ch' });
            i++;
        }
    }
    return out;
}

/* ================================================================
   RENDER
   ================================================================ */
function render(segs, cpy) {
    E.ann.innerHTML = '';
    let pi = 0;
    for (const s of segs) {
        if (s.ty === 'sp') {
            const el = d('span', 'oc sp'); el.textContent = s.t; E.ann.appendChild(el);
            continue;
        }
        if (s.ty === 'ot') {
            const el = d('span', 'oc'); el.textContent = s.t; E.ann.appendChild(el);
            pi += s.t.length;
            continue;
        }
        E.ann.appendChild(buildGroup(s, cpy, pi));
        pi += s.t.length;
    }
}

function buildGroup(seg, cpy, start) {
    const g = d('span', 'wg');
    g.dataset.word = seg.t;

    // pinyin row
    const ps = d('span', 'pinyin');
    if (cpy && cpy.length > start) {
        for (let i = 0; i < seg.t.length; i++) {
            const py = cpy[start + i] || seg.t[i];
            const s = d('span', 't' + toneOf(py));
            s.textContent = py;
            if (i > 0) ps.append(' ');
            ps.appendChild(s);
        }
    } else if (seg.e && seg.e.length) {
        ps.textContent = seg.e[0].p;
    } else {
        ps.innerHTML = '&nbsp;';
    }

    // hanzi row
    const hs = d('span', 'hanzi');
    hs.textContent = seg.t;

    g.append(ps, hs);

    g.addEventListener('click', e => {
        e.stopPropagation();
        let entries = seg.e;
        if (!entries && S.dict.size) entries = S.dict.get(seg.t);
        if (entries) showPop(g, seg.t, entries);
    });
    g.addEventListener('touchend', e => { e.preventDefault(); g.click(); });

    return g;
}

function d(tag, cls) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    return el;
}

/* ================================================================
   POPOVER
   ================================================================ */
function showPop(el, word, entries) {
    if (S.active) S.active.classList.remove('on');
    S.active = el;
    el.classList.add('on');

    E.pw.textContent = word;
    E.pp.textContent = [...new Set(entries.map(e => e.p))].join('  |  ');
    E.pd.innerHTML = '';

    entries.forEach((entry, idx) => {
        if (idx > 0) E.pd.appendChild(d('div', 'pd'));
        const h = d('div', 'di pl');
        h.textContent = '[' + entry.p + ']';
        E.pd.appendChild(h);
        if (entry.t) {
            const td = d('div', 'di');
            td.textContent = '繁体: ' + entry.t;
            E.pd.appendChild(td);
        }
        entry.d.forEach(def => {
            const dd = d('div', 'di');
            dd.textContent = def;
            E.pd.appendChild(dd);
        });
    });

    E.pBd.style.display = '';
    E.pop.style.display = '';
    void E.pop.offsetHeight;
    E.pop.classList.add('on');
    placePop(el);
}

function placePop(el) {
    const r = el.getBoundingClientRect();
    const pr = E.pop.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;

    if (vw <= 480) {
        E.pop.style.cssText = 'left:0;right:0;bottom:0;top:auto;max-width:100vw;border-radius:18px 18px 0 0;';
        return;
    }

    let l = r.left + r.width / 2 - pr.width / 2;
    let t = r.top - pr.height - CFG.POPOVER_GAP;
    if (l < 10) l = 10;
    if (l + pr.width > vw - 10) l = vw - pr.width - 10;
    if (t < 10) t = r.bottom + CFG.POPOVER_GAP;
    if (t + pr.height > vh - 10) t = vh - pr.height - 10;

    E.pop.style.cssText = `left:${l}px;top:${t}px;bottom:auto;right:auto;max-width:${CFG.POPOVER_W}px;border-radius:14px;`;
}

function hidePop() {
    E.pop.classList.remove('on');
    E.pBd.style.display = 'none';
    setTimeout(() => { if (!E.pop.classList.contains('on')) E.pop.style.display = 'none'; }, 260);
    if (S.active) { S.active.classList.remove('on'); S.active = null; }
}

/* ================================================================
   PRONUNCIATION  (Web Speech API)
   ================================================================ */
function speak() {
    if (!('speechSynthesis' in window)) return;
    const w = E.pw.textContent;
    if (!w) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(w);
    u.lang = 'zh-CN'; u.rate = 0.85;
    E.pSpk.classList.add('spk');
    u.onend = u.onerror = () => E.pSpk.classList.remove('spk');
    speechSynthesis.speak(u);
}

/* ================================================================
   FONT SIZE
   ================================================================ */
function changeFont(dir) {
    S.fontSize = Math.max(0, Math.min(CFG.FONT_SIZES.length - 1, S.fontSize + dir));
    const sz = CFG.FONT_SIZES[S.fontSize];
    if (E.ann) E.ann.style.fontSize = sz + 'rem';
    if (E.fsLabel) E.fsLabel.textContent = Math.round(sz * 100) + '%';
    if (E.btnFm) E.btnFm.disabled = S.fontSize === 0;
    if (E.btnFp) E.btnFp.disabled = S.fontSize === CFG.FONT_SIZES.length - 1;
}

/* ================================================================
   COPY
   ================================================================ */
function copyOut() {
    const t = E.ann.innerText;
    if (!t.trim()) return;
    navigator.clipboard.writeText(t).then(() => {
        const o = E.btnCp.innerHTML;
        E.btnCp.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg> Copied!';
        setTimeout(() => { E.btnCp.innerHTML = o; }, 1800);
    }).catch(() => {
        const r = document.createRange(); r.selectNodeContents(E.ann);
        const s = getSelection(); s.removeAllRanges(); s.addRange(r);
        document.execCommand('copy'); s.removeAllRanges();
    });
}

/* ================================================================
   UTILS
   ================================================================ */
function toneOf(syl) {
    if (!syl) return 5;
    if (/[āēīōūǖĀĒĪŌŪǕ]/.test(syl)) return 1;
    if (/[áéíóúǘÁÉÍÓÚǗ]/.test(syl)) return 2;
    if (/[ǎěǐǒǔǚǍĚǏǑǓǙ]/.test(syl)) return 3;
    if (/[àèìòùǜÀÈÌÒÙǛ]/.test(syl)) return 4;
    return 5;
}
