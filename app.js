/* 單字特訓 — 選擇題 / 拼字 (FSRS 排程) + 克漏字(短文 / 單句)。
   One word list (data/words.json) and one cloze file (data/cloze.json), both built from the textbook by tools/. */
'use strict';

/* ---------- helpers ---------- */
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const DAY = 86400000;
const pad = n => String(n).padStart(2, '0');
const dayKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const FILES = { words: 'data/words.json', cloze: 'data/cloze.json' };
const MODES = { mcq: '選擇題', spell: '拼字' };
const KINDS = { all: '全部', passage: '短文克漏字', sentence: '單句克漏字' };
const EXAM_PRESETS = [
  { name: '段考', date: '' },
  { name: '期中考', date: '' },
  { name: '期末考', date: '' },
  { name: '學測', date: '2027-01-22' },
  { name: '國中會考', date: '' },
];
const DEFAULTS = { newPerDay: 20, sessionSize: 20, retention: 0.9, examName: '段考', examDate: '', progressDays: 0, bank: null, ranges: {}, lastBackupAt: 0 };

/* ---------- storage (IndexedDB, with in-memory fallback) ----------
   NOTE: every GitHub Pages site of the same account shares one browser origin, so the database name must be unique to this app. */
const DB_NAME = 'book3-v1', BACKUP_TAG = 'book3';
const store = (() => {
  let db = null; const mem = { cards: new Map(), logs: [], kv: new Map(), q: new Map() }; let volatile = false;
  const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  async function init() {
    try {
      if (!window.indexedDB) throw new Error('no idb');
      db = await new Promise((res, rej) => {
        const o = indexedDB.open(DB_NAME, 1);
        o.onupgradeneeded = () => {
          const d = o.result;
          d.createObjectStore('cards', { keyPath: 'id' });
          d.createObjectStore('logs', { autoIncrement: true });
          d.createObjectStore('kv');
          d.createObjectStore('qstats', { keyPath: 'id' });
        };
        o.onsuccess = () => res(o.result); o.onerror = () => rej(o.error);
      });
    } catch (e) { volatile = true; db = null; }
    try { navigator.storage?.persist?.(); } catch (e) { /* ignore */ }
  }
  const tx = (name, mode = 'readonly') => db.transaction(name, mode).objectStore(name);
  return {
    init, get volatile() { return volatile; },
    async allCards() { if (!db) return new Map(mem.cards); const list = await req(tx('cards').getAll()); return new Map(list.map(c => [c.id, c])); },
    async putCard(c) { if (!db) { mem.cards.set(c.id, c); return; } await req(tx('cards', 'readwrite').put(c)); },
    async allQ() { if (!db) return new Map(mem.q); const list = await req(tx('qstats').getAll()); return new Map(list.map(c => [c.id, c])); },
    async putQ(c) { if (!db) { mem.q.set(c.id, c); return; } await req(tx('qstats', 'readwrite').put(c)); },
    async addLog(l) { if (!db) { mem.logs.push(l); return; } await req(tx('logs', 'readwrite').add(l)); },
    async allLogs() { if (!db) return mem.logs.slice(); return req(tx('logs').getAll()); },
    async getKV(k) { if (!db) return mem.kv.get(k); return req(tx('kv').get(k)); },
    async setKV(k, v) { if (!db) { mem.kv.set(k, v); return; } await req(tx('kv', 'readwrite').put(v, k)); },
    async clear() {
      if (!db) { mem.cards.clear(); mem.logs = []; mem.kv.clear(); mem.q.clear(); return; }
      for (const n of ['cards', 'logs', 'kv', 'qstats']) await req(tx(n, 'readwrite').clear());
    },
    async exportAll() {
      return { app: BACKUP_TAG, version: 1, exportedAt: Date.now(), cards: [...(await this.allCards()).values()], qstats: [...(await this.allQ()).values()], logs: await this.allLogs(), settings: await this.getKV('settings'), daily: await this.getKV('daily') };
    },
    async importAll(o) {
      if (!o || o.app !== BACKUP_TAG) throw new Error('不是本 App 匯出的備份檔');
      await this.clear();
      for (const c of o.cards || []) await this.putCard(c);
      for (const c of o.qstats || []) await this.putQ(c);
      for (const l of o.logs || []) await this.addLog(l);
      if (o.settings) await this.setKV('settings', o.settings);
      if (o.daily) await this.setKV('daily', o.daily);
    },
  };
})();

/* ---------- state ---------- */
const S = {
  settings: { ...DEFAULTS }, daily: {}, byDay: new Map(), cards: new Map(), words: [], meta: {}, cmeta: {},
  tab: 'home', landing: true, session: null, fsrs: null, questions: [], qstats: new Map(), pview: 'main', punit: null, pkind: 'all',
};
const wordById = {}, qById = {};
const cardId = (wid, type) => `${type}:${wid}`; // type = 'mcq' | 'spell' (each mode has its own FSRS card per word)
/* Correct answers per day PER WORD BANK (今天答對 + 星星日曆). Not stored: rebuilt from the review log at boot (so it also covers
   older days) and bumped live. S.daily[..].correct (both banks together) is still written exactly as before. */
function noteDay(ts, bank, ok) { if (!ok || !bank) return; const k = dayKey(new Date(ts)), m = S.byDay.get(k) || {}; m[bank] = (m[bank] || 0) + 1; S.byDay.set(k, m); }
const correctOn = (k, bank = curBank()) => S.byDay.get(k)?.[bank] || 0;
// 「已學」= answered in BOTH multiple choice and spelling.
const isLearned = wid => { const m = S.modes?.get(wid); return !!m && m.has('mcq') && m.has('spell'); };
const wordCards = wid => ['mcq', 'spell'].map(t => S.cards.get(cardId(wid, t))).filter(Boolean);

function makeFsrs() {
  S.fsrs = FSRS.fsrs(FSRS.generatorParameters({ request_retention: S.settings.retention, enable_fuzz: true, learning_steps: [], relearning_steps: [] }));
}
const toFsrsCard = c => ({ due: new Date(c.due), stability: c.stability, difficulty: c.difficulty, elapsed_days: c.elapsed_days, scheduled_days: c.scheduled_days, reps: c.reps, lapses: c.lapses, learning_steps: c.learning_steps || 0, state: c.state, last_review: c.last_review ? new Date(c.last_review) : undefined });
const fromFsrsCard = (rec, f) => ({ ...rec, due: +f.due, stability: f.stability, difficulty: f.difficulty, elapsed_days: f.elapsed_days, scheduled_days: f.scheduled_days, reps: f.reps, lapses: f.lapses, learning_steps: f.learning_steps, state: f.state, last_review: f.last_review ? +f.last_review : null });
const blankCard = (wid, type) => fromFsrsCard({ id: cardId(wid, type), wid, type }, FSRS.createEmptyCard(new Date()));

/* ---------- data ---------- */
async function fetchJSON(url) {
  const r = await fetch(url, { cache: 'no-cache' }); if (!r.ok) throw new Error(url + ' ' + r.status);
  return r.json();
}
async function loadWords() {
  try {
    const j = await fetchJSON(FILES.words);
    S.meta = j.meta || {}; const b0 = banks()[0].id; // a word without a bank belongs to the first one
    S.words = (j.words || []).map((w, i) => ({ ...w, idx: i, id: w.id || `w${i}`, bank: w.bank || b0 }));
  } catch (e) { S.words = []; S.meta = { error: true }; }
  for (const w of S.words) wordById[w.id] = w;
}
/* data/cloze.json → flat question list. A passage becomes one question per blank (type 'passage');
   a single sentence is one question (type 'sentence'). Order: unit, then passages, then sentences. */
