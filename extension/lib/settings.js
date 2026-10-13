// 设置的默认值与常量（background / options / popup 共用；content.js 自带一份精简副本）

export const PRESETS = [
  { label: '初中', value: 1500 },
  { label: '高中', value: 3500 },
  { label: '四级', value: 4500 },
  { label: '六级', value: 6000 },
  { label: '考研', value: 6500 },
  { label: '雅思/托福', value: 8000 },
  { label: '专八', value: 11000 },
  { label: 'GRE', value: 14000 },
];

export const LEVEL_MIN = 500;
export const LEVEL_MAX = 25000;

export const DEFAULTS = {
  enabled: true,
  disabledSites: [],          // hostname 列表
  level: 4500,                // 词频排名阈值 N
  displayMode: 'ruby',        // ruby | paren | underline
  knownWords: [],             // 熟词本（原形）
  learningWords: [],          // 生词本（原形）
  aiProvider: 'apikey',       // apikey | chatgpt
  apiBase: 'https://api.openai.com/v1',
  apiKey: '',
  apiModel: 'gpt-4o-mini',
  chatgptModel: '',
  autoAI: false,              // AI 优化注释（语境释义 + 难度分级）
  showPhonetic: false,        // 注释里显示美式音标
  autoSpeak: false,           // 打开词卡时自动朗读
  speechVoice: '',            // 朗读声音（空 = 自动选美式英语）
  speechRate: 0.9,            // 语速
  glossColor: '#000000',      // 释义颜色
  glossLanguage: 'zh',        // 释义语言：zh（内置）| ja | ko（释义包按需下载）
};

export const GLOSS_COLORS = [
  { label: '黑色', value: '#000000' },
  { label: '深灰', value: '#5f6368' },
  { label: '赭橙', value: '#b4541a' },
  { label: '红色', value: '#c62828' },
  { label: '绿色', value: '#2e7d32' },
  { label: '蓝色', value: '#1a5fb4' },
  { label: '紫色', value: '#7b3fbf' },
];

export const SETTING_KEYS = Object.keys(DEFAULTS);

export async function getSettings() {
  const s = await chrome.storage.local.get(SETTING_KEYS);
  return { ...DEFAULTS, ...s };
}

export function presetLabel(n) {
  const p = PRESETS.find((x) => x.value === n);
  return p ? p.label : '自定义';
}

// 滑杆用对数刻度：低端更细，高端更粗
const L0 = Math.log(LEVEL_MIN), L1 = Math.log(LEVEL_MAX);
export function sliderToLevel(pos /* 0..1000 */) {
  const v = Math.exp(L0 + (L1 - L0) * (pos / 1000));
  const step = v < 2000 ? 50 : v < 8000 ? 100 : 500;
  return Math.min(LEVEL_MAX, Math.max(LEVEL_MIN, Math.round(v / step) * step));
}
export function levelToSlider(level) {
  return Math.round(((Math.log(level) - L0) / (L1 - L0)) * 1000);
}

export function normalizeWordList(text) {
  const out = new Set();
  for (const line of String(text).split(/[\n,，;；]+/)) {
    const w = line.trim().toLowerCase();
    if (/^[a-z][a-z' -]{0,79}$/.test(w)) out.add(w);
  }
  return [...out];
}
