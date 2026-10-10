// B. Sign in with ChatGPT：OAuth 2.0 授权码 + PKCE（公开客户端），消耗用户的 ChatGPT 套餐用量
// 参考 https://developers.openai.com/siwc/token-sharing-open-source/sign-in

import { readSSE, AIError, readErrorBody } from './sse.js';

const PROD = {
  authBase: 'https://auth.openai.com',
  issuer: 'https://auth.openai.com',
  apiBase: 'https://api.openai.com/v1',
  resource: 'https://api.openai.com/v1',
  port: 14551,
};
const AGENT_NAME = 'Inkling';
const DYNAMIC_CLIENT = 'dynamic_agent_client';
const SCOPE = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
export const USAGE_URL = 'https://chatgpt.com/settings/usage';
const REDIRECT_RULE_ID = 1;
const TERMINAL_REFRESH_ERRORS = new Set([
  'invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired',
  'refresh_token_invalidated', 'refresh_token_reused',
]);

// 开发配置：storage.local.devConfig 可覆盖各端点，便于用本地 mock 服务器测试
export async function config() {
  const { devConfig } = await chrome.storage.local.get('devConfig');
  const c = { ...PROD, ...(devConfig || {}) };
  c.authorizeUrl = c.authorizeUrl || `${c.authBase}/api/accounts/authorize`;
  c.tokenUrl = c.tokenUrl || `${c.authBase}/api/accounts/oauth/token`;
  c.jwksUrl = c.jwksUrl || `${c.authBase}/.well-known/jwks.json`;
  c.discoveryUrl = c.discoveryUrl || `${c.authBase}/.well-known/openid-configuration`;
  c.redirectUri = `http://127.0.0.1:${c.port}/auth/callback`;
  return c;
}

// ---------- 工具函数 ----------

const enc = new TextEncoder();
function b64url(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  const s = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
function randomToken(n = 32) {
  return b64url(crypto.getRandomValues(new Uint8Array(n)));
}
async function sha256(str) {
  return crypto.subtle.digest('SHA-256', enc.encode(str));
}
function decodeJwt(token) {
  const [h, p, s] = String(token).split('.');
  if (!h || !p || !s) throw new Error('ID token 格式错误');
  return {
    header: JSON.parse(new TextDecoder().decode(b64urlDecode(h))),
    payload: JSON.parse(new TextDecoder().decode(b64urlDecode(p))),
    signingInput: `${h}.${p}`,
    signature: b64urlDecode(s),
  };
}
async function postForm(url, params) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(params).toString(),
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function hostId() {
  let { chatgptHostId } = await chrome.storage.local.get('chatgptHostId');
  if (!chatgptHostId) {
    chatgptHostId = `urn:uuid:${crypto.randomUUID()}`;
    await chrome.storage.local.set({ chatgptHostId });
  }
  return chatgptHostId;
}

async function setLastError(message) {
  await chrome.storage.local.set({ chatgptLastError: message || '' });
}

// ---------- 回调拦截：declarativeNetRequest 重定向到扩展页 ----------

export async function installRedirectRule(port) {
  const target = chrome.runtime.getURL('callback.html');
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [REDIRECT_RULE_ID],
    addRules: [{
      id: REDIRECT_RULE_ID,
      priority: 1,
      action: { type: 'redirect', redirect: { regexSubstitution: `${target}?\\1` } },
      condition: {
        regexFilter: `^http://127\\.0\\.0\\.1:${port}/auth/callback\\?(.*)$`,
        resourceTypes: ['main_frame'],
      },
    }],
  });
}

export async function removeRedirectRule() {
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [REDIRECT_RULE_ID] });
}

// ---------- 登录 ----------

