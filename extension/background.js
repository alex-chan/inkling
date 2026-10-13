// Inkling 墨点 —— service worker
import * as dict from './lib/dict.js';
import * as ai from './lib/ai.js';
import * as chatgpt from './lib/chatgpt.js';
import * as glosspack from './lib/glosspack.js';
import { errorPayload } from './lib/sse.js';
import { DEFAULT_MATCHES, matchesAny, originPattern } from './lib/sites.js';
import { t, ready, locale, allMessages, resolveLocale } from './lib/i18n.js';

// ---------- 用户自行启用的网站：动态注册 content script ----------
// 默认网站由 manifest 静态注入；其他网站需要用户在弹窗里授权（optional_host_permissions）。

const EXTRA_ID = 'inkling-extra-sites';

async function extraPatterns() {
  const { enabledSites = [], devConfig } = await chrome.storage.local.get(['enabledSites', 'devConfig']);
  const wanted = [...new Set([...enabledSites, ...(devConfig?.extraSites || [])])];
  const ok = [];
  for (const p of wanted) {
    if (await chrome.permissions.contains({ origins: [p] }).catch(() => false)) ok.push(p);
  }
  return ok;
}

let syncing = Promise.resolve();
function syncContentScripts() {
  syncing = syncing.then(async () => {
    const matches = await extraPatterns();
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [EXTRA_ID] }).catch(() => []);
    if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [EXTRA_ID] });
    if (matches.length) {
      await chrome.scripting.registerContentScripts([{
        id: EXTRA_ID, matches, js: ['content.js'], css: ['content.css'], runAt: 'document_idle', persistAcrossSessions: true,
      }]);
    }
  }).catch((e) => console.warn('Inkling: 注册 content script 失败', e));
  return syncing;
}

chrome.runtime.onStartup.addListener(syncContentScripts);
chrome.permissions.onAdded.addListener(syncContentScripts);
chrome.permissions.onRemoved.addListener(syncContentScripts);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && ('enabledSites' in changes || 'devConfig' in changes)) syncContentScripts();
});

// 弹窗授权成功后调用：记录网站、注册脚本、立即注入当前标签页
async function enableSite({ url, tabId }) {
  const pattern = originPattern(url);
  if (!(await chrome.permissions.contains({ origins: [pattern] }))) throw new Error(t('site_no_permission'));
  const { enabledSites = [], disabledSites = [] } = await chrome.storage.local.get(['enabledSites', 'disabledSites']);
  const host = new URL(url).hostname;
  await chrome.storage.local.set({
    enabledSites: [...new Set([...enabledSites, pattern])],
    disabledSites: disabledSites.filter((h) => h !== host),
  });
  await syncContentScripts();
  if (tabId) {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ['content.css'] }).catch(() => {});
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] }).catch(() => {});
  }
  return { pattern };
}

async function disableSite({ pattern }) {
  const { enabledSites = [] } = await chrome.storage.local.get('enabledSites');
  await chrome.storage.local.set({ enabledSites: enabledSites.filter((p) => p !== pattern) });
  // 默认网站与 OpenAI 的权限是必需权限，不能也无需移除
  if (!matchesAny(pattern.replace('/*', '/'), DEFAULT_MATCHES)) await chrome.permissions.remove({ origins: [pattern] }).catch(() => {});
  await syncContentScripts();
  return true;
}

// 默认值不写入存储：各处读取时都会与 DEFAULTS 合并
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  syncContentScripts();
  // 没有进行中的登录时，清掉可能残留的回调重定向规则
  const { chatgptPending } = await chrome.storage.session.get('chatgptPending');
  if (!chatgptPending || !Object.keys(chatgptPending).length) chatgpt.removeRedirectRule().catch(() => {});
  // 浏览器是日语 / 韩语时，首次安装顺便下载对应的释义包，并把释义语言设成它（失败则保持中文）
  if (reason === 'install') {
    const loc = resolveLocale();
    const { glossLanguage } = await chrome.storage.local.get('glossLanguage');
    if ((loc === 'ja' || loc === 'ko') && !glossLanguage) {
      glosspack.downloadPack(loc).then(() => chrome.storage.local.set({ glossLanguage: loc })).catch(() => {});
    }
  }
  if (reason === 'install') {
    const { devConfig } = await chrome.storage.local.get('devConfig');
    if (!devConfig?.noWelcome) chrome.runtime.openOptionsPage();
  }
});

