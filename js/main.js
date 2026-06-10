/**
 * Chinese Pinyin Annotator
 * Sharded CC-CEDICT + IndexedDB cache + font slider + tone toggle
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
    DB_NAME: 'pinyin_dict',
    DB_VERSION: 1,
    DB_STORE: 'shards',
    FONT_MIN: 100,
    FONT_MAX: 250,
    FONT_DEFAULT: 100,
});

/* ================================================================
   STATE
   ================================================================ */
const S = {
    dict: new Map(),
    loaded: new Set(),
    bucketList: [],
    maxWordLen: 0,
    ready: false,
    active: null,
    fontSize: CFG.FONT_DEFAULT,
    toneColor: true,
    hasNativeVoice: false,  // preloaded on init
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
    E.btnCpPy    = byId('btnCopyPinyin');
    E.btnCpHan    = byId('btnCopyHanzi');
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
    E.slider     = byId('fontSlider');
    E.slVal      = byId('fontSliderVal');
    E.toneToggle = byId('toneToggle');

    bind();
    initSlider();
    loadVoices();  // preload for China (no VPN needed)
    loadDict();
});

/* ================================================================
   EVENTS
   ================================================================ */
function bind() {
    E.textIn.addEventListener('input', onInput);
    E.btnDo.addEventListener('click', annotate);
    E.btnClr.addEventListener('click', clearAll);
    E.btnEx.addEventListener('click', loadEx);
    E.btnCpPy.addEventListener('click', () => copyPinyin());
    E.btnCpHan.addEventListener('click', () => copyHanzi());
    E.pSpk.addEventListener('click', e => { e.stopPropagation(); speak(); });
    E.pCls.addEventListener('click', hidePop);
    E.pBd.addEventListener('click', hidePop);
    E.toneToggle.addEventListener('change', onToneToggle);
    document.addEventListener('keydown', e => { if (e.key === 'Escape') hidePop(); });
    document.addEventListener('click', e => {
        if (E.pop && E.pop.classList.contains('on') &&
            !e.target.closest('.wg') &&
            !e.target.closest('#popover'))
            hidePop();
    });
    window.addEventListener('resize', () => {
        if (E.pop && E.pop.classList.contains('on') && S.active) placePop(S.active);
    });
}

/* ================================================================
   INDEXEDDB CACHE
   ================================================================ */
function openDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(CFG.DB_NAME, CFG.DB_VERSION);
        req.onupgradeneeded = () => {
            req.result.createObjectStore(CFG.DB_STORE);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function cacheGet(key) {
    try {
        const db = await openDB();
        return new Promise(resolve => {
            const tx = db.transaction(CFG.DB_STORE, 'readonly');
            const req = tx.objectStore(CFG.DB_STORE).get(key);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => resolve(null);
        });
    } catch { return null; }
}

async function cacheSet(key, data) {
    try {
        const db = await openDB();
        return new Promise(resolve => {
            const tx = db.transaction(CFG.DB_STORE, 'readwrite');
            tx.objectStore(CFG.DB_STORE).put(data, key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => resolve();
        });
    } catch {}
}

async function cacheDel(key) {
    try {
        const db = await openDB();
        return new Promise(resolve => {
            const tx = db.transaction(CFG.DB_STORE, 'readwrite');
            tx.objectStore(CFG.DB_STORE).delete(key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => resolve();
        });
    } catch {}
}

/* ================================================================
   DICTIONARY LOADING
   ================================================================ */
function setDict(msg, pct) {
    if (!E.dictMsg) return;
    E.dictMsg.textContent = msg;
    if (pct === null) {
        E.dictPct.style.width = '100%';
    } else {
        E.dictPct.style.width = pct + '%';
    }
}

async function loadDict() {
    setDict('Loading index…', null);

    let index;
    try {
        const r = await fetch(CFG.INDEX);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        index = await r.json();
    } catch (e) {
        console.error(e);
        setDict('Index not found. Run build_dict.py.', null);
        return;
    }

    S.bucketList = index.present;

    // Check IndexedDB for previously cached shards
    let cachedCount = 0;
    for (const bname of S.bucketList) {
        const cached = await cacheGet('shard_' + bname);
        if (cached) {
            mergeShard(cached);
            S.loaded.add(bname);
            cachedCount++;
        }
    }

    if (cachedCount > 0) {
        setDict('Ready · ' + S.dict.size.toLocaleString() + ' words (cached)', null);
    } else {
        setDict('Ready — enter text to load needed shards', null);
    }
}

function bucketOf(ch) {
    const cp = ch.codePointAt(0);
    if (cp >= CFG.CJK_BASE && cp <= 0x9FFF) {
        return String(Math.floor((cp - CFG.CJK_BASE) / CFG.CJK_BUCKET)).padStart(2, '0');
    }
    if (cp >= 0x3400 && cp <= 0x4DBF) {
        return String(21 + Math.floor((cp - 0x3400) / CFG.CJK_BUCKET)).padStart(2, '0');
    }
    return 'other';
}

async function loadNeeded(text) {
    const needed = new Set();
    for (const ch of text) {
        if (CFG.CHINESE_RE.test(ch)) needed.add(bucketOf(ch));
    }
    needed.add('other');

    const toLoad = [...needed].filter(b => !S.loaded.has(b) && S.bucketList.includes(b));
    if (toLoad.length === 0) return;

    const total = toLoad.length;
    let done = 0;
    setDict('Loading ' + total + ' shard' + (total > 1 ? 's' : '') + '…', 0);

    await Promise.all(toLoad.map(async bname => {
        try {
            const r = await fetch(CFG.DICT_DIR + '/' + bname + '.json');
            if (!r.ok) throw new Error('HTTP ' + r.status);
            const data = await r.json();
            mergeShard(data);
            S.loaded.add(bname);
            // Cache in IndexedDB for next visit
            cacheSet('shard_' + bname, data);
            done++;
            setDict('Loading…', Math.round(done / total * 100));
        } catch (e) {
            console.warn('Shard ' + bname + ':', e.message);
        }
    }));

    setDict('Ready · ' + S.dict.size.toLocaleString() + ' words', null);
}

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
    E.charCnt.textContent = cn ? cn + ' Chinese (' + t.length + ' total)' : t.length + ' chars';
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
   ANNOTATION
   ================================================================ */
async function annotate() {
    const text = E.textIn.value.trim();
    if (!text) return E.textIn.focus();
    hidePop();

    await loadNeeded(text);

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

    const ps = d('span', 'pinyin');
    if (cpy && cpy.length > start) {
        for (let i = 0; i < seg.t.length; i++) {
            const py = cpy[start + i] || seg.t[i];
            const s = d('span', S.toneColor ? 't' + toneOf(py) : 'tn');
            s.textContent = py;
            if (i > 0) ps.append(' ');
            ps.appendChild(s);
        }
    } else if (seg.e && seg.e.length) {
        ps.textContent = seg.e[0].p;
    } else {
        ps.innerHTML = '&nbsp;';
    }

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
            td.textContent = 'Traditional: ' + entry.t;
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
    if (!el) return;
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

    E.pop.style.cssText = 'left:' + l + 'px;top:' + t + 'px;bottom:auto;right:auto;max-width:' + CFG.POPOVER_W + 'px;border-radius:14px;';
}

function hidePop() {
    if (E.pop) E.pop.classList.remove('on');
    if (E.pBd) E.pBd.style.display = 'none';
    setTimeout(() => {
        if (E.pop && !E.pop.classList.contains('on')) E.pop.style.display = 'none';
    }, 260);
    if (S.active) { S.active.classList.remove('on'); S.active = null; }
}

/* ================================================================
   PRONUNCIATION
   ================================================================ */
/* ================================================================
   PRONUNCIATION  (Microsoft Edge TTS — free, works in China & abroad)
   ================================================================ */
const MS_TTS_URL = 'https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1';
const MS_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';

async function msTTS(text) {
    const ssml = `<speak version='1.0' xml:lang='zh-CN'>` +
        `<voice name='zh-CN-XiaoxiaoNeural'>${text}</voice>` +
        `</speak>`;
    const url = `${MS_TTS_URL}?TrustedClientToken=${MS_TOKEN}`;
    try {
        const r = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/ssml+xml',
                'X-Microsoft-OutputFormat': 'audio-16khz-32kbitrate-mono-mp3',
            },
            body: ssml,
        });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const blob = await r.blob();
        return URL.createObjectURL(blob);
    } catch (_) { return null; }
}