export async function startLogin({ newAccount = false } = {}) {
  const c = await config();
  const ext = await hostId();
  const { chatgptLastClient: last } = await chrome.storage.local.get('chatgptLastClient');
  const reuse = !newAccount && last?.clientId;

  const state = randomToken();
  const nonce = randomToken();
  const verifier = randomToken(48);
  const challenge = b64url(await sha256(verifier));

  const p = new URLSearchParams({
    client_id: reuse ? last.clientId : DYNAMIC_CLIENT,
    response_type: 'code',
    redirect_uri: c.redirectUri,
    scope: SCOPE,
    resource: c.resource,
    state,
    nonce,
    code_challenge_method: 'S256',
    code_challenge: challenge,
    ext_agent_host_id: ext,
  });
  if (reuse) {
    if (last.idToken) p.set('id_token_hint', last.idToken);
    if (last.email) p.set('login_hint', last.email);
  } else {
    p.set('agent_name_hint', AGENT_NAME);
  }

  const { chatgptPending = {} } = await chrome.storage.session.get('chatgptPending');
  // 清理 15 分钟前的残留
  for (const [k, v] of Object.entries(chatgptPending)) if (Date.now() - v.createdAt > 15 * 60e3) delete chatgptPending[k];
  chatgptPending[state] = {
    verifier, nonce,
    clientId: reuse ? last.clientId : DYNAMIC_CLIENT,
    expectSub: reuse ? last.sub : null,
    redirectUri: c.redirectUri,
    createdAt: Date.now(),
  };
  await chrome.storage.session.set({ chatgptPending });
  await setLastError('');
  await installRedirectRule(c.port);
  await chrome.tabs.create({ url: `${c.authorizeUrl}?${p}` });
  return { ok: true };
}

const inflight = new Map(); // state -> Promise（同一个回调可能被 DNR 与 webNavigation 各触发一次）

export function handleCallback(search) {
  const params = new URLSearchParams(search);
  const state = params.get('state') || '';
  if (inflight.has(state)) return inflight.get(state);
  const p = (async () => {
    const { chatgptHandled = {} } = await chrome.storage.session.get('chatgptHandled');
    if (chatgptHandled[state]) return chatgptHandled[state];
    let result;
    try {
      result = await processCallback(params);
    } catch (e) {
      result = { ok: false, message: e.message || String(e) };
    }
    if (!result.ok && !result.stale) await setLastError(result.message);
    if (state && !result.stale) {
      const { chatgptHandled: h = {} } = await chrome.storage.session.get('chatgptHandled');
      h[state] = result;
      await chrome.storage.session.set({ chatgptHandled: h });
    }
    return result;
  })();
  inflight.set(state, p);
  p.finally(() => setTimeout(() => inflight.delete(state), 60e3));
  return p;
}

async function processCallback(params) {
  const state = params.get('state');
  const { chatgptPending = {} } = await chrome.storage.session.get('chatgptPending');
  const pending = state && chatgptPending[state];
  if (!pending) return { ok: false, stale: true, message: '登录请求已失效或已处理，请回到 Inkling 设置页重新点击 Continue with ChatGPT' };
  delete chatgptPending[state];
  await chrome.storage.session.set({ chatgptPending });
  if (!Object.keys(chatgptPending).length) await removeRedirectRule().catch(() => {});

  const c = await config();
  const error = params.get('error');
  if (error) {
    if (error === 'access_denied') {
      return { ok: false, message: '你没有同意授权，或未开启 ChatGPT 套餐用量共享。可以重新登录并允许使用套餐用量，或改用 API Key。' };
    }
    return { ok: false, message: `登录失败：${error}${params.get('error_description') ? '（' + params.get('error_description') + '）' : ''}` };
  }
  const code = params.get('code');
  if (!code) return { ok: false, message: '回调中缺少授权码' };

  const cbClient = params.get('client_id');
  let clientId;
  if (pending.clientId === DYNAMIC_CLIENT) {
    if (!cbClient || cbClient === DYNAMIC_CLIENT) return { ok: false, message: '首次注册未返回 client_id，注册不完整，请重试' };
    clientId = cbClient;
  } else {
    if (cbClient && cbClient !== pending.clientId) return { ok: false, message: '回调返回的 client_id 与已保存的不一致，已拒绝本次登录' };
    clientId = pending.clientId;
  }

  const res = await postForm(c.tokenUrl, {
    grant_type: 'authorization_code',
    client_id: clientId,
    code,
    code_verifier: pending.verifier,
    redirect_uri: pending.redirectUri,
    resource: c.resource,
  }).catch(() => null);
  if (!res) return { ok: false, message: '无法连接到 OpenAI 登录服务器，请检查网络' };
  if (!res.ok) {
    const { json, msg } = await readErrorBody(res);
    if (json?.error === 'invalid_grant') return { ok: false, message: '授权码已失效，请重新登录' };
    return { ok: false, message: `换取令牌失败（HTTP ${res.status}）${msg ? '：' + msg : ''}` };
  }
  const tok = await res.json();
  const claims = await verifyIdToken(tok.id_token, { clientId, nonce: pending.nonce, issuer: c.issuer, jwksUrl: c.jwksUrl });

  if (pending.expectSub && claims.sub !== pending.expectSub) {
    return { ok: false, message: '登录的 ChatGPT 账号与之前的不同。如需换账号，请在设置页选择「使用其他账号登录」。' };
  }

  const scopes = String(tok.scope || params.get('scope') || '').split(/\s+/).filter(Boolean);
  const planEnabled = scopes.includes(PLAN_SCOPE);
  const auth = {
    clientId,
    sub: claims.sub,
    email: claims.email || '',
    name: claims.name || '',
    issuer: claims.iss,
    idToken: tok.id_token,
    accessToken: tok.access_token,
    refreshToken: tok.refresh_token || '',
    tokenType: tok.token_type || 'Bearer',
    expiresAt: Date.now() + (Number(tok.expires_in) || 3600) * 1000,
    scopes,
    planEnabled,
    savedAt: Date.now(),
  };
  const { chatgptRegistrations = {} } = await chrome.storage.local.get('chatgptRegistrations');
  chatgptRegistrations[claims.sub] = { clientId, email: auth.email };
  const patch = {
    chatgptAuth: auth,
    chatgptLastClient: { clientId, sub: claims.sub, email: auth.email, idToken: tok.id_token },
    chatgptRegistrations,
    chatgptLastError: planEnabled ? '' : '已登录，但没有授权使用 ChatGPT 套餐用量。请重新登录并允许套餐用量，或改用 API Key。',
  };
  if (planEnabled) patch.aiProvider = 'chatgpt';
  await chrome.storage.local.set(patch);

  if (planEnabled) {
    // 若尚未选模型，取列表第一个
    const { chatgptModel } = await chrome.storage.local.get('chatgptModel');
    if (!chatgptModel) {
      const models = await listModels().catch(() => []);
      if (models[0]) await chrome.storage.local.set({ chatgptModel: models[0].id });
    }
  }
  return { ok: true, planEnabled, email: auth.email };
}

