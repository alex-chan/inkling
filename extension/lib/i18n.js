// 界面多语言：简体中文 / 繁體中文 / English
// chrome.i18n 只跟随浏览器语言、不能运行时切换，所以这里直接读取 _locales/*/messages.json，
// 支持设置页里手动选择语言（storage.local.uiLanguage：auto | zh_CN | zh_TW | en）。
// 文案总表在 tools/i18n_table.py，占位符为 {0} {1}。

export const UI_LANGUAGES = [
  ['zh_CN', '简体中文'],
  ['zh_TW', '繁體中文'],
  ['en', 'English'],
];
const SUPPORTED = UI_LANGUAGES.map(([k]) => k);
const FALLBACK = 'zh_CN';

let current = null;
let messages = {};
let fallback = null;
let loading = null;

export function resolveLocale(pref) {
  if (SUPPORTED.includes(pref)) return pref;
  const ui = (chrome.i18n?.getUILanguage?.() || navigator.language || '').replace('-', '_');
  if (/^zh_(TW|HK|MO)|^zh_Hant/i.test(ui)) return 'zh_TW';
  if (/^zh/i.test(ui)) return 'zh_CN';
  return 'en';
}

async function load(loc) {
  const r = await fetch(chrome.runtime.getURL(`_locales/${loc}/messages.json`));
  const j = await r.json();
  return Object.fromEntries(Object.entries(j).map(([k, v]) => [k, v.message]));
}

// pref 省略时读取设置
export function initI18n(pref) {
  loading = (async () => {
    if (pref === undefined) ({ uiLanguage: pref } = await chrome.storage.local.get('uiLanguage'));
    const loc = resolveLocale(pref);
    if (!fallback) fallback = await load(FALLBACK);
    if (loc !== current) {
      messages = loc === FALLBACK ? fallback : await load(loc);
      current = loc;
    }
    return current;
  })();
  return loading;
}

// 后台：首次使用前确保已加载；设置变化时重新加载
export function ready() {
  // 语言刚切换时 loading 是新一轮加载，等它完成再答复，避免返回旧语言
  return loading || initI18n();
}
if (globalThis.chrome?.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && 'uiLanguage' in changes) initI18n(changes.uiLanguage.newValue);
  });
}

export function locale() {
  return current || FALLBACK;
}

export function allMessages() {
  return { ...fallback, ...messages };
}

export function t(key, ...subs) {
  const s = messages[key] ?? fallback?.[key] ?? key;
  return s.replace(/\{(\d)\}/g, (_, i) => (subs[i] ?? ''));
}

// 带占位节点的文案：t 的结果按 {n} 切开，插入给定的 DOM 节点
export function tNodes(key, ...nodes) {
  const s = messages[key] ?? fallback?.[key] ?? key;
  const frag = document.createDocumentFragment();
  let last = 0;
  for (const m of s.matchAll(/\{(\d)\}/g)) {
    frag.append(s.slice(last, m.index));
    const n = nodes[Number(m[1])];
    if (n != null) frag.append(n);
    last = m.index + m[0].length;
  }
  frag.append(s.slice(last));
  return frag;
}

// 页面上的静态文案：data-i18n（文字）、data-i18n-title / -aria / -placeholder（属性）
export function applyI18n(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const [attr, name] of [['i18nTitle', 'title'], ['i18nAria', 'aria-label'], ['i18nPlaceholder', 'placeholder']]) {
    for (const el of root.querySelectorAll(`[data-${name === 'aria-label' ? 'i18n-aria' : `i18n-${name}`}]`)) {
      el.setAttribute(name, t(el.dataset[attr]));
    }
  }
  if (root === document) {
    document.documentElement.lang = { zh_CN: 'zh-CN', zh_TW: 'zh-TW', en: 'en' }[locale()];
    const title = document.querySelector('title[data-i18n]');
    if (title) document.title = t(title.dataset.i18n);
  }
}

// 词频档位名（界面显示用；提示词里仍用 settings.js 中的中文档位名）
export function presetName(n) {
  const k = `preset_${n}`;
  return (messages[k] ?? fallback?.[k]) ? t(k) : t('custom');
}
