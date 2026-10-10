import {
  GLOSS_COLORS, PRESETS, LEVEL_MIN, LEVEL_MAX, getSettings, sliderToLevel, levelToSlider, presetLabel, normalizeWordList,
} from './lib/settings.js';
import { DEFAULT_SITES } from './lib/sites.js';

const $ = (id) => document.getElementById(id);
let S = await getSettings();

async function call(type, extra = {}) {
  const res = await chrome.runtime.sendMessage({ type, ...extra });
  if (!res?.ok) throw Object.assign(new Error(res?.error?.message || '出错了'), res?.error || {});
  return res.data;
}
function setStatus(el, text, kind = '') {
  el.textContent = text;
  el.className = `status ${kind}`;
}
const save = (patch) => { Object.assign(S, patch); return chrome.storage.local.set(patch); };

// ---------------- 总开关 ----------------

$('enabled').checked = S.enabled;
$('enabled').addEventListener('change', (e) => save({ enabled: e.target.checked }));

// ---------------- 支持的网站 ----------------

$('defaultSites').replaceChildren(...DEFAULT_SITES.map(([name, pats]) => {
  const c = document.createElement('span');
  c.className = 'chip word-chip';
  c.textContent = name;
  c.title = pats.join('\n');
  return c;
}));
async function renderExtraSites() {
  const { enabledSites = [] } = await chrome.storage.local.get('enabledSites');
  $('extraEmpty').hidden = enabledSites.length > 0;
  $('extraSites').replaceChildren(...enabledSites.map((p) => {
    const c = document.createElement('span');
    c.className = 'chip word-chip';
    c.textContent = p.replace(/^https?:\/\//, '').replace(/\/\*$/, '') + ' ';
    const x = document.createElement('button');
    x.className = 'btn link small';
    x.textContent = '移除';
    x.setAttribute('aria-label', `移除 ${p}`);
    x.addEventListener('click', () => call('disableSite', { pattern: p }).then(renderExtraSites));
    c.append(x);
    return c;
  }));
}
renderExtraSites();

// ---------------- 词汇水平 ----------------

for (const p of PRESETS) {
  const b = document.createElement('button');
  b.className = 'chip';
  b.type = 'button';
  b.dataset.value = p.value;
  b.textContent = `${p.label} ${p.value}`;
  b.addEventListener('click', () => setLevel(p.value, true));
  $('presets').append(b);
}

let nearTimer = 0;
function renderLevel() {
  $('levelVal').textContent = S.level;
  $('levelName').textContent = presetLabel(S.level);
  $('level').value = levelToSlider(S.level);
  $('levelNum').value = S.level;
  for (const b of $('presets').children) b.classList.toggle('on', Number(b.dataset.value) === S.level);
  clearTimeout(nearTimer);
  nearTimer = setTimeout(renderNear, 120);
}

async function renderNear() {
  try {
    const words = await call('nearWords', { level: S.level, count: 12 });
    $('near').replaceChildren(...words.map((w) => {
      const s = document.createElement('span');
      s.className = `chip word-chip ${w.known ? '' : 'unknown'}`;
      s.title = `词频 #${w.r}`;
      s.append(w.w);
      const em = document.createElement('em');
      em.textContent = w.g;
      s.append(em);
      return s;
    }));
  } catch { /* 词典加载失败时忽略 */ }
}

let saveTimer = 0;
function setLevel(v, immediate) {
  S.level = Math.max(LEVEL_MIN, Math.min(LEVEL_MAX, Math.round(v)));
  renderLevel();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => save({ level: S.level }), immediate ? 0 : 200);
}
$('level').addEventListener('input', (e) => setLevel(sliderToLevel(Number(e.target.value))));
$('levelNum').addEventListener('change', (e) => setLevel(Number(e.target.value) || 4500, true));
renderLevel();