async function loadCloze() {
  S.questions = [];
  try {
    const j = await fetchJSON(FILES.cloze); S.cmeta = j.meta || {};
    for (const p of j.passages || []) for (const b of p.blanks) S.questions.push({ id: `${p.id}#${b.no}`, type: 'passage', bank: p.bank, unit: p.unit, pid: p.id, pno: p.no, ptitle: p.title || '', ptext: p.text, no: b.no, opts: b.opts, ans: b.ans, exp: b.exp || '', src: p.src || '' });
    for (const s of j.sentences || []) S.questions.push({ id: s.id, type: 'sentence', bank: s.bank, unit: s.unit, no: s.no, q: s.q, full: s.full, opts: s.opts, ans: s.ans, exp: s.exp || '', src: s.src || '' });
  } catch (e) { S.cmeta = { error: true }; }
  const kindOrd = q => (q.type === 'passage' ? 0 : 1);
  S.questions.sort((a, b) => a.unit - b.unit || kindOrd(a) - kindOrd(b) || (a.pno || 0) - (b.pno || 0) || a.no - b.no);
  S.questions.forEach((q, i) => { q.idx = i; qById[q.id] = q; });
}
/* Several word banks (e.g. two textbooks): the home page has a switch; progress, unit range and the new-word order are per bank. */
const banks = () => (S.meta.banks?.length ? S.meta.banks : [{ id: 'main', name: '單字' }]);
const curBank = () => (banks().find(b => b.id === S.settings.bank) || banks()[0]).id;
const bankWords = (b = curBank()) => S.words.filter(w => w.bank === b);
const answers = w => String(w.w).split('/').map(s => s.trim()).filter(Boolean);
const unitNums = (b = curBank()) => [...new Set(bankWords(b).map(w => w.unit).filter(n => n != null))].sort((a, b) => a - b);
const UNIT_WORD = () => S.meta.unitWord || 'Unit';
const unitLabel = (u, b = curBank()) => S.meta.unitLabels?.[b]?.[u]; // optional custom name, e.g. 9 → "Review 2"
const unitName = (u, b = curBank()) => unitLabel(u, b) || `${UNIT_WORD()} ${u}`;
const unitTag = (u, b = curBank()) => { const l = unitLabel(u, b); return l ? l.replace(/^(\S)\S*\s*(\d*)$/, '$1$2') : String(u); }; // short form for narrow columns: "Review 2" → "R2"
function unitRange(b = curBank()) { const u = unitNums(b), r = S.settings.ranges?.[b] || []; return [r[0] ?? u[0], r[1] ?? u[u.length - 1]]; }
function scopeWords() {
  const ws = bankWords(); if (!unitNums().length) return ws;
  const [lo, hi] = unitRange();
  return ws.filter(w => w.unit == null || (w.unit >= lo && w.unit <= hi));
}

/* ---------- queue ---------- */
function countsFor(mode) {
  const now = Date.now(), words = scopeWords(), dk = dayKey();
  let due = 0, fresh = 0;
  for (const w of words) { const c = S.cards.get(cardId(w.id, mode)); if (!c) fresh++; else if (c.due <= now) due++; }
  const key = curBank() + ':' + mode, used = S.daily[dk]?.new?.[key] || 0, bonus = S.daily[dk]?.bonus?.[key] || 0; // daily new-word quota: per bank and per mode
  return { due, fresh, newLeft: Math.max(0, Math.min(fresh, S.settings.newPerDay + bonus - used)), total: words.length };
}
/* New words follow the textbook order (file order = unit by unit), the SAME order in 選擇題 and 拼字.
   Words already started in the other mode come first, so the second mode redoes the same batch. */
function buildQueue(mode, practice = false) {
  const now = Date.now(), words = scopeWords(), size = S.settings.sessionSize, cardOf = w => S.cards.get(cardId(w.id, mode));
  if (practice) {
    let seen = words.filter(cardOf); if (!seen.length) seen = bankWords().filter(cardOf);
    return shuffle(seen).slice(0, 10).map(w => w.id);
  }
  const dk = c => dayKey(new Date(c.due)); // due cards: earlier due day first, then textbook order
  const due = words.map(w => ({ w, c: cardOf(w) })).filter(x => x.c && x.c.due <= now)
    .sort((a, b) => (dk(a.c) < dk(b.c) ? -1 : dk(a.c) > dk(b.c) ? 1 : a.w.idx - b.w.idx)).map(x => x.w.id);
  const { newLeft } = countsFor(mode), otherT = mode === 'mcq' ? 'spell' : 'mcq';
  const pool = words.filter(w => !cardOf(w)), other = new Set(pool.filter(w => S.cards.has(cardId(w.id, otherT))).map(w => w.id));
  const fresh = pool.sort((a, b) => other.has(b.id) - other.has(a.id) || a.idx - b.idx).slice(0, newLeft).map(w => w.id);
  return [...due, ...fresh].slice(0, size);
}

/* ---------- grading ---------- */
function noteAnswer(wid, mode, correct) {
  if (mode !== 'mcq' && mode !== 'spell') return;
  let set = S.modes.get(wid); if (!set) { set = new Set(); S.modes.set(wid, set); } set.add(mode);
  if (mode === 'spell' && correct) S.spellOK.add(wid);
}
async function grade(wid, mode, rating, extra = {}) {
  const id = cardId(wid, mode), isNew = !S.cards.has(id);
  let rec = S.cards.get(id) || blankCard(wid, mode);
  if (!S.session?.practice) {
    const next = S.fsrs.next(toFsrsCard(rec), new Date(), rating).card;
    rec = fromFsrsCard(rec, next); S.cards.set(id, rec); await store.putCard(rec);
  }
  const key = dayKey(); const d = (S.daily[key] ||= { reviews: 0, correct: 0, new: {} });
  d.reviews++; if (rating >= 3) d.correct++;
  if (isNew && !S.session?.practice) { const k = wordById[wid].bank + ':' + mode; d.new[k] = (d.new[k] || 0) + 1; }
  await store.setKV('daily', S.daily);
  await store.addLog({ ts: Date.now(), cardId: id, rating, source: mode, ...extra });
  noteDay(Date.now(), wordById[wid]?.bank, rating >= 3);
  noteAnswer(wid, mode, extra.correct === true || (extra.correct === undefined && rating >= 3));
  return rec;
}

/* ---------- distractors ---------- */
function suffix(w) { return w.slice(-3); }
/* Two Chinese glosses "overlap" when they share a 2-character chunk (e.g. 令人愉快的 / 愉快的 / 快樂的;愉快的), so a near-synonym is never offered
   as a wrong option — otherwise the question would have two right answers. */
const senses = zh => String(zh || '').replace(/[()()……]/g, '').split(/[;;,、]/).map(x => x.trim().replace(/[的地]$/, '')).filter(Boolean);
function zhOverlap(a, b) {
  const A = senses(a), B = senses(b);
  return A.some(x => B.some(y => x === y || (x.length > 1 && y.length > 1 && [...x].some((_, i) => i < x.length - 1 && y.includes(x.slice(i, i + 2))))));
}
function distractors(target, field) {
  let pool = bankWords(target.bank).filter(w => w.id !== target.id && w[field] && w[field] !== target[field]);
  const clear = pool.filter(w => !zhOverlap(w.zh, target.zh)); if (clear.length >= 3) pool = clear; // fall back only if the bank is tiny
  const score = w => (w.pos && w.pos === target.pos ? 2 : 0) + (w.unit != null && w.unit === target.unit ? 1 : 0) + (field === 'w' && suffix(w.w) === suffix(target.w) ? 1 : 0) + Math.random() * 1.5;
  const seen = new Set([target[field]]), out = [];
  for (const w of pool.sort((a, b) => score(b) - score(a))) { if (!seen.has(w[field])) { seen.add(w[field]); out.push(w); } if (out.length === 3) break; }
  return out;
}

/* ---------- speech ---------- */
function speak(text) {
  try {
    if (!('speechSynthesis' in window)) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(String(text).split('/')[0]); u.lang = 'en-US'; u.rate = 0.9;
    const v = speechSynthesis.getVoices().find(v => /^en[-_]US/i.test(v.lang)); if (v) u.voice = v;
    speechSynthesis.speak(u);
  } catch (e) { /* ignore */ }
}

/* ---------- spelling diff ---------- */
function editOps(a, b) { // levenshtein with backtrace; returns per-char status for `a` (user input) vs b (target)
  const n = a.length, m = b.length, dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 0; i <= n; i++) dp[i][0] = i; for (let j = 0; j <= m; j++) dp[0][j] = j;
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  const flags = new Array(n).fill(true); let i = n, j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && dp[i][j] === dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)) { flags[i - 1] = a[i - 1] === b[j - 1]; i--; j--; }
    else if (i > 0 && dp[i][j] === dp[i - 1][j] + 1) { flags[i - 1] = false; i--; }
    else { j--; }
  }
  return { dist: dp[n][m], flags };
}
function checkSpelling(input, w) {
  const norm = s => s.trim().toLowerCase().replace(/\s+/g, ' ');
  const user = norm(input), opts = answers(w).map(norm);
  if (opts.includes(user)) return { kind: 'ok', best: answers(w)[opts.indexOf(user)], user };
  let best = null;
  for (const [i, o] of opts.entries()) { const r = editOps(user, o); if (!best || r.dist < best.dist) best = { ...r, target: answers(w)[i] }; }
  const close = best.dist === 1 && best.target.length >= 4;
  return { kind: close ? 'typo' : 'wrong', best: best.target, user, flags: best.flags };
}

