// OAuth 回调页：declarativeNetRequest 把 http://127.0.0.1:<端口>/auth/callback?… 重定向到这里
import { initI18n, applyI18n, t } from './lib/i18n.js';

const search = location.search;
// 尽快把地址栏里的授权码清掉
history.replaceState(null, '', location.pathname);

await initI18n();
applyI18n();

const title = document.getElementById('title');
const msg = document.getElementById('msg');
const actions = document.getElementById('actions');
let res;
try {
  res = await chrome.runtime.sendMessage({ type: 'authCallback', search });
} catch (e) {
  res = { ok: false, error: { message: e.message } };
}
const r = res?.ok ? res.data : { ok: false, message: res?.error?.message || t('unknown_error') };
document.body.dataset.result = r.ok ? 'ok' : 'error';
actions.hidden = false;
if (r.ok) {
  title.textContent = r.planEnabled ? t('cb_ok') : t('cb_noplan');
  msg.textContent = r.planEnabled ? t('cb_ok_msg', r.email ? ` (${r.email})` : '') : t('cb_noplan_msg');
  if (r.planEnabled) setTimeout(() => chrome.tabs.getCurrent((tab) => tab && chrome.tabs.remove(tab.id)), 1800);
} else {
  title.textContent = t('cb_fail');
  msg.textContent = r.message;
}
