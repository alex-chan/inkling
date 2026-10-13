// 大模型统一入口：语境解释（流式）与段落级注释优化（释义 + 分级，JSON，并发 2，带缓存）

import { t, locale } from './i18n.js';

import { getSettings, PRESETS } from './settings.js';
import { AIError } from './sse.js';
import * as compat from './openai-compat.js';
import * as chatgpt from './chatgpt.js';

export const EXPLAIN_PROMPT = `你是面向{{NATIVE}}母语读者的英语阅读助手。读者在英文文章里遇到一个词或短语，请结合上下文解释它在这句话里的意思。
{{READER}}用法说明请用这个水平的读者能看懂的说法。
用{{LANG}}，严格按下面的格式输出，总长不超过 {{LEN}}：
{{L0}}：……
{{L1}}：/美式 IPA/
{{L2}}：……（词性、常见搭配，一句话）
{{L3}}：……（只在涉及文化、时事、典故或专有背景时写，否则整行省略）
不要寒暄，不要复述原句，不要使用 Markdown 标题。`;

// 段落级优化：在词典初筛的基础上，按读者水平和语境重新判断该注释哪些表达
export const ANNOTATE_PROMPT = `你是英语阅读助手，帮助{{NATIVE}}母语读者读英文文章。{{READER}}
下面有若干段英文，用 [P1]、[P2] 标出；每段后面附有词典按词频初筛出的「候选生词」。
请结合语境，找出这位读者读不懂、需要注释的表达：
1. 候选生词里确实超出读者水平的保留；人名、地名、机构名，以及这个水平的读者大概率认识、或能从构词轻松猜出的，去掉。
2. 补充候选里没有、但在本句中用的是不常见意思的常见词（熟词僻义），例如 "markets brace for…" 里的 brace（准备应对）。
3. 补充意思不能从字面推出的短语动词、习语和固定搭配，例如 rule out、in the wake of。
每条给出：
- p：段落编号（数字）
- text：文中原样出现的连续文本，大小写与原文一致，不要改写或省略中间的词
- gloss：本句语境下的{{LANG}}释义，不超过 {{GLEN}}
- level：CEFR 难度等级，A1、A2、B1、B2、C1、C2 之一
- kind：word（生词）、sense（熟词僻义）、phrase（短语/习语）之一
宁缺毋滥，每段最多 12 条。只输出 JSON：{"items":[{"p":1,"text":"…","gloss":"…","level":"B2","kind":"word"}]}，不要输出其他内容。`;

const CEFR_BY_LEVEL = [[1500, 'A2'], [3500, 'B1'], [4500, 'B1–B2'], [6500, 'B2'], [8000, 'B2–C1'], [11000, 'C1'], [Infinity, 'C2']];

export function readerProfile(level) {
  const preset = [...PRESETS].reverse().find((p) => p.value <= level);
  const cefr = CEFR_BY_LEVEL.find(([n]) => level <= n)[1];
  return `读者的英语词汇量约 ${level} 词（${preset ? `约${preset.label}水平` : '初学'}，相当于 CEFR ${cefr}）。`;
}

// 输出语言：释义语言为日语 / 韩语时跟随释义语言；中文时按界面区分简繁
const OUTPUT = {
  zh_CN: { lang: '简体中文', native: '中文', labels: ['本句含义', '读音', '用法', '背景'], len: '120 字', glen: '8 个汉字' },
  zh_TW: { lang: '繁體中文', native: '中文', labels: ['本句含義', '讀音', '用法', '背景'], len: '120 字', glen: '8 个汉字' },
  ja: { lang: '日本語', native: '日语', labels: ['この文での意味', '発音', '用法', '背景'], len: '150 字', glen: '10 个字符' },
  ko: { lang: '한국어', native: '韩语', labels: ['이 문장에서의 뜻', '발음', '용법', '배경'], len: '150 字', glen: '10 个字符' },
};
function outputSpec(glossLanguage) {
  if (glossLanguage === 'ja' || glossLanguage === 'ko') return OUTPUT[glossLanguage];
  return locale() === 'zh_TW' ? OUTPUT.zh_TW : OUTPUT.zh_CN;
}
function fillPrompt(tpl, level, glossLanguage) {
  const o = outputSpec(glossLanguage);
  return tpl.replace('{{READER}}', readerProfile(level)).replace(/{{LANG}}/g, o.lang).replace('{{NATIVE}}', o.native)
    .replace('{{LEN}}', o.len).replace('{{GLEN}}', o.glen)
    .replace('{{L0}}', o.labels[0]).replace('{{L1}}', o.labels[1]).replace('{{L2}}', o.labels[2]).replace('{{L3}}', o.labels[3]);
}

function explainInput({ text, context }) {
  return `词语：${text}\n上下文：${context || '（无）'}`;
}

async function run({ system, user, onDelta, signal, temperature }) {
  const s = await getSettings();
  if (s.aiProvider === 'chatgpt') {
    return chatgpt.respond({ model: s.chatgptModel, instructions: system, input: user, onDelta, signal });
  }
  return compat.chat({ apiBase: s.apiBase, apiKey: s.apiKey, model: s.apiModel, system, user, onDelta, signal, temperature });
}

export async function explain(req, onDelta, signal) {
  const { level, glossLanguage } = await getSettings();
  return run({ system: fillPrompt(EXPLAIN_PROMPT, level, glossLanguage), user: explainInput(req), onDelta, signal });
}

// ---------- 并发限制 ----------

