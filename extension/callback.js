// OAuth 回调页：declarativeNetRequest 把 http://127.0.0.1:<端口>/auth/callback?… 重定向到这里
(async () => {
  const title = document.getElementById('title');
  const msg = document.getElementById('msg');
  const actions = document.getElementById('actions');
  const search = location.search;
  // 尽快把地址栏里的授权码清掉
  history.replaceState(null, '', location.pathname);
  let res;
  try {
    res = await chrome.runtime.sendMessage({ type: 'authCallback', search });
  } catch (e) {
    res = { ok: false, error: { message: e.message } };
  }
  const r = res?.ok ? res.data : { ok: false, message: res?.error?.message || '未知错误' };
  document.body.dataset.result = r.ok ? 'ok' : 'error';
  actions.hidden = false;
  if (r.ok) {
    title.textContent = r.planEnabled ? '已登录 ChatGPT' : '已登录，但未授权套餐用量';
    msg.textContent = r.planEnabled
      ? `正在使用 ChatGPT 套餐用量${r.email ? '（' + r.email + '）' : ''}。此页面将自动关闭。`
      : '没有获得使用 ChatGPT 套餐用量的授权。请回到设置页重新登录并允许，或改用 API Key。';
    if (r.planEnabled) setTimeout(() => chrome.tabs.getCurrent((t) => t && chrome.tabs.remove(t.id)), 1800);
  } else {
    title.textContent = '登录未完成';
    msg.textContent = r.message;
  }
})();
