// A. API Key 方式：OpenAI 兼容的 Chat Completions 接口

import { t } from './i18n.js';
import { readSSE, AIError, readErrorBody } from './sse.js';

export function normalizeBase(base) {
  return String(base || '').trim().replace(/\/+$/, '');
}

async function request(apiBase, apiKey, path, init = {}) {
  const base = normalizeBase(apiBase);
  if (!/^https?:\/\//i.test(base)) throw new AIError(t('bad_base'), { code: 'bad_base' });
  if (!apiKey) throw new AIError(t('no_api_key'), { code: 'no_api_key' });
  // 扩展只默认拥有 api.openai.com 的访问权限；其他接口地址需要用户授权一次
  const u = new URL(base);
  const pattern = `${u.protocol}//${u.hostname}/*`;
  if (chrome.permissions && !(await chrome.permissions.contains({ origins: [pattern] }).catch(() => false))) {
    throw new AIError(t('need_host', u.host), { code: 'need_host_permission' });
  }
  let res;
  try {
    res = await fetch(base + path, {
      ...init,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}`, ...(init.headers || {}) },
    });
  } catch (e) {
    if (e?.name === 'AbortError') throw e;
    throw new AIError(t('cannot_connect', new URL(base).host));
  }
  if (!res.ok) {
    const { msg } = await readErrorBody(res);
    const detail = msg ? t('server_said', msg) : '';
    const s = res.status;
    if (s === 401) throw new AIError(t('http_401', detail), { code: 'invalid_api_key' });
    if (s === 403) throw new AIError(t('http_403', detail));
    if (s === 404) throw new AIError(t('http_404', detail));
    if (s === 429) throw new AIError(t('http_429', detail));
    if (s >= 500) throw new AIError(t('http_5xx', s, detail));
    throw new AIError(t('http_failed', s, detail));
  }
  return res;
}

export async function listModels({ apiBase, apiKey }) {
  const res = await request(apiBase, apiKey, '/models', { method: 'GET' });
  const j = await res.json().catch(() => null);
  const list = Array.isArray(j?.data) ? j.data : Array.isArray(j?.models) ? j.models : null;
  if (!list) throw new AIError(t('models_unrecognized'));
  return list.map((m) => ({ id: m.id || m.slug || m.name, name: m.id || m.display_name || m.name }))
    .filter((m) => m.id)
    .sort((a, b) => a.id.localeCompare(b.id));
}

// 流式对话，返回完整文本
export async function chat({ apiBase, apiKey, model, system, user, onDelta, signal, temperature = 0.3 }) {
  if (!model) throw new AIError(t('no_model'), { code: 'no_model' });
  const res = await request(apiBase, apiKey, '/chat/completions', {
    method: 'POST',
    signal,
    body: JSON.stringify({
      model,
      stream: true,
      temperature,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    }),
  });
  let text = '';
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('text/event-stream')) {
    // 有些兼容服务忽略 stream 参数，直接返回 JSON
    const j = await res.json().catch(() => null);
    text = j?.choices?.[0]?.message?.content || '';
    if (!text) throw new AIError(t('empty_reply'));
    onDelta?.(text);
    return text;
  }
  for await (const { data } of readSSE(res)) {
    if (data === '[DONE]') break;
    let j;
    try { j = JSON.parse(data); } catch { continue; }
    if (j.error) throw new AIError(t('model_error', j.error.message || JSON.stringify(j.error)));
    const delta = j.choices?.[0]?.delta?.content ?? j.choices?.[0]?.message?.content ?? '';
    if (delta) { text += delta; onDelta?.(delta); }
  }
  if (!text) throw new AIError(t('empty_reply'));
  return text;
}