/* ---------- views ---------- */
const app = $('#app');
function setTab(t) { S.tab = t; S.pview = 'main'; document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === t)); render(); }
function render() {
  applyTheme();
  if (S.landing) return renderLanding();
  document.body.classList.remove('landing');
  document.body.classList.toggle('in-session', !!S.session);
  document.body.dataset.bank = 'main'; // styling hook (single word list)
  document.documentElement.dataset.view = 'main';
  if (S.session) return renderSession();
  ({ home: renderHome, practice: renderPractice, progress: renderProgress, settings: renderSettings }[S.tab])();
  window.scrollTo(0, 0);
}
const starPts = (n, ro, ri) => Array.from({ length: n * 2 }, (_, i) => { const r = i % 2 ? ri : ro, a = -Math.PI / 2 + i * Math.PI / n; return (12 + r * Math.cos(a)).toFixed(2) + ',' + (12.4 + r * Math.sin(a)).toFixed(2); }).join(' ');
const STAR5 = starPts(5, 11, 4.8);
const TROPHY = '<g class="trophy"><path d="M7.5 3.5h9v6a4.5 4.5 0 0 1-9 0z"/><path class="hd" d="M7.5 5.5H4.6v1.8a3 3 0 0 0 3 3M16.5 5.5h2.9v1.8a3 3 0 0 1-3 3"/><rect x="10.8" y="13.6" width="2.4" height="3.4"/><rect x="7.8" y="17" width="8.4" height="3.4" rx="1"/><path class="sh" d="M10 6.2v3"/></g>';
const starCell = (k, n, cls, lv) => {
  const shape = cls.includes('exday') ? TROPHY : lv > 0 ? `<polygon class="st" points="${STAR5}" stroke-linejoin="round"/>` : '<circle class="c" cx="12" cy="12" r="9.5"/>';
  return `<i class="${cls}" title="${k}${n == null ? '' : ': ' + n}"${lv == null ? '' : ` data-l="${lv}"`}><svg viewBox="0 0 24 24" aria-hidden="true">${shape}${cls.includes('today') ? '<circle class="dot" cx="12" cy="12.6" r="3.4"/>' : ''}</svg></i>`;
};
function examLine() {
  const e = S.settings.examDate; if (!e) return '';
  const days = Math.ceil((new Date(e + 'T00:00:00') - new Date()) / DAY); if (days < 0) return '';
  const name = S.settings.examName || '考試', fs = days >= 1000 ? 13 : days >= 100 ? 16 : 21;
  return `<span class="exam-badge" role="img" aria-label="距離${esc(name)}還有 ${days} 天" title="距離${esc(name)}還有 ${days} 天"><svg viewBox="0 0 52 52" width="52" height="52" aria-hidden="true"><circle class="bd" cx="26" cy="27" r="22"/><rect class="ring" x="15" y="1.5" width="5" height="11" rx="2.5"/><rect class="ring" x="32" y="1.5" width="5" height="11" rx="2.5"/><text x="26" y="${days >= 100 ? 33 : 35}" text-anchor="middle" font-size="${fs}" font-weight="800" font-family="inherit">${days}</text></svg><span class="dl">Days<br>Left</span></span>`;
}
function examCal() {
  const e = S.settings.examDate; if (!e) return '';
  const days = Math.ceil((new Date(e + 'T00:00:00') - new Date()) / DAY); if (days < 0) return '';
  const name = S.settings.examName || '考試', fs = days >= 1000 ? 22 : days >= 100 ? 28 : 34;
  return `<span class="exam-badge exam-cal" role="img" aria-label="距離${esc(name)}還有 ${days} 天" title="距離${esc(name)}還有 ${days} 天"><svg viewBox="0 0 80 84" width="80" height="84" aria-hidden="true"><circle class="bd" cx="40" cy="46" r="34"/><rect class="ring" x="22" y="2" width="7" height="16" rx="3.5"/><rect class="ring" x="51" y="2" width="7" height="16" rx="3.5"/><text x="40" y="52" text-anchor="middle" font-size="${fs}" font-weight="800" font-family="inherit">${days}</text><text class="dl2" x="40" y="66" text-anchor="middle" font-size="10" font-weight="800" font-family="inherit">Days Left</text></svg></span>`;
}
function iosHint() {
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent), standalone = navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  if (!ios || standalone) return '';
  return `<div class="ios-hint">📱 <b>請先加入主畫面再開始背!</b> 點 Safari 的「分享」→「加入主畫面」。只在 Safari 分頁使用的話,一週沒開,學習進度可能會被清除。</div>`;
}
const appTitle = () => S.meta.title || document.title;

function bankSwitch() {
  const bs = banks(); if (bs.length < 2) return '';
  return `<div class="bank-tabs" role="tablist" aria-label="單字庫">${bs.map(b => `<button role="tab" class="${b.id === curBank() ? 'on' : ''}" aria-selected="${b.id === curBank()}" data-bank="${esc(b.id)}">${esc(b.name)}</button>`).join('')}</div>`;
}
function wordCard() {
  const ws = bankWords(), cb = banks().find(b => b.id === curBank()), bname = cb.name, sm = cb.sample ? cb : S.meta.sample ? S.meta : null, sample = sm ? `<div class="sample-banner">目前是<b>示範資料</b>(${esc(sm.note || '請以正式單字庫取代')})</div>` : '';
  if (!ws.length) return `<section class="card"><h2>單字</h2><p class="muted">尚未匯入單字庫(<code>${FILES.words}</code>)。</p></section>`;
  let range = '';
  const u = unitNums();
  if (u.length > 1) {
    const [lo, hi] = unitRange(), opt = v => u.map(n => `<option value="${n}" ${n === v ? 'selected' : ''}>${esc(unitName(n))}</option>`).join('');
    range = `<div class="row wrap" style="margin:10px 0 12px"><span class="muted small">範圍</span><select id="u-from">${opt(lo)}</select><span class="muted small">到</span><select id="u-to">${opt(hi)}</select></div>`;
  }
  const canMcq = ws.length >= 4;
  const modes = Object.keys(MODES).map(m => {
    const c = countsFor(m), n = c.due + c.newLeft, off = !c.total || (m === 'mcq' && !canMcq);
    return `<button class="mode" data-start="${m}" ${off ? 'disabled' : ''}><b>${MODES[m]}</b><span>${n ? `${c.due} 複習 · ${c.newLeft} 新` : '今日完成 ✓'}</span></button>`;
  }).join('');
  const learned = ws.filter(w => isLearned(w.id)).length;
  return `<section class="card bank"><div class="row between"><h2>${esc(banks().length > 1 ? bname : '單字學習')}</h2><span class="bank-stat"><b>${learned}</b> / ${ws.length}<small>已學</small></span></div><p class="muted small" style="margin:2px 0 0">目前範圍 ${scopeWords().length} 字</p>${range}<div class="modes two">${modes}</div>${sample}</section>`;
}
function renderHome() {
  const today = correctOn(dayKey()); // this bank only
  app.innerHTML = `${iosHint()}
    <div class="hero"><h1 class="brand-h">${logoImg()}</h1>${examCal()}</div>
    <div class="stack">${bankSwitch()}${wordCard()}
    <p class="today-n">今天答對 ${today} 題${store.volatile ? '<br><b style="color:var(--bad)">⚠ 此瀏覽器無法儲存資料,關閉後進度會消失</b>' : ''}</p></div>`;
  const uf = $('#u-from'), ut = $('#u-to');
  if (uf && ut) { const h = async () => { let a = +uf.value, b = +ut.value; if (a > b) [a, b] = [b, a]; (S.settings.ranges ||= {})[curBank()] = [a, b]; await saveSettings(); render(); }; uf.onchange = h; ut.onchange = h; }
}