// 小测
let quizItems = [];
$('quizStart').addEventListener('click', async () => {
  quizItems = await call('quiz');
  $('quizGrid').replaceChildren(...quizItems.map((q, i) => {
    const l = document.createElement('label');
    l.title = q.g;
    const c = document.createElement('input');
    c.type = 'checkbox';
    c.dataset.i = i;
    l.append(c, q.w);
    return l;
  }));
  $('quiz').hidden = false;
  $('quizStart').hidden = true;
  setStatus($('quizResult'), '');
});
$('quizCancel').addEventListener('click', () => { $('quiz').hidden = true; $('quizStart').hidden = false; });
$('quizDone').addEventListener('click', async () => {
  const answers = quizItems.map((q, i) => ({ band: q.band, known: $('quizGrid').querySelector(`input[data-i="${i}"]`).checked }));
  const { level } = await call('quizEstimate', { answers });
  setLevel(level, true);
  setStatus($('quizResult'), `估算词汇量约 ${level}（${presetLabel(level)}），已应用。`, 'ok');
  $('quizStart').hidden = false;
  $('quizStart').textContent = '再测一次';
});

// ---------------- 显示方式 ----------------

for (const r of document.querySelectorAll('input[name=mode]')) {
  r.checked = r.value === S.displayMode;
  r.addEventListener('change', () => save({ displayMode: r.value }));
}

// ---------------- 释义颜色 ----------------

for (const c of GLOSS_COLORS) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'swatch';
  b.setAttribute('role', 'radio');
  b.dataset.color = c.value;
  b.title = c.label;
  b.setAttribute('aria-label', c.label);
  b.style.background = c.value;
  b.addEventListener('click', () => setGlossColor(c.value));
  $('swatches').append(b);
}
function renderGlossColor() {
  const c = S.glossColor.toLowerCase();
  for (const b of $('swatches').children) b.setAttribute('aria-checked', String(b.dataset.color === c));
  $('glossColor').value = c;
  $('glossHex').textContent = c;
  for (const rt of $('glossPreview').querySelectorAll('rt')) rt.style.color = c;
}
function setGlossColor(c) {
  S.glossColor = c.toLowerCase();
  renderGlossColor();
  save({ glossColor: S.glossColor });
}
$('glossColor').addEventListener('input', (e) => { S.glossColor = e.target.value; renderGlossColor(); });
$('glossColor').addEventListener('change', (e) => setGlossColor(e.target.value));
renderGlossColor();

// ---------------- 音标与发音 ----------------

$('showPhonetic').checked = S.showPhonetic;
$('autoSpeak').checked = S.autoSpeak;
$('showPhonetic').addEventListener('change', (e) => save({ showPhonetic: e.target.checked }));
$('autoSpeak').addEventListener('change', (e) => save({ autoSpeak: e.target.checked }));

function renderRate() {
  $('speechRate').value = S.speechRate;
  $('rateVal').textContent = `${Number(S.speechRate).toFixed(2)}×`;
}
renderRate();
$('speechRate').addEventListener('input', (e) => { S.speechRate = Number(e.target.value); renderRate(); });
$('speechRate').addEventListener('change', () => save({ speechRate: S.speechRate }));

function renderVoices() {
  const voices = speechSynthesis.getVoices().filter((v) => /^en/i.test(v.lang))
    .sort((a, b) => (a.lang === 'en-US' ? 0 : 1) - (b.lang === 'en-US' ? 0 : 1) || a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name));
  const sel = $('speechVoice');
  sel.replaceChildren(new Option('自动（优先美式英语）', ''), ...voices.map((v) => new Option(`${v.name}（${v.lang}）`, v.name)));
  if (S.speechVoice && !voices.some((v) => v.name === S.speechVoice)) sel.add(new Option(`${S.speechVoice}（当前不可用）`, S.speechVoice));
  sel.value = S.speechVoice;
  $('voiceNote').textContent = voices.length
    ? `使用浏览器自带的语音合成，本机有 ${voices.length} 个英语声音。`
    : '没有检测到英语声音，朗读可能不可用。可以在系统设置里添加英语（美国）语音。';
}
renderVoices();
speechSynthesis.addEventListener('voiceschanged', renderVoices);
$('speechVoice').addEventListener('change', (e) => save({ speechVoice: e.target.value }));
$('tryVoice').addEventListener('click', () => {
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance('The tariffs were levied on steel.');
  u.lang = 'en-US';
  u.rate = S.speechRate;
  const v = speechSynthesis.getVoices().find((x) => x.name === S.speechVoice);
  if (v) { u.voice = v; u.lang = v.lang; }
  speechSynthesis.speak(u);
});
call('lookup', { tokens: ['tariff'] }).then((r) => {
  if (r.tariff?.us) $('phonPreview').textContent = `（例：tariff /${r.tariff.us}/ 关税）`;
}).catch(() => {});

// ---------------- 词表 ----------------

