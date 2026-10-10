import { PRESETS, getSettings, sliderToLevel, levelToSlider, presetLabel } from './lib/settings.js';
import { DEFAULT_MATCHES, matchesAny, originPattern } from './lib/sites.js';

const $ = (id) => document.getElementById(id);
let S = await getSettings();
let host = '';
let tabUrl = '';
let tabId = 0;
let covered = false; // 当前网站是否已能运行（默认网站或已授权）

try {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  // 测试用：popup.html?url=… 可指定"当前网页"
  tabUrl = new URLSearchParams(location.search).get('url') || tab.url;
  tabId = tab.id;
  const u = new URL(tabUrl);
  if (/^https?:$/.test(u.protocol)) host = u.hostname;
} catch { /* 非网页标签 */ }

async function checkCovered() {
  if (!host) return false;
  if (matchesAny(tabUrl, DEFAULT_MATCHES)) return true;
  const { enabledSites = [], devConfig } = await chrome.storage.local.get(['enabledSites', 'devConfig']);
  const pats = [...enabledSites, ...(devConfig?.extraSites || [])];
  return matchesAny(tabUrl, pats) && await chrome.permissions.contains({ origins: [originPattern(tabUrl)] });
}
covered = await checkCovered();

for (const p of PRESETS) $('preset').add(new Option(`${p.label}（${p.value}）`, p.value));
$('preset').add(new Option('自定义', 'custom'));

function render() {
  $('enabled').checked = S.enabled;
  $('body').classList.toggle('dim', !S.enabled);
  $('host').textContent = host || '此页面';
  $('siteRow').hidden = !!host && !covered;
  $('grantRow').hidden = !host || covered;
  $('grantHost').textContent = host;
  $('siteOn').checked = !!host && covered && !S.disabledSites.includes(host);
  $('siteOn').disabled = !host;
  $('level').value = levelToSlider(S.level);
  $('levelVal').textContent = S.level;
  $('levelName').textContent = presetLabel(S.level);
  $('preset').value = PRESETS.some((p) => p.value === S.level) ? String(S.level) : 'custom';
  for (const r of document.querySelectorAll('input[name=mode]')) r.checked = r.value === S.displayMode;
  $('counts').textContent = `熟词 ${S.knownWords.length} · 生词 ${S.learningWords.length}`;
}

async function renderAI() {
  const dot = $('aiDot');
  const text = $('aiText');
  dot.className = 'dot';
  if (S.aiProvider === 'chatgpt') {
    const res = await chrome.runtime.sendMessage({ type: 'chatgptStatus' });
    const st = res?.data || {};
    if (st.signedIn && st.planEnabled) {
      dot.classList.add('ok');
      text.textContent = `正在使用 ChatGPT 套餐用量${S.chatgptModel ? ' · ' + S.chatgptModel : ''}`;
    } else if (st.signedIn) {
      dot.classList.add('warn');
      text.textContent = '已登录 ChatGPT，但未授权套餐用量';
    } else {
      dot.classList.add('warn');
      text.textContent = 'ChatGPT 未登录';
    }
  } else if (S.apiKey) {
    dot.classList.add('ok');
    text.textContent = `API Key · ${S.apiModel || '未选模型'}`;
  } else {
    text.textContent = '未配置（可在设置中填写 API Key 或登录 ChatGPT）';
  }
  const configured = S.aiProvider === 'chatgpt' ? dot.classList.contains('ok') : !!S.apiKey;
  $('autoAI').checked = S.autoAI;
  $('autoAI').disabled = !configured && !S.autoAI;
  $('autoRow').title = configured ? '用量会明显增加' : '先在设置里接入大模型';
}
$('autoAI').addEventListener('change', (e) => save({ autoAI: e.target.checked }));

const save = (patch) => { Object.assign(S, patch); render(); return chrome.storage.local.set(patch); };

$('enabled').addEventListener('change', (e) => save({ enabled: e.target.checked }));
$('grantBtn').addEventListener('click', () => {
  // 必须在点击事件里直接发起授权请求
  chrome.permissions.request({ origins: [originPattern(tabUrl)] }).then(async (ok) => {
    if (!ok) { $('grantErr').textContent = '没有获得授权'; return; }
    const res = await chrome.runtime.sendMessage({ type: 'enableSite', url: tabUrl, tabId });
    if (!res?.ok) { $('grantErr').textContent = res?.error?.message || '启用失败'; return; }
    covered = true;
    S = await getSettings();
    render();
  });
});
$('siteOn').addEventListener('change', (e) => {
  const set = new Set(S.disabledSites);
  e.target.checked ? set.delete(host) : set.add(host);
  save({ disabledSites: [...set] });
});
let levelTimer = 0;
$('level').addEventListener('input', (e) => {
  S.level = sliderToLevel(Number(e.target.value));
  $('levelVal').textContent = S.level;
  $('levelName').textContent = presetLabel(S.level);
  clearTimeout(levelTimer);
  levelTimer = setTimeout(() => save({ level: S.level }), 150);
});
$('preset').addEventListener('change', (e) => { if (e.target.value !== 'custom') save({ level: Number(e.target.value) }); });
for (const r of document.querySelectorAll('input[name=mode]')) r.addEventListener('change', () => save({ displayMode: r.value }));
$('openOptions').addEventListener('click', () => { chrome.runtime.openOptionsPage(); window.close(); });

render();
renderAI();
