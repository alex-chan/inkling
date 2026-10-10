// 本地 mock 服务器：测试页面 + OpenAI 兼容接口 + Sign in with ChatGPT（OAuth / Responses）
// 用法：node tests/mock-server.js [端口]；测试里通过 startMockServer() 启动。

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(here, 'fixtures');
export const GOOD_KEY = 'sk-test-good';
const FORBIDDEN = ['temperature', 'max_output_tokens', 'top_p', 'metadata', 'user', 'background', 'conversation',
  'max_tool_calls', 'moderation', 'prompt', 'safety_identifier', 'top_logprobs', 'truncation', 'previous_response_id'];

export function startMockServer(port = 18080) {
  const base = `http://127.0.0.1:${port}`;
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'mock-key-1', alg: 'RS256', use: 'sig' };

  const state = {
    log: [],
    control: {},
    clients: new Map(),   // clientId -> { hostId, name }
    codes: new Map(),     // code -> {...}
    access: new Map(),    // token -> { clientId, sub, exp }
    refresh: new Map(),   // token -> { clientId, sub, used, revoked }
  };
  const reset = () => {
    state.log = [];
    state.control = {
      expiresIn: 3600,       // 访问令牌有效期（秒）
      omitPlanScope: false,  // 不授予 chatgpt.tokens.use.direct
      accessDenied: false,   // 授权页返回 error=access_denied
      responsesError: null,  // usage_limit | not_eligible | invalid_user | fail_midstream
      sub: 'user-123',
      email: 'reader@example.com',
    };
  };
  reset();

  const sign = (payload) => {
    const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const input = `${enc({ alg: 'RS256', kid: jwk.kid, typ: 'JWT' })}.${enc(payload)}`;
    const sig = crypto.sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url');
    return `${input}.${sig}`;
  };
  const rand = (n = 16) => crypto.randomBytes(n).toString('hex');

  const json = (res, status, obj) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(obj));
  };
  const sseStart = (res) => res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const readBody = (req) => new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => { d += c; });
    req.on('end', () => resolve(d));
  });

  function issueTokens(clientId, sub, nonce) {
    const at = 'at_' + rand();
    const rt = 'rt_' + rand();
    const now = Math.floor(Date.now() / 1000);
    const exp = now + state.control.expiresIn;
    state.access.set(at, { clientId, sub, exp });
    state.refresh.set(rt, { clientId, sub, used: false, revoked: false });
    const scope = 'openid profile email offline_access resource.invoke' + (state.control.omitPlanScope ? '' : ' chatgpt.tokens.use.direct');
    const idToken = sign({ iss: base, aud: clientId, sub, email: state.control.email, name: 'Test Reader', nonce, iat: now, exp: now + 3600 });
    return { access_token: at, refresh_token: rt, id_token: idToken, token_type: 'Bearer', expires_in: state.control.expiresIn, scope };
  }

  function bearer(req) {
    return (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  }

  function explainText(user) {
    const word = (user.match(/词语：(.+)/) || [])[1] || '这个词';
    return `本句含义：「${word}」在这里指加征的进口税。\n读音：/ˈtɛrɪf/\n用法：名词，常见搭配 impose tariffs on。\n背景：近年贸易争端常涉及关税。`;
  }
  // 模拟「AI 优化注释」：保留候选（去掉 Chancellor），补充熟词僻义与短语，并混入一条无效条目
  const EXTRA = [
    { re: /\bbrace\b/, text: 'brace', gloss: '准备应对', level: 'C1', kind: 'sense' },
    { re: /\brule out\b/, text: 'rule out', gloss: '排除', level: 'B2', kind: 'phrase' },
    { re: /\bin the wake of\b/, text: 'in the wake of', gloss: '紧随…之后', level: 'C1', kind: 'phrase' },
  ];
  function annotateJson(user) {
    const items = [];
    const paras = user.split(/\n\n(?=\[P\d+\])/);
    paras.forEach((chunk, i) => {
      const m = /^\[P(\d+)\] ([\s\S]*?)\n候选生词：(.*)$/.exec(chunk);
      if (!m) return;
      const [, n, text, cands] = m;
      for (const w of cands.split(/,\s*/).filter((x) => x && x !== '（无）')) {
        if (w === 'chancellor') continue;
        const hit = new RegExp(`\\b${w}\\b`, 'i').exec(text);
        if (hit) items.push({ p: Number(n), text: hit[0], gloss: `语境·${w}`, level: 'B2', kind: 'word' });
      }
      for (const x of EXTRA) if (x.re.test(text)) items.push({ p: Number(n), text: x.text, gloss: x.gloss, level: x.level, kind: x.kind });
      if (i === 0) items.push({ p: Number(n), text: 'not in this paragraph at all', gloss: '无效', level: 'B1', kind: 'phrase' });
    });
    return JSON.stringify({ items });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, base);
    const body = req.method === 'POST' ? await readBody(req) : '';
    const entry = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), auth: req.headers.authorization || '', body };
    if (!url.pathname.startsWith('/__')) state.log.push(entry);
    try {
      // ---------- 控制接口 ----------
      if (url.pathname === '/__log') return json(res, 200, state.log);
      if (url.pathname === '/__reset') { reset(); return json(res, 200, { ok: true }); }
      if (url.pathname === '/__control') { Object.assign(state.control, JSON.parse(body || '{}')); return json(res, 200, state.control); }
      if (url.pathname === '/__expire') {
        for (const v of state.access.values()) v.exp = 0;
        return json(res, 200, { ok: true });
      }

      // ---------- 测试页面 ----------
      if (url.pathname.startsWith('/pages/')) {
        const f = path.join(FIXTURES, path.basename(url.pathname));
        if (!fs.existsSync(f)) { res.writeHead(404); return res.end('not found'); }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(fs.readFileSync(f));
      }

      // ---------- OAuth ----------
      if (url.pathname === '/.well-known/openid-configuration') {
        return json(res, 200, {
          issuer: base,
          authorization_endpoint: `${base}/api/accounts/authorize`,
          token_endpoint: `${base}/api/accounts/oauth/token`,
          jwks_uri: `${base}/.well-known/jwks.json`,
          revocation_endpoint: `${base}/oauth/revoke`,
        });
      }
      if (url.pathname === '/.well-known/jwks.json') return json(res, 200, { keys: [jwk] });

      if (url.pathname === '/api/accounts/authorize') {
        if (state.control.authorizeDelay) await sleep(state.control.authorizeDelay);
        const q = url.searchParams;
        const redirect = q.get('redirect_uri') || '';
        const problems = [];
        if (!/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/.test(redirect)) problems.push('redirect_uri');
        if (q.get('response_type') !== 'code') problems.push('response_type');
        if (q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge')) problems.push('pkce');
        if (!q.get('state') || !q.get('nonce')) problems.push('state/nonce');
        if (!q.get('ext_agent_host_id')) problems.push('ext_agent_host_id');
        if (q.get('resource') !== 'https://api.openai.com/v1') problems.push('resource');
        for (const s of ['openid', 'offline_access', 'resource.invoke', 'chatgpt.tokens.use.direct']) {
          if (!(q.get('scope') || '').split(' ').includes(s)) problems.push('scope:' + s);
        }
        let clientId = q.get('client_id');
        let issued = null;
        if (clientId === 'dynamic_agent_client') {
          if (!q.get('agent_name_hint')) problems.push('agent_name_hint');
          issued = 'oaiapp_' + rand(8);
          state.clients.set(issued, { hostId: q.get('ext_agent_host_id'), name: q.get('agent_name_hint') });
          clientId = issued;
        } else if (!state.clients.has(clientId)) {
          problems.push('unknown client_id');
        } else if (q.get('agent_name_hint')) {
          problems.push('agent_name_hint on reauth');
        }
        if (problems.length) { res.writeHead(400, { 'Content-Type': 'text/plain' }); return res.end('bad authorize request: ' + problems.join(', ')); }
        const back = new URL(redirect);
        back.searchParams.set('state', q.get('state'));
        if (state.control.accessDenied) {
          back.searchParams.set('error', 'access_denied');
        } else {
          const code = 'code_' + rand();
          state.codes.set(code, {
            clientId, redirect, challenge: q.get('code_challenge'), nonce: q.get('nonce'), resource: q.get('resource'), sub: state.control.sub,
          });
          back.searchParams.set('code', code);
          back.searchParams.set('scope', q.get('scope'));
          if (issued) back.searchParams.set('client_id', issued);
        }
        res.writeHead(302, { Location: back.toString() });
        return res.end();
      }

      if (url.pathname === '/api/accounts/oauth/token' && req.method === 'POST') {
        const p = new URLSearchParams(body);
        if (p.get('resource') !== 'https://api.openai.com/v1') return json(res, 400, { error: 'invalid_target' });
        if (p.get('grant_type') === 'authorization_code') {
          const c = state.codes.get(p.get('code'));
          state.codes.delete(p.get('code'));
          if (!c || c.clientId !== p.get('client_id') || c.redirect !== p.get('redirect_uri')) return json(res, 400, { error: 'invalid_grant' });
          const challenge = crypto.createHash('sha256').update(p.get('code_verifier') || '').digest('base64url');
          if (challenge !== c.challenge) return json(res, 400, { error: 'invalid_grant', error_description: 'pkce' });
          return json(res, 200, issueTokens(c.clientId, c.sub, c.nonce));
        }
        if (p.get('grant_type') === 'refresh_token') {
          const r = state.refresh.get(p.get('refresh_token'));
          if (!r || r.revoked || r.clientId !== p.get('client_id')) return json(res, 400, { error: 'invalid_grant' });
          if (r.used) return json(res, 400, { error: 'refresh_token_reused' });
          r.used = true;
          const t = issueTokens(r.clientId, r.sub, undefined);
          delete t.id_token;
          return json(res, 200, t);
        }
        return json(res, 400, { error: 'unsupported_grant_type' });
      }

      if (url.pathname === '/oauth/revoke' && req.method === 'POST') {
        const p = new URLSearchParams(body);
        const r = state.refresh.get(p.get('token'));
        if (r) r.revoked = true;
        res.writeHead(200);
        return res.end();
      }

      // ---------- 模型列表 ----------
      if (url.pathname === '/v1/models') {
        const tok = bearer(req);
        if (tok.startsWith('at_')) {
          const a = state.access.get(tok);
          if (!a || a.exp * 1000 < Date.now()) return json(res, 401, { detail: 'invalid token' });
          return json(res, 200, {
            models: [
              { slug: 'gpt-mock-pro', display_name: 'GPT Mock Pro', visibility: 'list' },
              { slug: 'gpt-mock-hidden', display_name: 'Hidden', visibility: 'hide' },
              { slug: 'gpt-mock-mini', display_name: 'GPT Mock Mini', visibility: 'list' },
            ],
          });
        }
        if (tok !== GOOD_KEY) return json(res, 401, { error: { message: 'Incorrect API key provided', type: 'invalid_request_error', code: 'invalid_api_key' } });
        return json(res, 200, { object: 'list', data: [{ id: 'mock-chat-1', object: 'model' }, { id: 'mock-chat-2', object: 'model' }] });
      }

      // ---------- A. Chat Completions ----------
      if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
        if (bearer(req) !== GOOD_KEY) return json(res, 401, { error: { message: 'Incorrect API key provided', code: 'invalid_api_key' } });
        const j = JSON.parse(body);
        if (!j.model?.startsWith('mock-chat')) return json(res, 404, { error: { message: `The model ${j.model} does not exist` } });
        const sys = j.messages.find((m) => m.role === 'system')?.content || '';
        const user = j.messages.find((m) => m.role === 'user')?.content || '';
        const text = /"items"/.test(sys) ? annotateJson(user) : /连接测试/.test(sys) ? 'OK' : explainText(user);
        sseStart(res);
        for (const part of text.match(/[\s\S]{1,6}/g)) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: part } }] })}\n\n`);
          await sleep(5);
        }
        res.write('data: [DONE]\n\n');
        return res.end();
      }

      // ---------- B. Responses（ChatGPT 套餐） ----------
      if (url.pathname === '/v1/responses' && req.method === 'POST') {
        const a = state.access.get(bearer(req));
        if (!a || a.exp * 1000 < Date.now()) return json(res, 401, { detail: 'token expired or invalid' });
        const j = JSON.parse(body);
        const bad = FORBIDDEN.filter((k) => k in j);
        if (j.store !== false || j.stream !== true) bad.push('store/stream');
        if (!j.instructions) bad.push('instructions');
        if ((j.input || []).some((m) => m.role === 'system')) bad.push('system role');
        if (bad.length) return json(res, 400, { error: { code: 'subscription_sharing_unsupported_capability', param: bad.join(',') } });
        const mode = state.control.responsesError;
        if (mode === 'usage_limit') return json(res, 429, { error: { code: 'subscription_sharing_usage_limit_exceeded', param: null } });
        if (mode === 'not_eligible') return json(res, 403, { error: { code: 'subscription_sharing_user_not_eligible', param: null } });
        if (mode === 'invalid_user') return json(res, 401, { error: { code: 'subscription_sharing_invalid_user', param: null } });
        const user = typeof j.input[0].content === 'string' ? j.input[0].content : j.input[0].content.map((c) => c.text).join('');
        const text = /"items"/.test(j.instructions) ? annotateJson(user) : /连接测试/.test(j.instructions) ? 'OK' : explainText(user);
        sseStart(res);
        const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
        ev('response.created', { response: { id: 'resp_1', status: 'in_progress' } });
        const parts = text.match(/[\s\S]{1,6}/g);
        for (let i = 0; i < parts.length; i++) {
          ev('response.output_text.delta', { delta: parts[i] });
          await sleep(5);
          if (mode === 'fail_midstream' && i === 2) {
            ev('response.failed', { response: { id: 'resp_1', status: 'failed', error: { code: 'subscription_sharing_usage_limit_exceeded' } } });
            return res.end();
          }
        }
        ev('response.completed', { response: { id: 'resp_1', status: 'completed' } });
        return res.end();
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    } catch (e) {
      json(res, 500, { error: { message: String(e) } });
    }
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve({ base, server, state, close: () => new Promise((r) => server.close(r)) }));
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2]) || 18080;
  startMockServer(port).then(({ base }) => console.log(`mock server on ${base}`));
}