function renderLists() {
  $('knownList').value = S.knownWords.join('\n');
  $('learningList').value = S.learningWords.join('\n');
  $('knownCount').textContent = S.knownWords.length;
  $('learningCount').textContent = S.learningWords.length;
}
renderLists();
$('saveLists').addEventListener('click', async () => {
  const learningWords = normalizeWordList($('learningList').value);
  const learnSet = new Set(learningWords);
  // 同一个词不能同时在两本里：以生词本为准
  const knownWords = normalizeWordList($('knownList').value).filter((w) => !learnSet.has(w));
  await save({ knownWords, learningWords });
  renderLists();
  setStatus($('listStatus'), '已保存', 'ok');
  setTimeout(() => setStatus($('listStatus'), ''), 2000);
});
$('exportLists').addEventListener('click', () => {
  const data = { app: 'Inkling', exportedAt: new Date().toISOString(), knownWords: S.knownWords, learningWords: S.learningWords };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `inkling-words-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

// ---------------- 大模型 ----------------

function renderProvider() {
  for (const r of document.querySelectorAll('input[name=provider]')) r.checked = r.value === S.aiProvider;
  $('pcard-apikey').classList.toggle('active', S.aiProvider === 'apikey');
  $('pcard-chatgpt').classList.toggle('active', S.aiProvider === 'chatgpt');
}
for (const r of document.querySelectorAll('input[name=provider]')) {
  r.addEventListener('change', () => { save({ aiProvider: r.value }); renderProvider(); });
}
renderProvider();

// A. API Key
$('apiBase').value = S.apiBase;
$('apiKey').value = S.apiKey;
$('apiModel').value = S.apiModel;
const apiOpts = () => ({ provider: 'apikey', apiBase: $('apiBase').value.trim(), apiKey: $('apiKey').value.trim(), model: $('apiModel').value.trim() });
for (const id of ['apiBase', 'apiKey', 'apiModel']) {
  $(id).addEventListener('change', () => {
    const o = apiOpts();
    save({ apiBase: o.apiBase || 'https://api.openai.com/v1', apiKey: o.apiKey, apiModel: o.model });
  });
}
$('toggleKey').addEventListener('click', () => {
  const show = $('apiKey').type === 'password';
  $('apiKey').type = show ? 'text' : 'password';
  $('toggleKey').textContent = show ? '隐藏' : '显示';
});
// 自定义接口地址需要单独授权（必须在点击事件里同步发起请求）
function requestApiAccess() {
  let pattern;
  try {
    const u = new URL(apiOpts().apiBase);
    if (!/^https?:$/.test(u.protocol)) return Promise.resolve(true);
    pattern = `${u.protocol}//${u.hostname}/*`;
  } catch {
    return Promise.resolve(true); // 地址格式错误交给后台给出提示
  }
  return chrome.permissions.request({ origins: [pattern] }).then((ok) => {
    if (!ok) setStatus($('apiStatus'), `需要允许访问 ${new URL(apiOpts().apiBase).host} 才能使用这个接口地址`, 'err');
    return ok;
  }).catch(() => true);
}

$('fetchModels').addEventListener('click', async () => {
  if (!(await requestApiAccess())) return;
  setStatus($('apiStatus'), '正在获取模型列表…');
  $('fetchModels').disabled = true;
  try {
    const models = await call('listModels', apiOpts());
    $('apiModels').replaceChildren(...models.map((m) => new Option(m.name, m.id)));
    setStatus($('apiStatus'), `获取到 ${models.length} 个模型，可在「模型」输入框中选择。`, 'ok');
    if (!$('apiModel').value && models[0]) { $('apiModel').value = models[0].id; $('apiModel').dispatchEvent(new Event('change')); }
  } catch (e) {
    setStatus($('apiStatus'), e.message, 'err');
  } finally {
    $('fetchModels').disabled = false;
  }
});
$('testApi').addEventListener('click', async () => {
  if (!(await requestApiAccess())) return;
  setStatus($('apiStatus'), '正在测试…');
  $('testApi').disabled = true;
  try {
    const r = await call('testConnection', apiOpts());
    setStatus($('apiStatus'), `连接成功（${r.ms} ms），模型回复：${r.reply}`, 'ok');
  } catch (e) {
    setStatus($('apiStatus'), e.message, 'err');
  } finally {
    $('testApi').disabled = false;
  }
});