function renderProgress() {
  const now = Date.now(), curBanks = banks().filter(b => b.id === curBank()); // progress follows the 龍騰 / 核單 switch
  let html = heroLogo() + '<h1>進度</h1><div class="stack" style="margin-top:12px">' + bankSwitch();
  for (const bk of curBanks) {
    const ws = bankWords(bk.id); if (!ws.length) continue;
    let learned = 0, mastered = 0, due = 0; const byUnit = {};
    for (const w of ws) {
      const g = (byUnit[w.unit ?? 0] ||= { n: 0, m: 0, l: 0 }); g.n++;
      const cs = wordCards(w.id), lrn = isLearned(w.id); // mastered is always a subset of learned
      if (lrn) { learned++; g.l++; }
      if (lrn && S.spellOK.has(w.id) && cs.some(c => c.stability >= 21)) { mastered++; g.m++; }
      if (cs.some(c => c.due <= now)) due++;
    }
    const n = ws.length, units = Object.keys(byUnit).map(Number).sort((a, b) => a - b);
    html += `<section class="card"><h2>${esc(banks().length > 1 ? bk.name : '單字學習')}</h2><div class="stat-grid" style="margin-top:8px">
      <div class="stat pstat"><b>${learned}</b><span>已學 / ${n}</span></div><div class="stat pstat"><b>${mastered}</b><span>已精熟 / ${n}</span></div><div class="stat pstat"><b>${due}</b><span>待複習</span></div></div>`;
    if (units.length > 1) html += '<div style="margin-top:12px">' + units.map(u => { const v = byUnit[u]; const seg = c => c > 0 ? Math.max(4, c / v.n * 100) : 0; return `<div class="lvl"><span>${u ? esc(unitTag(u, bk.id)) : '—'}</span><div class="track"><i class="m" style="width:${seg(v.m)}%"></i><i class="l" style="width:${seg(v.l - v.m)}%"></i></div><span class="muted small">${v.l}/${v.n}</span></div>`; }).join('') + '</div>';
    html += `<p class="small muted">已學 = 選擇題與拼字都答過;精熟 = 已學 且 拼字答對過 且 記憶穩定度 ≥ 21 天。${units.length > 1 ? `深色＝精熟,淺色＝已學未精熟;左側是單元,右側為已學／該單元總數` : ''}</p></section>`;
  }
  for (const bk of curBanks) { // 克漏字 progress of the selected bank (if it has questions)
    if (!clozeQs('all', bk.id).length) continue;
    const t = qTotals(() => true, 'all', bk.id), pct = t.ok / t.total * 100;
    html += `<section class="card"><h2>克漏字${banks().length > 1 ? ' · ' + esc(bk.name) : ''}</h2><div class="pbar" style="margin-top:8px"><i class="g" style="width:${pct}%"></i><i class="r" style="width:${t.wrong / t.total * 100}%"></i><em>${pct < 10 ? pct.toFixed(1) : Math.round(pct)}%</em></div>
      <div class="stat-grid" style="margin-top:12px"><div class="stat pstat"><b>${t.tried}</b><span>已作答</span></div><div class="stat pstat"><b>${t.wrong}</b><span>錯題</span></div><div class="stat pstat"><b>${t.ok}</b><span>答對 / ${t.total}</span></div></div></section>`;
  }
  const lvl = n => n === 0 ? 0 : n <= 20 ? 1 : 2;
  const exD = S.settings.examDate ? new Date(S.settings.examDate + 'T00:00:00') : null, left = exD ? Math.ceil((exD - new Date()) / DAY) : -1;
  const toExam = !S.settings.progressDays && left >= 0, cells = [];
  let calTitle;
  if (toExam) {
    const t0 = new Date(); t0.setHours(0, 0, 0, 0); const sd = new Date((S.settings.startDate || dayKey()) + 'T00:00:00'), back = Math.max(0, Math.min(365, Math.round((t0 - sd) / DAY))); calTitle = `${esc(S.settings.examName || '考試')}倒數`;
    for (let i = -back; i <= left; i++) {
      const k = dayKey(new Date(t0.getFullYear(), t0.getMonth(), t0.getDate() + i)), n = correctOn(k);
      cells.push(i > 0 ? starCell(k, null, i === left ? 'exday' : 'f') : starCell(k, n, i === 0 ? 'today' : '', lvl(n)));
    }
  } else {
    const nd = Math.min(365, Math.max(7, S.settings.progressDays || 45)); calTitle = `最近 ${nd} 天`;
    for (let i = nd - 1; i >= 0; i--) { const k = dayKey(new Date(Date.now() - i * DAY)), n = correctOn(k); cells.push(starCell(k, n, '', lvl(n))); }
  }
  const sIcon = (cls, lv) => starCell('', null, cls, lv).replace(' title=""', '');
  const legend = [[sIcon('f'), '沒答對 / 未到'], [sIcon('', 1), '答對 1–20 題'], [sIcon('', 2), '答對 20 題以上']];
  if (toExam) legend.push([sIcon('today', 0), '今天'], [sIcon('exday'), `${esc(S.settings.examName || '考試')}日`]);
  const legendHtml = `<div class="star-legend">${legend.map(([ic, t]) => `<div class="sl">${ic}<span>${t}</span></div>`).join('')}</div>`;
  html += `<section class="card"><div class="row between"><h2>${calTitle}</h2><div class="row" style="gap:8px">${examLine()}</div></div><div class="heat">${cells.join('')}</div>${legendHtml}</section></div>`;
  app.innerHTML = html;
}