const MAX_CONCURRENT = 2;
let active = 0;
const queue = [];
function acquire() {
  if (active < MAX_CONCURRENT) { active++; return Promise.resolve(); }
  return new Promise((r) => queue.push(r));
}
function release() {
  const next = queue.shift();
  if (next) next(); else active--;
}

// ---------- IndexedDB 缓存 ----------

let dbp = null;
function db() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open('inkling', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('ai');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbp;
}
async function cacheGet(key) {
  const d = await db();
  return new Promise((resolve) => {
    const r = d.transaction('ai').objectStore('ai').get(key);
    r.onsuccess = () => resolve(r.result?.v);
    r.onerror = () => resolve(undefined);
  });
}
async function cachePut(key, v) {
  const d = await db();
  const store = d.transaction('ai', 'readwrite').objectStore('ai');
  store.put({ v, t: Date.now() }, key);
  const c = store.count();
  c.onsuccess = () => {
    if (c.result < 4000) return;
    // 超过上限时删掉最早的一批
    const items = [];
    const cur = d.transaction('ai').objectStore('ai').openCursor();
    cur.onsuccess = () => {
      const x = cur.result;
      if (x) { items.push([x.key, x.value.t]); x.continue(); return; }
      items.sort((a, b) => a[1] - b[1]);
      const del = d.transaction('ai', 'readwrite').objectStore('ai');
      for (const [k] of items.slice(0, 1000)) del.delete(k);
    };
  };
}
async function hash(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function parseJson(text) {
  const s = text.replace(/```(?:json)?/gi, '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) throw new AIError(t('no_json'));
  return JSON.parse(s.slice(a, b + 1));
}

const KINDS = new Set(['word', 'sense', 'phrase']);

// 校验模型输出：文本必须真的出现在对应段落里
function cleanItems(raw, paras) {
  const out = paras.map(() => []);
  for (const it of Array.isArray(raw?.items) ? raw.items : []) {
    const p = Number(it?.p) - 1;
    const text = String(it?.text || '').trim();
    const gloss = String(it?.gloss || '').trim().replace(/[。.]$/, '');
    if (!(p >= 0 && p < paras.length) || !text || !gloss || text.length > 60) continue;
    if (!/[A-Za-z]/.test(text) || !paras[p].text.toLowerCase().includes(text.toLowerCase())) continue;
    const level = String(it.level || '').toUpperCase();
    const item = {
      text,
      gloss: gloss.slice(0, 12),
      level: /^[ABC][12]$/.test(level) ? level : '',
      kind: KINDS.has(it.kind) ? it.kind : (/\s/.test(text) ? 'phrase' : 'word'),
    };
    // 同一表达重复出现时，保留更具体的（熟词僻义/短语优先于普通生词）
    const dup = out[p].findIndex((x) => x.text.toLowerCase() === text.toLowerCase());
    if (dup >= 0) {
      if (out[p][dup].kind === 'word' && item.kind !== 'word') out[p][dup] = item;
      continue;
    }
    if (out[p].length < 15) out[p].push(item);
  }
  return out;
}

const levelBucket = (n) => Math.round(n / 500) * 500;
let pausedUntil = 0; // 用量超限后暂停自动注释

// paras: [{ text, cands: [候选生词] }] → [{ items }]（与 paras 一一对应）
export async function annotate({ paras }) {
  if (Date.now() < pausedUntil) throw new AIError(t('usage_paused'), { code: 'usage_paused' });
  const s = await getSettings();
  const model = s.aiProvider === 'chatgpt' ? s.chatgptModel : s.apiModel;
  const list = paras.slice(0, 6).map((x) => ({
    text: String(x.text || '').slice(0, 2500),
    cands: [...new Set((x.cands || []).map((w) => String(w).toLowerCase()))].slice(0, 40),
  }));
  const keys = await Promise.all(list.map((x) => hash(`v2|${s.aiProvider}|${model}|${outputSpec(s.glossLanguage).lang}|${levelBucket(s.level)}|${x.text}|${x.cands.join(',')}`)));
  const results = await Promise.all(keys.map((k) => cacheGet(k)));
  const todo = list.map((x, i) => i).filter((i) => !results[i]);
  if (!todo.length) return results;
  await acquire();
  try {
    const user = todo.map((i, n) => `[P${n + 1}] ${list[i].text}\n候选生词：${list[i].cands.join(', ') || '（无）'}`).join('\n\n');
    const out = await run({
      system: fillPrompt(ANNOTATE_PROMPT, s.level, s.glossLanguage),
      user,
      temperature: 0.2,
    });
    const items = cleanItems(parseJson(out), todo.map((i) => list[i]));
    await Promise.all(todo.map((i, n) => {
      results[i] = { items: items[n] };
      return cachePut(keys[i], results[i]);
    }));
    return results;
  } catch (e) {
    if (e?.code === 'subscription_sharing_usage_limit_exceeded' || /429/.test(e?.message || '')) pausedUntil = Date.now() + 15 * 60e3;
    throw e;
  } finally {
    release();
  }
}

export async function listModels(provider, opts) {
  if (provider === 'chatgpt') return chatgpt.listModels();
  return compat.listModels(opts);
}

export async function testConnection(provider, opts) {
  const t0 = Date.now();
  let text;
  if (provider === 'chatgpt') {
    const s = await getSettings();
    text = await chatgpt.respond({ model: opts.model || s.chatgptModel, instructions: '你是连接测试助手。', input: '只回复两个字母：OK' });
  } else {
    text = await compat.chat({ ...opts, system: '你是连接测试助手。', user: '只回复两个字母：OK', temperature: 0 });
  }
  return { ok: true, ms: Date.now() - t0, reply: text.trim().slice(0, 40) };
}