// B. ChatGPT
async function renderChatGPT() {
  const st = await call('chatgptStatus');
  $('cgSignedOut').hidden = st.signedIn;
  $('cgSignedIn').hidden = !st.signedIn;
  $('cgLoginOther').hidden = !st.hasClient;
  $('cgLogin').title = st.hasClient && st.lastEmail ? `上次登录：${st.lastEmail}` : '';
  $('cgError').hidden = !st.error;
  $('cgError').textContent = st.error;
  if (st.signedIn) {
    $('cgUsing').textContent = st.planEnabled ? '正在使用 ChatGPT 套餐用量' : '已登录，但未授权使用套餐用量';
    $('cgUsing').className = st.planEnabled ? 'ok' : 'warn';
    $('cgAccount').textContent = [st.name, st.email].filter(Boolean).join(' · ');
    $('cgModel').disabled = !st.planEnabled;
    $('cgTest').disabled = !st.planEnabled;
    if (st.planEnabled && !$('cgModel').options.length) loadChatGPTModels();
  }
}
async function loadChatGPTModels() {
  try {
    const models = await call('listModels', { provider: 'chatgpt' });
    $('cgModel').replaceChildren(...models.map((m) => new Option(m.name, m.id)));
    if (S.chatgptModel && models.some((m) => m.id === S.chatgptModel)) $('cgModel').value = S.chatgptModel;
    else if (models[0]) save({ chatgptModel: models[0].id });
    setStatus($('cgStatus'), '');
  } catch (e) {
    setStatus($('cgStatus'), e.message, 'err');
  }
}
$('cgModel').addEventListener('change', () => save({ chatgptModel: $('cgModel').value }));
$('cgFetchModels').addEventListener('click', loadChatGPTModels);
$('cgLogin').addEventListener('click', () => call('chatgptLogin', { newAccount: false }).catch((e) => setStatus($('cgStatus'), e.message, 'err')));
$('cgLoginOther').addEventListener('click', () => call('chatgptLogin', { newAccount: true }).catch((e) => setStatus($('cgStatus'), e.message, 'err')));
$('cgLogout').addEventListener('click', async () => {
  $('cgLogout').disabled = true;
  try {
    const r = await call('chatgptLogout');
    $('cgModel').replaceChildren();
    await renderChatGPT();
    setStatus($('cgStatus'), r.message, r.revoked ? 'ok' : 'warn');
  } finally {
    $('cgLogout').disabled = false;
  }
});
$('cgTest').addEventListener('click', async () => {
  setStatus($('cgStatus'), '正在测试…');
  try {
    const r = await call('testConnection', { provider: 'chatgpt', model: $('cgModel').value });
    setStatus($('cgStatus'), `连接成功（${r.ms} ms），模型回复：${r.reply}`, 'ok');
  } catch (e) {
    setStatus($('cgStatus'), e.message, 'err');
    if (e.needLogin) renderChatGPT();
  }
});
renderChatGPT();

// AI 优化注释
$('autoAI').checked = S.autoAI;
$('autoAI').addEventListener('change', (e) => save({ autoAI: e.target.checked }));

// ---------------- 外部变化同步 ----------------

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  for (const [k, { newValue }] of Object.entries(changes)) if (k in S) S[k] = newValue;
  if ('chatgptAuth' in changes || 'chatgptLastError' in changes) renderChatGPT();
  if ('aiProvider' in changes) renderProvider();
  if ('chatgptModel' in changes && S.chatgptModel) $('cgModel').value = S.chatgptModel;
  if ('knownWords' in changes || 'learningWords' in changes) renderLists();
  if ('level' in changes) renderLevel();
  if ('enabled' in changes) $('enabled').checked = S.enabled;
  if ('autoAI' in changes) $('autoAI').checked = S.autoAI;
  if ('glossColor' in changes) renderGlossColor();
  if ('enabledSites' in changes) renderExtraSites();
  if ('showPhonetic' in changes) $('showPhonetic').checked = S.showPhonetic;
  if ('autoSpeak' in changes) $('autoSpeak').checked = S.autoSpeak;
  if ('speechRate' in changes) renderRate();
  if ('speechVoice' in changes) $('speechVoice').value = S.speechVoice;
  if ('displayMode' in changes) for (const r of document.querySelectorAll('input[name=mode]')) r.checked = r.value === S.displayMode;
});

if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