const PAGE_PINK = '#BB93D8'; // the lavender of "Book" in the logo = default theme colour
const bankColor = () => /^#[0-9a-f]{6}$/i.test(banks().find(b => b.id === curBank())?.color || '') ? banks().find(b => b.id === curBank()).color : PAGE_PINK; // per word bank (@color in words.txt): 龍騰 lavender, 核單 green
function applyTheme() {
  const c = S.landing ? PAGE_PINK : bankColor(); // landing page is always the lavender (also for a 核單 student), so it matches the loading screen
  document.documentElement.style.setProperty('--page', c);
  document.documentElement.style.setProperty('--page-ink', '#1a1a1a');
  const m = document.querySelector('meta[name="theme-color"]'); if (m) m.content = c;
}
const heroLogo = () => `<div class="hero"><div class="brand-h">${logoImg()}</div></div>`; // same spot as the home page header
const logoImg = (cls = 'brand') => `<img class="${cls}" src="icons/logo.png" alt="Book3" width="800" height="340" decoding="async">`;
function renderLanding() {
  document.body.classList.add('landing');
  app.innerHTML = `<button class="landing-btn" id="go" aria-label="Book3 — 點一下開始使用">${logoImg('landing-logo')}</button>`;
  $('#go').addEventListener('click', () => { S.landing = false; render(); });
}
const APP_VERSION = 'v4';
function renderSettings() {
  const s = S.settings;
  const days = s.lastBackupAt ? Math.floor((Date.now() - s.lastBackupAt) / DAY) : null;
  app.innerHTML = `${heroLogo()}<h1>設定</h1><div class="stack" style="margin-top:12px">
  <section class="card">
    <label class="set"><span>每天新字上限</span><input type="number" id="s-new" min="0" max="200" value="${s.newPerDay}"></label>
    <label class="set"><span>每回題數</span><input type="number" id="s-size" min="5" max="100" value="${s.sessionSize}"></label>
    <label class="set"><span>目標記憶保留率</span><select id="s-ret">${[0.85, 0.9, 0.95].map(v => `<option value="${v}" ${v === s.retention ? 'selected' : ''}>${v * 100}%</option>`).join('')}</select></label>
    <label class="set"><span>常用考試</span><select id="s-preset">${EXAM_PRESETS.map((x, i) => `<option value="${i}" ${x.name === s.examName ? 'selected' : ''}>${x.name}${x.date ? '(' + x.date + ')' : ''}</option>`).join('')}<option value="-1" ${EXAM_PRESETS.some(x => x.name === s.examName) ? '' : 'selected'}>自訂</option></select></label>
    <label class="set"><span>考試名稱</span><input type="text" id="s-ename" maxlength="12" placeholder="例如:段考、會考" value="${esc(s.examName)}"></label>
    <label class="set"><span>考試日期</span><input type="date" id="s-exam" value="${esc(s.examDate)}"></label>
    <label class="set"><span>進度日曆天數(0 = 到考試日)</span><input type="number" id="s-pdays" min="0" max="365" value="${s.progressDays}"></label>
    <div class="row wrap" style="margin-top:6px"><button class="btn ghost" id="p-exam">日曆顯示到考試日</button></div>
  </section>
  <section class="card"><h2>備份</h2>
    <p class="small muted">${days === null ? '尚未備份過。' : `上次備份在 ${days} 天前。`}換手機或清除瀏覽器資料前,請先匯出。</p>
    <div class="row wrap" style="margin-top:8px"><button class="btn" id="b-export">匯出進度</button><label class="btn ghost" style="display:inline-flex;align-items:center">匯入進度<input type="file" id="b-import" accept="application/json" hidden></label></div>
    <p class="small muted" style="margin-top:12px">${store.volatile ? '⚠ 無法使用瀏覽器儲存。' : '資料只存在這支手機的瀏覽器中。'}</p>
    <button class="btn ghost danger-btn" id="b-reset" style="margin-top:6px">清除所有進度</button>
  </section>
  <section class="card credits"><h2>關於與致謝</h2>
    ${S.meta.source ? `<p>單字與題目內容整理自教材:${esc(S.meta.source)}。僅供個人學習使用。</p>` : ''}
    <p>複習排程:<a href="https://github.com/open-spaced-repetition/ts-fsrs" target="_blank" rel="noopener">ts-fsrs</a>(MIT)。</p>
  </section><p class="small muted brand-foot">${logoImg('brand sm')}<br>${APP_VERSION}</p></div>`;
  const num = (id, key) => $(id).addEventListener('change', async e => { s[key] = Math.max(0, +e.target.value || 0); await saveSettings(); });
  num('#s-new', 'newPerDay'); num('#s-size', 'sessionSize');
  $('#s-preset').addEventListener('change', async e => { const x = EXAM_PRESETS[+e.target.value]; if (!x) return $('#s-ename').focus(); s.examName = x.name; s.examDate = x.date; await saveSettings(); renderSettings(); if (!x.date) $('#s-exam').focus(); });
  $('#s-ename').addEventListener('change', async e => { s.examName = e.target.value.trim(); await saveSettings(); });
  $('#s-pdays').addEventListener('change', async e => { { const v = Math.round(+e.target.value) || 0; s.progressDays = v <= 0 ? 0 : Math.min(365, Math.max(7, v)); } e.target.value = s.progressDays; await saveSettings(); });
  $('#p-exam').addEventListener('click', async () => { s.progressDays = 0; await saveSettings(); renderSettings(); });
  $('#s-ret').addEventListener('change', async e => { s.retention = +e.target.value; makeFsrs(); await saveSettings(); });
  $('#s-exam').addEventListener('change', async e => { s.examDate = e.target.value; await saveSettings(); });
  $('#b-export').addEventListener('click', async () => {
    const blob = new Blob([JSON.stringify(await store.exportAll())], { type: 'application/json' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `vocab-backup-${dayKey()}.json` });
    document.body.append(a); a.click(); a.remove(); s.lastBackupAt = Date.now(); await saveSettings(); renderSettings();
  });
  $('#b-import').addEventListener('change', async e => {
    const f = e.target.files[0]; if (!f) return;
    try { await store.importAll(JSON.parse(await f.text())); await boot(true); alert('匯入完成'); } catch (err) { alert('匯入失敗:' + err.message); }
  });
  $('#b-reset').addEventListener('click', async () => { if (confirm('確定要清除所有學習進度嗎?此動作無法復原。')) { await store.clear(); await boot(true); } });
}
const saveSettings = () => store.setKV('settings', S.settings);

/* ---------- word session (選擇題 / 拼字) ---------- */
function doneSheet(mode) {
  const { fresh } = countsFor(mode), more = Math.min(20, fresh), seen = bankWords().some(w => S.cards.has(cardId(w.id, mode)));
  const el = document.createElement('div'); el.className = 'sheet-bg';
  el.innerHTML = `<div class="sheet card"><h2>今天的進度已完成 ✓</h2><p class="muted small">你想怎麼繼續?</p>
    <button class="btn block" data-sheet="more" ${more ? '' : 'disabled'}>再學 ${more} 個新字${more ? '' : '(沒有新字了)'}</button>
    <button class="btn ghost block" data-sheet="practice" ${seen ? '' : 'disabled'}>複習已學過的字(10 題,不影響排程)</button>
    <button class="btn ghost block" data-sheet="close">關閉</button></div>`;
  el.onclick = async e => {
    const a = e.target.dataset.sheet; if (!a && e.target !== el) return;
    el.remove();
    if (a === 'more') { const d = (S.daily[dayKey()] ||= { reviews: 0, correct: 0, new: {} }); d.bonus ||= {}; const k = curBank() + ':' + mode; d.bonus[k] = (d.bonus[k] || 0) + more; await store.setKV('daily', S.daily); startSession(mode); }
    else if (a === 'practice') startSession(mode, true);
  };
  document.body.appendChild(el);
}
function startSession(mode, practice = false) {
  const queue = buildQueue(mode, practice);
  if (!queue.length) { if (!practice) doneSheet(mode); return; }
  S.session = { kind: 'word', mode, practice, queue, pos: 0, total: queue.length, results: [], t0: Date.now() };
  render();
}
function endSession() { S.session = null; render(); }
function curWord() { const s = S.session; return wordById[s.queue[s.pos]]; }

function renderSession() {
  const s = S.session;
  if (s.kind === 'cz') return renderCloze();
  if (s.pos >= s.queue.length) return renderSummary();
  const w = curWord(), pct = Math.round(s.results.length / s.total * 100);
  const head = `<div class="topbar"><button class="icon-btn" data-act="quit" aria-label="離開">✕</button><div class="bar"><i style="width:${pct}%"></i></div><span class="muted small">${s.results.length}/${s.total}${s.practice ? ' · 練習' : ''}</span></div>`;
  return s.mode === 'mcq' ? renderMcq(head, w) : renderSpell(head, w);
}
const exBlock = w => w.ex ? `<div class="ex">${esc(w.ex)}${w.exzh ? `<br><span>${esc(w.exzh)}</span>` : ''}</div>` : '';
const speakBtn = w => `<button class="icon-btn" data-speak="${esc(w.w)}" aria-label="發音">🔊</button>`;

function renderMcq(head, w) {
  const s = S.session;
  if (!s.q || s.q.id !== w.id) {
    const rec = S.cards.get(cardId(w.id, 'mcq')), reverse = !!rec && rec.stability > 3 && bankWords(w.bank).length >= 4 && Math.random() < 0.5;
    const field = reverse ? 'w' : 'zh', ds = distractors(w, field);
    s.q = { id: w.id, reverse, field, opts: shuffle([w, ...ds]), picked: null, t0: Date.now() };
  }
  const q = s.q;
  let body = `<div class="card q">${q.reverse ? `<div class="muted small">哪一個英文單字的意思是</div><div class="zh">${esc(w.zh)}</div><div class="pos">${esc(w.pos || '')}</div>` : `<div class="word">${esc(w.w)}</div><div class="pos">${esc(w.pos || '')}</div><div style="margin-top:10px">${speakBtn(w)}</div>`}</div>`;
  body += `<div class="opts">${q.opts.map((o, i) => {
    let cls = ''; if (q.picked !== null) cls = o.id === w.id ? 'ok' : i === q.picked ? 'no' : '';
    const hit = q.picked === i && o.id === w.id;
    return `<button class="opt ${cls}${hit ? ' picked' : ''}" data-pick="${i}" ${q.picked !== null ? 'disabled' : ''}><span>${esc(q.reverse ? o.w : o.zh)}</span>${hit ? '<b class="opt-tag">✓ 正確</b>' : ''}</button>`;
  }).join('')}</div>`;
  if (q.picked !== null) body += `<div class="card" style="margin-top:12px"><b>${esc(w.w)}</b> ${esc(w.pos || '')} — ${esc(w.zh)}${exBlock(w)}</div><button class="btn block" style="margin-top:12px" data-act="next">下一題</button>`;
  app.innerHTML = head + body;
}