// ---------- 普通消息 ----------

const handlers = {
  async lookup({ tokens }) { return dict.lookup(tokens); },
  async nearWords({ level, count }) { return dict.nearWords(level, count); },
  async quiz() { return dict.quizWords(); },
  async quizEstimate({ answers }) { return { level: dict.estimateLevel(answers) }; },
  async annotate({ paras }) { return ai.annotate({ paras }); },
  async listModels({ provider, apiBase, apiKey }) { return ai.listModels(provider, { apiBase, apiKey }); },
  async testConnection({ provider, apiBase, apiKey, model }) { return ai.testConnection(provider, { apiBase, apiKey, model }); },
  async chatgptStatus() { return chatgpt.status(); },
  async chatgptLogin({ newAccount }) { return chatgpt.startLogin({ newAccount }); },
  async chatgptLogout() { return chatgpt.logout(); },
  async authCallback({ search }) { return chatgpt.handleCallback(search); },
  async downloadPack({ lang }) { return glosspack.downloadPack(lang); },
  async packStatus() { return glosspack.packStatus(); },
  async deletePack({ lang }) { return glosspack.deletePack(lang); },
  async i18n() { return { locale: locale(), messages: allMessages() }; },
  async enableSite(msg) { return enableSite(msg); },
  async disableSite(msg) { return disableSite(msg); },
  async openOptions({ hash }) {
    await chrome.tabs.create({ url: chrome.runtime.getURL('options.html') + (hash ? '#' + hash : '') });
    return true;
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const h = handlers[msg?.type];
  if (!h) return false;
  ready()
    .then(() => h(msg, sender))
    .then((data) => sendResponse({ ok: true, data }))
    .catch((err) => sendResponse({ ok: false, error: errorPayload(err) }));
  return true;
});

// ---------- 流式：AI 语境解释 ----------

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'explain') return;
  const ctrl = new AbortController();
  let closed = false;
  port.onDisconnect.addListener(() => { closed = true; ctrl.abort(); });
  port.onMessage.addListener(async (req) => {
    try {
      await ready();
      await ai.explain(req, (delta) => { if (!closed) port.postMessage({ type: 'delta', text: delta }); }, ctrl.signal);
      if (!closed) port.postMessage({ type: 'done' });
    } catch (err) {
      if (!closed) port.postMessage({ type: 'error', error: errorPayload(err) });
    }
  });
});

// ---------- OAuth 回调兜底：webNavigation ----------
// 主路径是 declarativeNetRequest 把 127.0.0.1 回调重定向到 callback.html；
// 这里在导航开始/失败时也处理一次，按 state 去重。

async function isOurCallback(url) {
  try {
    const u = new URL(url);
    if (u.hostname !== '127.0.0.1' || u.pathname !== '/auth/callback') return false;
    const c = await chatgpt.config();
    return Number(u.port) === Number(c.port);
  } catch { return false; }
}

chrome.webNavigation.onBeforeNavigate.addListener(async (d) => {
  if (d.frameId !== 0 || !(await isOurCallback(d.url))) return;
  chatgpt.handleCallback(new URL(d.url).search);
}, { url: [{ hostEquals: '127.0.0.1', pathEquals: '/auth/callback' }] });

chrome.webNavigation.onErrorOccurred.addListener(async (d) => {
  if (d.frameId !== 0 || !(await isOurCallback(d.url))) return;
  // 重定向没生效、页面打不开时：处理回调并把标签页带到结果页
  const search = new URL(d.url).search;
  await chatgpt.handleCallback(search);
  chrome.tabs.update(d.tabId, { url: chrome.runtime.getURL('callback.html') + search });
}, { url: [{ hostEquals: '127.0.0.1', pathEquals: '/auth/callback' }] });
