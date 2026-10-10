// A. API Key 方式：OpenAI 兼容的 Chat Completions 接口

import { readSSE, AIError, readErrorBody } from './sse.js';

export function normalizeBase(base) {
  return String(base || '').trim().replace(/\/+$/, '');
}

async function request(apiBase, apiKey, path, init = {}) {
  const base = normalizeBase(apiBase);
  if (!/^https?:\/\//i.test(base)) throw new AIError('接口地址格式不正确，应以 http:// 或 https:// 开头');
  if (!apiKey) throw new AIError('尚未填写 API Key，请到设置页「大模型」中填写');
  let res;
  try {
    res = await fetch(base + path, {
      ...init,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}`, ...(init.headers || {}) },
    });
  } catch (e) {
    if (e?.name === 'AbortError') throw e;
    throw new AIError(`无法连接到 ${new URL(base).host}，请检查接口地址和网络`);
  }
  if (!res.ok) {
    const { msg } = await readErrorBody(res);
    const detail = msg ? `（服务器返回：${msg}）` : '';
    const s = res.status;
    if (s === 401) throw new AIError(`API Key 无效或已过期（HTTP 401）${detail}`, { code: 'invalid_api_key' });
    if (s === 403) throw new AIError(`没有权限访问该接口或模型（HTTP 403）${detail}`);
    if (s === 404) throw new AIError(`接口地址或模型名不正确（HTTP 404）${detail}`);
    if (s === 429) throw new AIError(`请求过于频繁或账户额度不足（HTTP 429）${detail}`);
    if (s >= 500) throw new AIError(`服务端出错（HTTP ${s}），请稍后再试${detail}`);
    throw new AIError(`请求失败（HTTP ${s}）${detail}`);
  }
  return res;
}

export async function listModels({ apiBase, apiKey }) {
  const res = await request(apiBase, apiKey, '/models', { method: 'GET' });
  const j = await res.json().catch(() => null);
  const list = Array.isArray(j?.data) ? j.data : Array.isArray(j?.models) ? j.models : null;
  if (!list) throw new AIError('接口返回的模型列表格式无法识别');
  return list.map((m) => ({ id: m.id || m.slug || m.name, name: m.id || m.display_name || m.name }))
    .filter((m) => m.id)
    .sort((a, b) => a.id.localeCompare(b.id));
}

// 流式对话，返回完整文本
export async function chat({ apiBase, apiKey, model, system, user, onDelta, signal, temperature = 0.3 }) {
  if (!model) throw new AIError('尚未选择模型，请到设置页填写模型名');
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
    if (!text) throw new AIError('模型没有返回内容');
    onDelta?.(text);
    return text;
  }
  for await (const { data } of readSSE(res)) {
    if (data === '[DONE]') break;
    let j;
    try { j = JSON.parse(data); } catch { continue; }
    if (j.error) throw new AIError('模型返回错误：' + (j.error.message || JSON.stringify(j.error)));
    const delta = j.choices?.[0]?.delta?.content ?? j.choices?.[0]?.message?.content ?? '';
    if (delta) { text += delta; onDelta?.(delta); }
  }
  if (!text) throw new AIError('模型没有返回内容');
  return text;
}