function renderSpell(head, w) {
  const s = S.session, r = s.spellResult;
  let body = `<div class="card q"><div class="muted small">請拼出這個字</div><div class="zh">${esc(w.zh)}</div><div class="pos">${esc(w.pos || '')}${w.w.includes('/') ? '' : ` · ${w.w.length} 個字母`}</div><div style="margin-top:10px">${speakBtn(w)}</div>${s.hint ? `<div class="pos" style="margin-top:6px">提示:${esc(w.w[0])}${'・'.repeat(Math.max(0, answers(w)[0].length - 1))}</div>` : ''}</div>`;
  if (!r) {
    body += `<form id="spell-form" style="margin-top:14px" autocomplete="off"><input class="field" id="spell-in" autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="輸入英文" aria-label="拼字答案"><div class="row" style="margin-top:12px"><button type="button" class="btn ghost" data-act="hint" ${s.hint ? 'disabled' : ''}>提示</button><button type="button" class="btn ghost" data-act="giveup">不會</button><button class="btn grow" type="submit">送出</button></div></form>`;
  } else {
    const shown = r.flags ? [...r.user].map((ch, i) => `<span class="${r.flags[i] ? 'good' : 'x'}">${esc(ch)}</span>`).join('') : '';
    body += `<div class="card" style="margin-top:14px;text-align:center">
      ${r.kind === 'ok' ? `<div class="verdict ok">✓ 正確!</div>` : r.kind === 'typo' ? `<div class="verdict half">差一點!有一個字母不對</div>` : `<div class="verdict no">${r.gaveUp ? '正確答案' : '✗ 再記一次'}</div>`}
      ${r.kind !== 'ok' && r.user ? `<div class="muted small">你的答案</div><div class="diff">${shown}</div>` : ''}
      <div class="muted small">正確拼法</div><div class="diff"><span class="good">${esc(w.w.split('/').join(' / '))}</span></div>${exBlock(w)}</div>
      <button class="btn block" style="margin-top:12px" data-act="next">下一題</button>`;
  }
  app.innerHTML = head + body;
  const inp = $('#spell-in'); if (inp) inp.focus({ preventScroll: true });
}

function renderSummary() {
  const s = S.session, ok = s.results.filter(r => r.rating >= 3).length, missed = s.results.filter(r => r.rating < 3);
  app.innerHTML = `<div class="stack"><section class="card q"><h1>${ok === s.total ? '全部答對!🎉' : '完成這一回'}</h1><p class="zh">${ok} / ${s.total}</p><p class="muted">答對率 ${Math.round(ok / s.total * 100)}% · 用時 ${Math.max(1, Math.round((Date.now() - s.t0) / 60000))} 分鐘</p></section>
    ${missed.length ? `<section class="card"><h2>需要再加強</h2><ul class="missed">${[...new Map(missed.map(r => [r.wid, r])).values()].map(r => { const w = wordById[r.wid]; return `<li><b>${esc(w.w)}</b> ${esc(w.pos || '')} — ${esc(w.zh)}</li>`; }).join('')}</ul></section>` : ''}
    <button class="btn block" data-act="again">再來一回</button><button class="btn ghost block" data-act="quit">回首頁</button></div>`;
}

async function answerCurrent(rating, extra = {}) {
  const s = S.session, w = curWord(); await grade(w.id, s.mode, rating, { wid: w.id, ...extra });
  s.results.push({ wid: w.id, rating });
  if (rating === 1 && !s.practice && s.queue.length - s.pos < 40) { const at = Math.min(s.queue.length, s.pos + 4); s.queue.splice(at, 0, w.id); s.total++; } // see it again soon
  s.pos++; s.q = null; s.spellResult = null; s.hint = false; render();
}

/* ---------- 克漏字 (cloze): short passages with several blanks + single sentences ---------- */
const BLANK_RE = /_{2,}/;
function sentenceHtml(q, revealed) {
  if (!revealed) return esc(q.q).replace(/_{2,}/g, m => '<span class="nb"><span class="blank" style="min-width:' + Math.max(2.4, m.length * 0.55).toFixed(1) + 'em"></span></span>');
  const m = BLANK_RE.exec(q.q); if (!m) return esc(q.full);
  return esc(q.q.slice(0, m.index)) + '<mark class="ans">' + esc(q.ans) + '</mark>' + esc(q.q.slice(m.index + m[0].length));
}
/* the whole passage; the blank being asked is highlighted, blanks already answered in this session are filled in */
function passageHtml(q, done) {
  const s = S.session, filled = s?.filled || {};
  const body = esc(q.ptext).replace(/\[(\d+)\]/g, (_, n) => {
    n = +n; const id = q.pid + '#' + n, oq = qById[id];
    if (n === q.no) return done ? `<mark class="ans ${s.cur?.result ? '' : 'miss'}">${esc(q.ans)}</mark>` : `<span class="pb cur" id="cur-blank"><i>${n}</i></span>`;
    if (oq && id in filled) return `<mark class="ans ${filled[id] ? '' : 'miss'}">${esc(oq.ans)}</mark>`;
    return `<span class="pb"><i>${n}</i></span>`;
  });
  return (q.ptitle ? `<div class="ptitle">${esc(q.ptitle)}</div>` : '') + body.split(/\n\n+/).map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('');
}
function passageSnippet(q) { // the one sentence of a passage that holds blank `q.no`, answer filled in
  const t = q.ptext.replace(/\s+/g, ' ').trim(), parts = t.match(/[^.!?]+[.!?]*\s*/g) || [t], hit = parts.find(p => p.includes('[' + q.no + ']')) || t;
  return esc(hit.trim()).replace(/\[(\d+)\]/g, (_, n) => +n === q.no ? '<mark class="ans">' + esc(q.ans) + '</mark>' : '<span class="nb"><span class="blank" style="min-width:2em"></span></span>');
}
const qHtml = q => (q.type === 'passage' ? passageSnippet(q) : sentenceHtml(q, true));
const qLabel = q => q.type === 'passage' ? `短文 ${q.pno} · 第 ${q.no} 格` : `單句 第 ${q.no} 題`;
const srcNote = q => q.src ? `<div class="small muted src-note">${esc(q.src)}</div>` : '';
const qSt = id => S.qstats.get(id);
const clozeQs = (kind = S.pkind, bank = curBank()) => S.questions.filter(q => q.bank === bank && (kind === 'all' || q.type === kind));
function qTotals(filter = () => true, kind = S.pkind, bank = curBank()) {
  let total = 0, tried = 0, ok = 0, wrong = 0, first = 0;
  for (const q of clozeQs(kind, bank)) { if (!filter(q)) continue; total++; const st = qSt(q.id); if (!st) continue; tried++; if (st.last) ok++; else wrong++; if (st.firstOk) first++; }
  return { total, tried, ok, wrong, first };
}
const wrongIds = (filter = () => true, kind = S.pkind, bank = curBank()) => clozeQs(kind, bank).filter(q => filter(q) && qSt(q.id) && !qSt(q.id).last).map(q => q.id);
const unitList = (kind = S.pkind, bank = curBank()) => [...new Set(clozeQs(kind, bank).map(q => q.unit))].sort((a, b) => a - b);
// passages keep their order (context matters); a list of only single sentences is shuffled
const ordered = ids => ids.every(id => qById[id].type === 'sentence') ? shuffle(ids) : ids.slice().sort((a, b) => qById[a].idx - qById[b].idx);

