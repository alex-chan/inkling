// 离线词典（ECDICT 精简版）：懒加载为 Map，提供词形还原与批量查询

const NAME_RE = /(男子名|女子名|姓氏|人名)/;
const VARIANT_RE = /(的过去式|的过去分词|的现在分词|的复数|第三人称单数|的比较级|的最高级)/;

let loading = null;
let words = null;   // lower -> entry
let forms = null;   // variant -> lemma(lower)
let formIpa = null; // variant -> 美式 IPA
let ordered = null; // 按词频排序的小写基础词（用于示例词、小测）

function parseDict(text) {
  const map = new Map();
  const list = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    const [w, ph, tr, rank, tags, us] = line.split('\t');
    const lower = w.toLowerCase();
    const lines = tr.split('\\n');
    const e = {
      w, ph, us: us || '', tr: lines, r: Number(rank) || 30000, t: tags || '',
      name: lines.every((l) => NAME_RE.test(l)),
      cap: w !== lower, hasCap: false,
    };
    const old = map.get(lower);
    if (!old) {
      map.set(lower, e);
    } else if (old.cap && !e.cap) {
      e.hasCap = true; // 例如 Turkey / turkey 都存在
      map.set(lower, e);
    } else if (!old.cap && e.cap) {
      old.hasCap = true;
    }
    if (!e.cap) list.push(e);
  }
  return { map, list };
}

export function ensureLoaded() {
  if (words) return Promise.resolve();
  if (!loading) {
    loading = (async () => {
      const [d, f] = await Promise.all([
        fetch(chrome.runtime.getURL('data/dict.tsv')).then((r) => r.text()),
        fetch(chrome.runtime.getURL('data/forms.tsv')).then((r) => r.text()),
      ]);
      const parsed = parseDict(d);
      const fm = new Map();
      const fi = new Map();
      for (const line of f.split('\n')) {
        const [v, l, ipa] = line.split('\t');
        if (!l) continue;
        fm.set(v, l);
        if (ipa) fi.set(v, ipa);
      }
      words = parsed.map;
      forms = fm;
      formIpa = fi;
      ordered = parsed.list.filter((e) => !e.name && !VARIANT_RE.test(e.tr.join(' ')));
    })().catch((err) => { loading = null; throw err; });
  }
  return loading;
}

// 规则兜底：forms.tsv 未收录时尝试常见屈折变化
function ruleLemma(t) {
  const c = [];
  const n = t.length;
  if (n > 4 && t.endsWith('ies')) c.push(t.slice(0, -3) + 'y');
  if (n > 4 && t.endsWith('ied')) c.push(t.slice(0, -3) + 'y');
  if (n > 3 && t.endsWith('es')) c.push(t.slice(0, -2));
  if (n > 3 && t.endsWith('s') && !t.endsWith('ss')) c.push(t.slice(0, -1));
  if (n > 4 && t.endsWith('ed')) {
    c.push(t.slice(0, -2), t.slice(0, -1));
    if (t[n - 3] === t[n - 4]) c.push(t.slice(0, -3));
  }
  if (n > 5 && t.endsWith('ing')) {
    c.push(t.slice(0, -3), t.slice(0, -3) + 'e');
    if (t[n - 4] === t[n - 5]) c.push(t.slice(0, -4));
  }
  if (n > 4 && t.endsWith('er')) c.push(t.slice(0, -2), t.slice(0, -1));
  if (n > 5 && t.endsWith('est')) c.push(t.slice(0, -3), t.slice(0, -2));
  if (n > 5 && t.endsWith('ly')) c.push(t.slice(0, -2));
  return c.find((x) => words.has(x) && !words.get(x).cap) || null;
}

export function shortGloss(tr) {
  for (const line of tr) {
    let s = line.replace(/^[a-z]+\.\s*/i, '').replace(/^\[[^\]]*\]\s*/, '');
    s = s.replace(/[（(][^）)]*[）)]|<[^>]*>|\[[^\]]*\]|【[^】]*】/g, '').trim();
    const first = s.split(/[,，;；]/)[0].trim();
    if (first) return first.length > 10 ? first.slice(0, 9) + '…' : first;
  }
  return '';
}

function infoFor(token) {
  const surface = words.get(token) || null;
  let lemmaKey = forms.get(token) || null;
  if (!lemmaKey && (!surface || surface.cap)) lemmaKey = ruleLemma(token);
  const lemma = lemmaKey ? words.get(lemmaKey) : null;
  if (!surface && !lemma) return null;
  const variantOnly = surface && VARIANT_RE.test(surface.tr.join(' '));
  const display = surface && !variantOnly && !(surface.cap && lemma) ? surface : (lemma || surface);
  const ranks = [surface?.r, lemma?.r].filter((x) => x);
  const base = lemma || surface;
  return {
    w: display.w,
    l: base.w.toLowerCase(),
    ph: display.ph,
    // 所点词（含变形）本身的美式 IPA；没有时退回所显示词条的
    us: formIpa.get(token) || (surface && !surface.cap ? surface.us : '') || (display.w.toLowerCase() === token ? display.us : '') || '',
    lus: base.us || '',
    tr: display.tr,
    g: shortGloss(display.tr),
    r: Math.min(...ranks),
    t: (display.t || base.t || ''),
    cap: !!(surface ? surface.cap && !lemma : base.cap),
    // 词典里存在该拼写的首字母大写词条（如 Turkey、Reeves），句中大写时多为专有名词
    hasCap: !!(surface && (surface.cap || surface.hasCap)),
    name: !!(surface ? surface.name : base.name),
  };
}

export async function lookup(tokens) {
  await ensureLoaded();
  const out = {};
  for (const t of tokens) {
    const k = String(t).toLowerCase();
    if (!/^[a-z]{1,40}$/.test(k)) { out[k] = null; continue; }
    out[k] = infoFor(k);
  }
  return out;
}

export async function nearWords(level, count = 10) {
  await ensureLoaded();
  let lo = 0, hi = ordered.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (ordered[m].r < level) lo = m + 1; else hi = m; }
  const pool = ordered.slice(Math.max(0, lo - 60), lo + 60).filter((e) => e.w.length >= 4 && e.t);
  const pick = [];
  const step = Math.max(1, Math.floor(pool.length / count));
  for (let i = 0; i < pool.length && pick.length < count; i += step) pick.push(pool[i]);
  return pick.map((e) => ({ w: e.w, r: e.r, g: shortGloss(e.tr), known: e.r <= level }));
}

export const QUIZ_BANDS = [
  [1, 1000], [1000, 2000], [2000, 3500], [3500, 5000], [5000, 7000],
  [7000, 9500], [9500, 12500], [12500, 16000], [16000, 20000], [20000, 25000],
];

export async function quizWords() {
  await ensureLoaded();
  const out = [];
  QUIZ_BANDS.forEach(([a, b], band) => {
    const pool = ordered.filter((e) => e.r >= a && e.r < b && e.w.length >= 4 && (e.t || a > 12000));
    const chosen = new Set();
    while (chosen.size < Math.min(4, pool.length)) chosen.add(pool[Math.floor(Math.random() * pool.length)]);
    for (const e of chosen) out.push({ band, w: e.w, g: shortGloss(e.tr) });
  });
  return out;
}

// answers: [{band, known:boolean}]
export function estimateLevel(answers) {
  let total = 0;
  QUIZ_BANDS.forEach(([a, b], band) => {
    const items = answers.filter((x) => x.band === band);
    if (!items.length) return;
    total += (b - a) * (items.filter((x) => x.known).length / items.length);
  });
  return Math.max(500, Math.min(25000, Math.round(total / 100) * 100));
}
