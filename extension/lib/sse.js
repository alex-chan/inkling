// 极简 SSE 解析：逐个产出 { event, data }

import { t } from './i18n.js';

export async function* readSSE(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let event = '';
  let data = [];
  const flush = function* () {
    if (data.length) yield { event, data: data.join('\n') };
    event = '';
    data = [];
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let m;
    while ((m = /\r\n|\n|\r/.exec(buf))) {
      const line = buf.slice(0, m.index);
      buf = buf.slice(m.index + m[0].length);
      if (line === '') { yield* flush(); continue; }
      if (line.startsWith(':')) continue;
      const c = line.indexOf(':');
      const field = c < 0 ? line : line.slice(0, c);
      let val = c < 0 ? '' : line.slice(c + 1);
      if (val.startsWith(' ')) val = val.slice(1);
      if (field === 'event') event = val;
      else if (field === 'data') data.push(val);
    }
  }
  if (buf.startsWith('data:')) data.push(buf.slice(5).trimStart());
  yield* flush();
}

export class AIError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = 'AIError';
    Object.assign(this, extra); // code, link, linkText, needLogin, retryable
  }
}

export function errorPayload(err) {
  if (err instanceof AIError) {
    return { message: err.message, code: err.code, link: err.link, linkText: err.linkText, needLogin: !!err.needLogin };
  }
  if (err?.name === 'AbortError') return { message: t('cancelled') };
  return { message: t('error_detail', err?.message || String(err)) };
}

export async function readErrorBody(res) {
  const text = await res.text().catch(() => '');
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  const msg = json?.error?.message || json?.detail || json?.message || (typeof json?.error === 'string' ? json.error : '') || text.slice(0, 200);
  return { json, text, msg: String(msg || '').trim() };
}