// ---------- ID token 校验（JWKS 验签 + iss/aud/exp/nonce） ----------

let jwksCache = null;
async function getJwks(url, force) {
  if (!force && jwksCache && jwksCache.url === url && Date.now() - jwksCache.at < 3600e3) return jwksCache.keys;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`获取 JWKS 失败（HTTP ${r.status}）`);
  const j = await r.json();
  jwksCache = { url, at: Date.now(), keys: j.keys || [] };
  return jwksCache.keys;
}

export async function verifyIdToken(idToken, { clientId, nonce, issuer, jwksUrl }) {
  if (!idToken) throw new Error('令牌响应中没有 ID token');
  const { header, payload, signingInput, signature } = decodeJwt(idToken);
  const algs = {
    RS256: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    ES256: { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' },
  };
  const alg = algs[header.alg];
  if (!alg) throw new Error(`不支持的 ID token 签名算法：${header.alg}`);
  let keys = await getJwks(jwksUrl);
  let jwk = keys.find((k) => k.kid === header.kid) || (!header.kid && keys.length === 1 ? keys[0] : null);
  if (!jwk) { keys = await getJwks(jwksUrl, true); jwk = keys.find((k) => k.kid === header.kid); }
  if (!jwk) throw new Error('ID token 的签名密钥不在 JWKS 中');
  const { alg: _a, use: _u, key_ops: _k, ...pub } = jwk;
  const key = await crypto.subtle.importKey('jwk', pub, alg, false, ['verify']);
  const ok = await crypto.subtle.verify(alg, key, signature, enc.encode(signingInput));
  if (!ok) throw new Error('ID token 签名校验失败');
  if (payload.iss !== issuer) throw new Error('ID token 的签发者（iss）不正确');
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(clientId)) throw new Error('ID token 的受众（aud）与 client_id 不符');
  if (!payload.exp || payload.exp * 1000 < Date.now() - 60e3) throw new Error('ID token 已过期');
  if (payload.nonce !== nonce) throw new Error('ID token 的 nonce 不匹配');
  if (!payload.sub) throw new Error('ID token 缺少 sub');
  return payload;
}

// ---------- 令牌刷新（串行化） ----------

let refreshing = null;

export function refresh() {
  if (!refreshing) {
    refreshing = doRefresh().finally(() => { refreshing = null; });
  }
  return refreshing;
}

