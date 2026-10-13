// 日语 / 韩语释义包：不随扩展打包，用户选择该释义语言时从 GitHub Pages 下载，
// 校验 sha256 后缓存在 IndexedDB，之后离线可用。释义包是数据（TSV），不是代码。
// 数据来源：英文维基词典（Wiktextract / kaikki.org），CC BY-SA 4.0。
//
// 格式：词 \t 短释义 \t 较长释义（最多 3 行，行间用字面 \n 分隔）

import { t } from './i18n.js';

export const PACK_LANGS = ['ja', 'ko'];
const DEFAULT_BASE = 'https://alex-chan.github.io/inkling/glosspacks';

let mem = { lang: null, map: null };

async function packBase() {
  const { devConfig } = await chrome.storage.local.get('devConfig');
  return String(devConfig?.packBase || DEFAULT_BASE).replace(/\/+$/, '');
}

// ---------- IndexedDB ----------

let dbp = null;
function db() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open('inkling-packs', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('packs');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbp;
}
async function idb(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction('packs', mode);
    const r = fn(tx.objectStore('packs'));
    tx.oncomplete = () => resolve(r?.result);
    tx.onerror = () => reject(tx.error);
  });
}
const idbGet = (k) => idb('readonly', (s) => s.get(k));
const idbPut = (k, v) => idb('readwrite', (s) => s.put(v, k));
const idbDel = (k) => idb('readwrite', (s) => s.delete(k));

// ---------- 解析与校验 ----------

function parse(text) {
  const map = new Map();
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const [w, g, tr] = line.split('\t');
    if (w && g) map.set(w, { g, tr: tr ? tr.split('\\n') : [g] });
  }
  return map;
}

async function sha256Hex(buf) {
  const h = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function summary(lang, rec) {
  return { lang, version: rec.version, entries: rec.entries, size: rec.size, savedAt: rec.savedAt };
}

// 下载（或更新）某语言的释义包
export async function downloadPack(lang) {
  if (!PACK_LANGS.includes(lang)) throw new Error(t('pack_unknown', lang));
  const base = await packBase();
  let index;
  try {
    const r = await fetch(`${base}/index.json`, { cache: 'no-cache' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    index = await r.json();
  } catch (e) {
    throw new Error(t('pack_network', e.message));
  }
  const meta = index?.packs?.[lang];
  if (!meta?.file || !meta?.sha256) throw new Error(t('pack_unknown', lang));
  const cached = await idbGet(lang);
  if (cached && cached.sha256 === meta.sha256) return summary(lang, cached);

  let buf;
  try {
    const r = await fetch(`${base}/${meta.file}`, { cache: 'no-cache' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    buf = await r.arrayBuffer();
  } catch (e) {
    throw new Error(t('pack_network', e.message));
  }
  if ((await sha256Hex(buf)) !== meta.sha256) throw new Error(t('pack_checksum'));
  const text = new TextDecoder().decode(buf);
  const map = parse(text);
  const rec = { version: meta.version, sha256: meta.sha256, text, entries: map.size, size: buf.byteLength, savedAt: Date.now() };
  await idbPut(lang, rec);
  mem = { lang, map };
  return summary(lang, rec);
}

export async function packStatus() {
  const out = {};
  for (const lang of PACK_LANGS) {
    const rec = await idbGet(lang).catch(() => null);
    out[lang] = rec ? summary(lang, rec) : null;
  }
  return out;
}

export async function deletePack(lang) {
  await idbDel(lang);
  if (mem.lang === lang) mem = { lang: null, map: null };
  return true;
}

// 当前释义语言的词表（未下载时返回 null）
export async function packMap(lang) {
  if (mem.lang === lang && mem.map) return mem.map;
  const rec = await idbGet(lang).catch(() => null);
  if (!rec) return null;
  mem = { lang, map: parse(rec.text) };
  return mem.map;
}