async function recordQ(q, ok, extra = {}) {
  const prev = qSt(q.id), st = { id: q.id, n: (prev?.n || 0) + 1, ok: (prev?.ok || 0) + (ok ? 1 : 0), last: ok, firstOk: prev ? prev.firstOk : ok, ts: Date.now() };
  S.qstats.set(q.id, st); await store.putQ(st);
  const d = (S.daily[dayKey()] ||= { reviews: 0, correct: 0, new: {} }); d.reviews++; if (ok) d.correct++;
  await store.setKV('daily', S.daily); await store.addLog({ ts: Date.now(), cardId: 'q:' + q.id, rating: ok ? 3 : 1, source: 'cloze', ...extra }); noteDay(Date.now(), q.bank, ok);
}
function startCloze(ids, opts = {}) {
  if (!ids.length) return;
  S.session = { kind: 'cz', queue: ids.slice(), pos: 0, total: ids.length, results: [], filled: {}, t0: Date.now(), retest: !!opts.retest, title: opts.title || '', cur: null };
  render();
}
function unitTile(u) {
  const t = qTotals(q => q.unit === u), cls = t.tried === 0 ? '' : t.wrong ? 'bad' : t.ok === t.total ? 'good' : 'part';
  return `<button class="tile ${cls}" data-xunit="${u}"><b>${esc(unitTag(u))}</b><span>${t.ok}/${t.total}</span></button>`;
}
function renderPractice() {
  if (!clozeQs('all').length) { app.innerHTML = `${heroLogo()}<h1>克漏字</h1><div class="stack" style="margin-top:12px">${bankSwitch()}<section class="card"><p class="muted">這個單字庫(${esc(banks().find(b => b.id === curBank()).name)})目前還沒有克漏字題目。</p></section></div>`; return; }
  if (S.pview === 'unit') return renderUnit();
  const kinds = ['passage', 'sentence'].filter(k => clozeQs('all').some(q => q.type === k));
  if (!kinds.includes(S.pkind) && S.pkind !== 'all') S.pkind = 'all';
  const t = qTotals(), w = t.wrong, units = unitList();
  const chips = kinds.length > 1 ? `<div class="chips" style="margin:10px 0 0">${['all', ...kinds].map(k => `<button class="chip ${S.pkind === k ? 'on' : ''}" data-pkind="${k}">${KINDS[k]}</button>`).join('')}</div>` : '';
  const cs = S.cmeta.banks?.[curBank()], sample = cs?.sample ? `<div class="sample-banner" style="margin-top:12px">目前是<b>示範題目</b>(${esc(cs.note || '請以正式題目取代')})</div>` : '';
  app.innerHTML = `${heroLogo()}<h1>克漏字</h1><div style="margin-top:12px">${bankSwitch()}</div>${chips}<div class="stack" style="margin-top:12px">
  <section class="card"><div class="row between"><h2>總進度</h2><span class="muted small">共 ${t.total} 題 · ${units.length} 個單元</span></div>
    <div class="bigscore"><b>${t.ok}</b><span>/ ${t.total} 題目前答對</span></div>
    <div class="seg"><i class="g" style="width:${t.ok / t.total * 100}%"></i><i class="r" style="width:${t.wrong / t.total * 100}%"></i></div>
    <div class="stat-grid" style="margin-top:12px"><div class="stat"><b>${t.tried}</b><span>已作答</span></div><div class="stat"><b>${w}</b><span>錯題待複習</span></div><div class="stat"><b>${t.tried ? Math.round(t.first / t.tried * 100) : 0}%</b><span>一次答對率</span></div></div>
    <div class="row wrap" style="margin-top:14px"><button class="btn block" data-pact="retest" ${w ? '' : 'disabled'}>重測所有錯題(${w})</button></div>
  </section>
  <section class="card"><h2>選擇單元</h2><p class="small muted">點單元進入:可測驗整個單元、只重測錯題,並查看錯題。做到一半離開,進度會自動存起來。<span class="dot g"></span>全對 <span class="dot y"></span>進行中 <span class="dot r"></span>有錯題</p>
    <div class="tiles">${units.map(unitTile).join('')}</div></section>${sample}</div>`;
}
function renderUnit() {
  const u = S.punit, qs = clozeQs().filter(q => q.unit === u), t = qTotals(q => q.unit === u);
  const left = qs.filter(q => !qSt(q.id)), wrong = qs.filter(q => qSt(q.id) && !qSt(q.id).last), partial = left.length > 0 && left.length < qs.length;
  const item = q => `<div class="witem"><div class="muted small">${qLabel(q)} · 答錯 ${qSt(q.id).n - qSt(q.id).ok} 次</div><div>${qHtml(q)}</div>${srcNote(q)}<div class="small"><b>${esc(q.ans)}</b>${q.exp ? ` <span class="muted">${esc(q.exp)}</span>` : ''}</div></div>`;
  app.innerHTML = `<div class="topbar"><button class="icon-btn" data-pact="back" aria-label="返回">←</button><h1 style="font-size:1.25rem">${esc(unitName(u))} · ${KINDS[S.pkind]}</h1></div>
  <div class="stack"><section class="card">
    <div class="stat-grid"><div class="stat"><b>${t.tried}/${t.total}</b><span>已作答</span></div><div class="stat"><b>${t.ok}</b><span>目前答對</span></div><div class="stat"><b>${wrong.length}</b><span>錯題</span></div></div>
    <div class="stack" style="margin-top:14px;gap:10px">
      ${partial ? `<button class="btn block" data-uact="resume">繼續作答(還剩 ${left.length} 題)</button><button class="btn ghost block" data-uact="all">從頭重做(${qs.length} 題)</button>` : `<button class="btn block" data-uact="all">開始測驗(${qs.length} 題)</button>`}
      <button class="btn ghost block" data-uact="wrong" ${wrong.length ? '' : 'disabled'}>只重測錯題(${wrong.length})</button>
    </div></section>
  <section class="card"><h2>答錯的題目</h2>${wrong.length ? wrong.map(item).join('') : `<p class="muted small" style="margin-top:6px">這個單元目前沒有錯題。</p>`}</section></div>`;
}

/* --- cloze session --- */
function czState(q) {
  const s = S.session;
  if (!s.cur || s.cur.id !== q.id) s.cur = { id: q.id, picked: null, result: null, shuffled: s.retest && q.type === 'sentence', opts: null };
  if (!s.cur.opts) s.cur.opts = s.cur.shuffled ? shuffle(q.opts) : q.opts.slice();
  return s.cur;
}
function renderCloze() {
  const s = S.session;
  if (s.pos >= s.queue.length) return renderClozeSummary();
  const q = qById[s.queue[s.pos]], c = czState(q), pct = Math.round(s.results.length / s.total * 100), done = c.result !== null;
  let body = `<div class="topbar"><button class="icon-btn" data-xact="quit" aria-label="離開">✕</button><div class="bar"><i style="width:${pct}%"></i></div><span class="muted small">${s.results.length}/${s.total}${s.retest ? ' · 重測' : ''}</span></div>`;
  const head = `${esc(unitName(q.unit, q.bank))} · ${qLabel(q)}`;
  body += q.type === 'passage'
    ? `<div class="card"><div class="muted small">${head}</div><div class="passage qtext">${passageHtml(q, done)}</div>${srcNote(q)}</div>`
    : `<div class="card"><div class="muted small">${head}</div><p class="qtext">${sentenceHtml(q, done)}</p>${srcNote(q)}</div>`;
  body += `<div class="opts">${c.opts.map((o, i) => {
    const lab = c.shuffled ? '' : `(${'ABCD'[i]}) `; let cls = ''; if (done) cls = o === q.ans ? 'ok' : i === c.picked ? 'no' : '';
    const hit = done && i === c.picked && o === q.ans;
    return `<button class="opt ${cls}${hit ? ' picked' : ''}" data-xpick="${i}" ${done ? 'disabled' : ''}><span>${lab}${esc(o)}</span>${hit ? '<b class="opt-tag">✓ 正確</b>' : ''}</button>`;
  }).join('')}</div>`;
  if (done) body += `<div class="card" style="margin-top:12px">${c.result ? '<div class="verdict ok">✓ 正確!</div>' : '<div class="verdict no">✗ 答錯了</div>'}<b>${esc(q.ans)}</b>${q.exp ? ` <span class="muted">${esc(q.exp)}</span>` : ''}</div>
    <div class="row" style="margin-top:12px"><button class="icon-btn" data-speak="${esc(q.ans)}" aria-label="發音">🔊</button><button class="btn grow" data-xact="next">${s.pos + 1 >= s.queue.length ? '看結果' : '下一題'}</button></div>`;
  app.innerHTML = body;
  if (q.type === 'passage') { if (!done) $('#cur-blank')?.scrollIntoView({ block: 'center' }); else $('[data-xact="next"]')?.scrollIntoView({ block: 'nearest' }); } // long passages: keep the blank / the 下一題 button in view
}
function renderClozeSummary() {
  const s = S.session, ok = s.results.filter(r => r.ok).length, miss = s.results.filter(r => !r.ok).map(r => qById[r.id]);
  const left = wrongIds().length;
  app.innerHTML = `<div class="stack"><section class="card q"><h1>${ok === s.total ? '全部答對!🎉' : '完成這一回'}</h1><p class="zh">${ok} / ${s.total}</p><p class="muted">答對率 ${Math.round(ok / s.total * 100)}% · 用時 ${Math.max(1, Math.round((Date.now() - s.t0) / 60000))} 分鐘</p>${s.retest ? `<p class="small">錯題本還剩 <b>${left}</b> 題</p>` : ''}</section>
    ${miss.length ? `<section class="card"><h2>這回答錯的題目</h2>${miss.map(q => `<div class="witem"><div class="muted small">${esc(unitName(q.unit, q.bank))} · ${qLabel(q)}</div><div>${qHtml(q)}</div>${srcNote(q)}<div class="small"><b>${esc(q.ans)}</b>${q.exp ? ` <span class="muted">${esc(q.exp)}</span>` : ''}</div></div>`).join('')}</section>` : ''}
    ${miss.length ? `<button class="btn block" data-xact="redo-miss">馬上重測這 ${miss.length} 題</button>` : ''}
    ${left && !miss.length ? '<button class="btn block" data-xact="retest-all">繼續重測錯題本</button>' : ''}
    <button class="btn ghost block" data-xact="quit">回克漏字</button></div>`;
}
async function czAnswer(ok, extra) {
  const s = S.session, q = qById[s.queue[s.pos]]; s.cur.result = ok; s.filled[q.id] = ok; await recordQ(q, ok, extra); s.results.push({ id: q.id, ok }); render();
}
async function czClick(t, s) {
  if (t.dataset.speak) return speak(t.dataset.speak);
  const q = qById[s.queue[s.pos]];
  if (t.dataset.xpick !== undefined && s.cur && s.cur.result === null) { const i = +t.dataset.xpick; s.cur.picked = i; return czAnswer(s.cur.opts[i] === q.ans, { answer: s.cur.opts[i] }); }
  switch (t.dataset.xact) {
    case 'quit': if (!s.results.length || s.pos >= s.queue.length || confirm('要離開嗎?已作答的題目會保留。')) { S.session = null; S.pview = S.punit != null ? 'unit' : 'main'; render(); } break;
    case 'next': s.pos++; s.cur = null; render(); break;
    case 'redo-miss': { const ids = s.results.filter(r => !r.ok).map(r => r.id); S.session = null; startCloze(ordered(ids), { retest: true }); break; }
    case 'retest-all': S.session = null; startCloze(ordered(wrongIds()), { retest: true }); break;
  }
}