async function doRefresh() {
  const { chatgptAuth: auth } = await chrome.storage.local.get('chatgptAuth');
  if (!auth?.refreshToken) throw needLogin('登录已过期，请重新登录 ChatGPT');
  const c = await config();
  let res;
  try {
    res = await postForm(c.tokenUrl, {
      grant_type: 'refresh_token',
      client_id: auth.clientId,
      refresh_token: auth.refreshToken,
      resource: c.resource,
    });
  } catch {
    throw new AIError('刷新 ChatGPT 登录状态时网络出错，请稍后再试');
  }
  if (!res.ok) {
    const { json, msg } = await readErrorBody(res);
    const code = json?.error?.code || json?.error || json?.code;
    if (TERMINAL_REFRESH_ERRORS.has(code) || res.status === 400 || res.status === 401) {
      await clearTokens();
      throw needLogin('ChatGPT 登录已失效，请重新登录');
    }
    throw new AIError(`刷新 ChatGPT 令牌失败（HTTP ${res.status}）${msg ? '：' + msg : ''}`);
  }
  const tok = await res.json();
  const scopes = tok.scope ? String(tok.scope).split(/\s+/) : auth.scopes;
  // 访问令牌、过期时间、权限与轮换后的刷新令牌一起替换
  const next = {
    ...auth,
    accessToken: tok.access_token,
    refreshToken: tok.refresh_token || auth.refreshToken,
    expiresAt: Date.now() + (Number(tok.expires_in) || 3600) * 1000,
    scopes,
    planEnabled: scopes.includes(PLAN_SCOPE),
    savedAt: Date.now(),
  };
  if (tok.id_token) next.idToken = tok.id_token;
  await chrome.storage.local.set({ chatgptAuth: next });
  return next;
}

function needLogin(message) {
  return new AIError(message, { needLogin: true, code: 'need_login' });
}

async function clearTokens() {
  await chrome.storage.local.remove('chatgptAuth');
}

export async function getAuth({ forceRefresh = false } = {}) {
  const { chatgptAuth: auth } = await chrome.storage.local.get('chatgptAuth');
  if (!auth) throw needLogin('尚未登录 ChatGPT，请到设置页点击 Continue with ChatGPT');
  if (!auth.planEnabled) {
    throw new AIError('已登录 ChatGPT，但未授权使用套餐用量。请重新登录并允许，或改用 API Key。', { code: 'plan_disabled' });
  }
  if (forceRefresh || auth.expiresAt - 60e3 < Date.now()) return refresh();
  return auth;
}

// ---------- 退出登录 ----------

export async function logout() {
  const { chatgptAuth: auth, chatgptLastClient: last } = await chrome.storage.local.get(['chatgptAuth', 'chatgptLastClient']);
  let revoked = !auth?.refreshToken;
  if (auth?.refreshToken) {
    const c = await config();
    for (let attempt = 0; attempt < 3 && !revoked; attempt++) {
      try {
        const disc = await fetch(c.discoveryUrl).then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status))));
        const url = disc.revocation_endpoint;
        if (!url) break;
        const r = await postForm(url, { token: auth.refreshToken, token_type_hint: 'refresh_token', client_id: auth.clientId });
        if (r.ok) revoked = true;
        else if (r.status < 500) break;
      } catch { /* 网络错误：重试 */ }
      if (!revoked) await sleep(500 * (attempt + 1));
    }
  }
  await clearTokens();
  // 保留 client_id 与 host id 供下次登录复用；退出后不再发送 id_token_hint
  if (last) await chrome.storage.local.set({ chatgptLastClient: { ...last, idToken: '' } });
  const { aiProvider } = await chrome.storage.local.get('aiProvider');
  if (aiProvider === 'chatgpt') await chrome.storage.local.set({ aiProvider: 'apikey' });
  return {
    ok: true,
    revoked,
    message: revoked ? '已退出 ChatGPT' : '已退出，但未能确认撤销令牌。你可以在 ChatGPT 设置中断开 Inkling。',
  };
}

export async function status() {
  const { chatgptAuth: auth, chatgptLastClient: last, chatgptLastError } =
    await chrome.storage.local.get(['chatgptAuth', 'chatgptLastClient', 'chatgptLastError']);
  return {
    signedIn: !!auth,
    planEnabled: !!auth?.planEnabled,
    email: auth?.email || '',
    name: auth?.name || '',
    expiresAt: auth?.expiresAt || 0,
    hasClient: !!last?.clientId,
    lastEmail: last?.email || '',
    error: chatgptLastError || '',
    usageUrl: USAGE_URL,
  };
}

// ---------- 模型与推理 ----------

async function apiFetch(path, init, retried = false) {
  const c = await config();
  const auth = await getAuth();
  let res;
  try {
    res = await fetch(c.apiBase + path, {
      ...init,
      headers: { ...(init.headers || {}), Authorization: `Bearer ${auth.accessToken}` },
    });
  } catch (e) {
    if (e?.name === 'AbortError') throw e;
    throw new AIError('无法连接到 OpenAI 接口，请检查网络');
  }
  if (res.status === 401 && !retried) {
    // 访问令牌可能被提前作废：强制刷新一次再试
    await refresh();
    return apiFetch(path, init, true);
  }
  return res;
}