function loadVoices() {
    // Stub — not needed with MS Edge TTS
    S.hasNativeVoice = false;
}

function speak() {
    const w = E.pw.textContent;
    if (!w) return;
    E.pSpk.classList.add('spk');
    const done = () => E.pSpk.classList.remove('spk');

    msTTS(w).then(url => {
        if (url) {
            const a = new Audio(url);
            a.onended = done;
            a.onerror = () => { done(); URL.revokeObjectURL(url); };
            a.play();
        } else {
            // All online TTS failed — try Web Speech as last resort
            if ('speechSynthesis' in window) {
                speechSynthesis.cancel();
                const u = new SpeechSynthesisUtterance(w);
                u.lang = 'zh-CN'; u.rate = 0.85;
                u.onend = u.onerror = done;
                speechSynthesis.speak(u);
            } else { done(); }
        }
    });
}

/* ================================================================
   FONT SLIDER
   ================================================================ */
function initSlider() {
    E.slider.value = S.fontSize;
    E.slVal.textContent = S.fontSize + '%';
    if (E.ann) E.ann.style.fontSize = (S.fontSize / 100) + 'rem';
    E.slider.addEventListener('input', () => {
        S.fontSize = parseInt(E.slider.value);
        E.slVal.textContent = S.fontSize + '%';
        if (E.ann) E.ann.style.fontSize = (S.fontSize / 100) + 'rem';
    });
}

/* ================================================================
   TONE COLOR TOGGLE
   ================================================================ */
function onToneToggle() {
    S.toneColor = !E.toneToggle.checked;
    // Re-render if output is visible
    if (E.outSec.style.display !== 'none' && E.textIn.value.trim()) {
        annotate();
    }
}

/* ================================================================
   COPY
   ================================================================ */
function copyPinyin() {
    // Collect just the pinyin text
    let parts = [];
    const groups = E.ann.querySelectorAll('.wg');
    groups.forEach(g => {
        const py = g.querySelector('.pinyin');
        if (py) parts.push(py.textContent.trim());
    });
    const text = parts.join(' ');
    if (!text) return;

    navigator.clipboard.writeText(text).then(() => flashBtn(E.btnCpPy));
}

function copyHanzi() {
    const text = E.ann.innerText;
    if (!text.trim()) return;
    navigator.clipboard.writeText(text).then(() => flashBtn(E.btnCpHan));
}

function flashBtn(btn) {
    const orig = btn.textContent;
    btn.textContent = 'Copied!';
    btn.style.color = '#22c55e';
    setTimeout(() => { btn.textContent = orig; btn.style.color = ''; }, 1500);
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