/* ---------- events ---------- */
document.addEventListener('click', async e => {
  const t = e.target.closest('button'); if (!t) return;
  if (t.dataset.tab) return setTab(t.dataset.tab);
  if (t.dataset.bank) { S.settings.bank = t.dataset.bank; await saveSettings(); return render(); }
  if (t.dataset.pkind) { S.pkind = t.dataset.pkind; return render(); }
  if (t.dataset.xunit) { S.punit = +t.dataset.xunit; S.pview = 'unit'; return render(); }
  if (t.dataset.uact) {
    const u = S.punit, all = clozeQs().filter(q => q.unit === u).map(q => q.id), act = t.dataset.uact, ttl = unitName(u);
    if (act === 'wrong') return startCloze(ordered(wrongIds(q => q.unit === u)), { retest: true, title: ttl });
    if (act === 'resume') return startCloze(all.filter(id => !qSt(id)), { title: ttl });
    return startCloze(all, { title: ttl });
  }
  switch (t.dataset.pact) {
    case 'retest': S.punit = null; return startCloze(ordered(wrongIds()), { retest: true });
    case 'back': S.pview = 'main'; S.punit = null; return render();
  }
  if (t.dataset.start) return startSession(t.dataset.start);
  if (t.dataset.speak) return speak(t.dataset.speak);
  const s = S.session; if (!s) return;
  if (s.kind === 'cz') return czClick(t, s);
  if (t.dataset.pick !== undefined && s.q && s.q.picked === null) {
    const i = +t.dataset.pick, w = curWord(), correct = s.q.opts[i].id === w.id, ms = Date.now() - s.q.t0;
    s.q.picked = i; s.q.result = correct; render(); s.q.ms = ms; return;
  }
  switch (t.dataset.act) {
    case 'quit': if (!s.results.length || s.pos >= s.queue.length || confirm('要離開嗎?已完成的題目會保留。')) endSession(); break;
    case 'next':
      if (s.mode === 'mcq') { const q = s.q; await answerCurrent(q.result ? (q.ms < 2500 ? 4 : 3) : 1, { ms: q.ms, correct: q.result }); }
      else { const r = s.spellResult; await answerCurrent(r.kind === 'ok' ? (s.hintUsed ? 2 : 3) : r.kind === 'typo' ? 2 : 1, { answer: r.user, correct: r.kind === 'ok' }); s.hintUsed = false; }
      break;
    case 'hint': s.hint = true; s.hintUsed = true; { const v = $('#spell-in')?.value; renderSpell(document.querySelector('.topbar').outerHTML, curWord()); if ($('#spell-in')) $('#spell-in').value = v || ''; } break;
    case 'giveup': s.spellResult = { kind: 'wrong', user: '', best: curWord().w, gaveUp: true }; render(); break;
    case 'again': startSession(s.mode, s.practice); break;
  }
});
document.addEventListener('submit', e => {
  if (e.target.id !== 'spell-form') return; e.preventDefault();
  const s = S.session, v = $('#spell-in').value; if (!v.trim()) return;
  s.spellResult = checkSpelling(v, curWord()); render();
});
document.addEventListener('keydown', e => {
  const s = S.session; if (!s) return;
  if (s.kind === 'cz') {
    if (s.cur?.result === null && '1234'.includes(e.key) && s.cur.opts?.[+e.key - 1]) $(`[data-xpick="${+e.key - 1}"]`)?.click();
    else if (e.key === 'Enter' && s.cur?.result != null) { e.preventDefault(); $('[data-xact="next"]')?.click(); }
    return;
  }
  if (e.key === 'Enter' && s.mode === 'spell' && s.spellResult) { e.preventDefault(); $('[data-act="next"]')?.click(); }
  else if (s.mode === 'mcq' && s.q && s.q.picked === null && '1234'.includes(e.key) && s.q.opts[+e.key - 1]) { $(`[data-pick="${+e.key - 1}"]`)?.click(); }
  else if (s.mode === 'mcq' && s.q?.picked !== null && e.key === 'Enter') { $('[data-act="next"]')?.click(); }
});

/* ---------- boot ---------- */
async function boot(reload = false) {
  if (!reload) await store.init();
  S.settings = { ...DEFAULTS, ...(await store.getKV('settings') || {}) };
  S.daily = (await store.getKV('daily')) || {};
  if (!S.settings.startDate) { const ks = Object.keys(S.daily).filter(k => /^\d{4}-\d\d-\d\d$/.test(k)).sort(); S.settings.startDate = ks[0] || dayKey(); store.setKV('settings', S.settings); }
  S.cards = await store.allCards(); S.session = null; makeFsrs();
  S.modes = new Map(); S.spellOK = new Set();
  const logs = await store.allLogs();
  for (const lg of logs) { // rebuild "which modes has each word been answered in" from the review log
    if ((lg.source !== 'mcq' && lg.source !== 'spell') || lg.wid == null) continue;
    noteAnswer(lg.wid, lg.source, lg.correct === true || (lg.correct === undefined && lg.rating >= 3));
  }
  if (!reload) await Promise.all([loadWords(), loadCloze()]);
  S.byDay = new Map(); // per-bank correct answers per day, from the log (needs words + questions loaded to know each answer's bank)
  for (const lg of logs) {
    if (lg.source === 'cloze') noteDay(lg.ts, qById[String(lg.cardId || '').slice(2)]?.bank, lg.rating >= 3);
    else if (lg.source === 'mcq' || lg.source === 'spell') noteDay(lg.ts, wordById[lg.wid != null ? lg.wid : String(lg.cardId || '').split(':').slice(1).join(':')]?.bank, lg.rating >= 3);
  }
  S.qstats = await store.allQ();
  render();
}
boot().catch(e => {
  console.error(e);
  app.innerHTML = `<div class="card" style="margin-top:30px"><h2>載入失敗</h2><p class="small muted">${esc(String(e && e.message || e))}</p><button class="btn block" id="reload-fix">清除快取並重新載入</button></div>`;
  $('#reload-fix').onclick = async () => { try { for (const k of await caches.keys()) if (k.startsWith('book3-')) await caches.delete(k); const rs = await navigator.serviceWorker.getRegistrations(); for (const r of rs) await r.unregister(); } catch { } location.reload(); };
}).then(() => { if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => { }); });