export async function listModels() {
  const res = await apiFetch('/models', { method: 'GET' });
  if (!res.ok) throw await httpError(res);
  const j = await res.json();
  return (j.models || []).filter((m) => m.visibility === 'list')
    .map((m) => ({ id: m.slug, name: m.display_name || m.slug }));
}

function codeError(code, param, status) {
  switch (code) {
    case 'subscription_sharing_usage_limit_exceeded':
      return new AIError('ChatGPT 套餐用量已达上限，请稍后再试或调整用量设置。', { code, link: USAGE_URL, linkText: '管理用量' });
    case 'subscription_sharing_user_not_eligible':
      return new AIError('当前 ChatGPT 账号无法共享套餐用量（需要 Plus 或 Pro 套餐）。可改用 API Key。', { code });
    case 'subscription_sharing_invalid_user':
      return new AIError('ChatGPT 登录状态无效，请重新登录。', { code, needLogin: true });
    case 'subscription_sharing_usage_unavailable':
    case 'subscription_sharing_user_unavailable':
      return new AIError('暂时无法确认 ChatGPT 用量，请稍后再试。', { code, retryable: true });
    case 'subscription_sharing_unsupported_capability':
      return new AIError(`所选模型或请求参数不受支持${param ? '（' + param + '）' : ''}，请换一个模型。`, { code });
    case 'subscription_sharing_route_not_supported':
      return new AIError('请求的接口不受支持。', { code });
    case 'chatpass_v2_scope_not_authorized':
    case 'chatpass_v2_invalid_authorization_context':
      return new AIError('当前授权不允许此操作，请重新登录并允许使用套餐用量。', { code });
    default:
      return null;
  }
}

async function httpError(res) {
  const { json, msg } = await readErrorBody(res);
  const err = codeError(json?.error?.code, json?.error?.param, res.status);
  if (err) {
    if (err.needLogin) await clearTokens();
    return err;
  }
  if (res.status === 401) { await clearTokens(); return needLogin('ChatGPT 登录状态无效，请重新登录'); }
  if (res.status === 403) return new AIError(`请求被拒绝（HTTP 403）${msg ? '：' + msg : ''}`);
  if (res.status === 429) return new AIError('ChatGPT 套餐用量已达上限。', { link: USAGE_URL, linkText: '管理用量' });
  if (res.status === 503) return new AIError('ChatGPT 服务暂时不可用，请稍后再试。', { retryable: true });
  return new AIError(`请求失败（HTTP ${res.status}）${msg ? '：' + msg : ''}`);
}

// 流式推理（Responses API）。只有收到 response.completed 才算成功。
export async function respond({ model, instructions, input, onDelta, signal }) {
  if (!model) throw new AIError('尚未选择 ChatGPT 模型，请到设置页选择');
  const body = JSON.stringify({
    model,
    instructions,
    input: [{ role: 'user', content: input }],
    store: false,
    stream: true,
  });
  let res;
  for (let attempt = 0; ; attempt++) {
    res = await apiFetch('/responses', { method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body });
    if (res.ok) break;
    const err = await httpError(res);
    if (err.retryable && attempt < 2) { await sleep(1000 * 2 ** attempt); continue; }
    throw err;
  }
  let text = '';
  let completed = false;
  for await (const { event, data } of readSSE(res)) {
    let j;
    try { j = JSON.parse(data); } catch { continue; }
    const type = j.type || event;
    if (type === 'response.output_text.delta') {
      if (j.delta) { text += j.delta; onDelta?.(j.delta); }
    } else if (type === 'response.completed') {
      completed = true;
    } else if (type === 'response.failed') {
      const e = j.response?.error || {};
      const err = codeError(e.code, e.param);
      if (err?.needLogin) await clearTokens();
      throw err || new AIError(`模型生成失败${e.message ? '：' + e.message : ''}`);
    } else if (type === 'response.incomplete') {
      throw new AIError('回答未完成（被截断）', { partial: text });
    } else if (type === 'error') {
      const err = codeError(j.code || j.error?.code, j.param);
      throw err || new AIError(`模型返回错误：${j.message || j.error?.message || '未知错误'}`);
    }
  }
  if (!completed) throw new AIError('连接中断，回答不完整，请重试', { partial: text });
  return text;
}
