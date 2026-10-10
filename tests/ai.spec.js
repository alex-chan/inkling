import { test, expect, setStorage, getStorage, waitAnnotated, cardLocator, GOOD_KEY } from './helpers.js';

async function openOptions(context, extId) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extId}/options.html`);
  return page;
}

async function explainOnArticle(context, mock, lemma = 'tariff') {
  const page = await context.newPage();
  await page.goto(mock.page('article.html'));
  await waitAnnotated(page, '#p1');
  await page.locator(`#p1 ik-a[data-l="${lemma}"]`).first().click();
  const card = cardLocator(page);
  await card.getByRole('button', { name: 'AI 语境解释' }).click();
  const box = card.locator('.ai');
  await expect(box).toHaveAttribute('data-state', /done|error/);
  return { page, card, box };
}

async function loginChatGPT(context, extId, opt) {
  const page = opt || await openOptions(context, extId);
  await page.getByRole('button', { name: 'Continue with ChatGPT' }).click();
  await expect(page.locator('#cgSignedIn')).toBeVisible({ timeout: 15_000 });
  return page;
}

const logOf = async (mock, p) => (await mock.log()).filter((e) => e.path === p);

test.describe('A. API Key 方式', () => {
  test('获取模型、测试连接、错误提示与流式解释', async ({ context, mock, extId, sw }) => {
    const opt = await openOptions(context, extId);
    // 接口地址连不上
    await opt.fill('#apiBase', 'http://127.0.0.1:1/v1');
    await opt.fill('#apiKey', 'sk-wrong');
    await opt.locator('#apiKey').dispatchEvent('change');
    await opt.getByRole('button', { name: '获取模型列表' }).click();
    await expect(opt.locator('#apiStatus')).toContainText('无法连接到 127.0.0.1:1');

    // Key 错误
    await opt.fill('#apiBase', `${mock.base}/v1`);
    await opt.locator('#apiBase').dispatchEvent('change');
    await opt.getByRole('button', { name: '获取模型列表' }).click();
    await expect(opt.locator('#apiStatus')).toContainText('API Key 无效或已过期（HTTP 401）');

    // Key 正确
    await opt.fill('#apiKey', GOOD_KEY);
    await opt.locator('#apiKey').dispatchEvent('change');
    await opt.fill('#apiModel', '');
    await opt.getByRole('button', { name: '获取模型列表' }).click();
    await expect(opt.locator('#apiStatus')).toContainText('获取到 2 个模型');
    await expect(opt.locator('#apiModel')).toHaveValue('mock-chat-1');

    // 模型名错误
    await opt.fill('#apiModel', 'no-such-model');
    await opt.getByRole('button', { name: '测试连接' }).first().click();
    await expect(opt.locator('#apiStatus')).toContainText('接口地址或模型名不正确（HTTP 404）');

    await opt.fill('#apiModel', 'mock-chat-2');
    await opt.locator('#apiModel').dispatchEvent('change');
    await opt.getByRole('button', { name: '测试连接' }).first().click();
    await expect(opt.locator('#apiStatus')).toContainText('连接成功');

    const st = await getStorage(sw, ['apiKey', 'apiModel', 'apiBase', 'aiProvider']);
    expect(st).toMatchObject({ apiKey: GOOD_KEY, apiModel: 'mock-chat-2', apiBase: `${mock.base}/v1` });
    expect(st.aiProvider ?? 'apikey').toBe('apikey'); // 未写入时取默认值
    // Key 不写进 sync 存储
    expect(await sw.evaluate(() => chrome.storage.sync.get(null))).toEqual({});

    const { box } = await explainOnArticle(context, mock);
    await expect(box).toHaveAttribute('data-state', 'done');
    await expect(box).toContainText('本句含义');
    await expect(box).toContainText('读音');

    const req = (await logOf(mock, '/v1/chat/completions')).pop();
    const body = JSON.parse(req.body);
    expect(body.stream).toBe(true);
    expect(body.model).toBe('mock-chat-2');
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[0].content).toContain('120 字');
    expect(body.messages[1].content).toContain('词语：tariffs');
    // 上下文：所在句及前后各一句
    expect(body.messages[1].content).toContain('Chancellor Rachel Reeves said');
    expect(body.messages[1].content).toContain('Trump has insisted');
    expect(req.auth).toBe(`Bearer ${GOOD_KEY}`);
  });

  test('未配置时词卡给出中文提示', async ({ context, mock }) => {
    const { box } = await explainOnArticle(context, mock);
    await expect(box).toContainText('尚未填写 API Key');
    await expect(box.getByText('打开 Inkling 设置')).toBeVisible();
  });

  test('划选短语时直接调用 AI', async ({ context, mock, sw }) => {
    await setStorage(sw, { apiBase: `${mock.base}/v1`, apiKey: GOOD_KEY, apiModel: 'mock-chat-1' });
    const page = await context.newPage();
    await page.goto(mock.page('article.html'));
    await waitAnnotated(page, '#p1');
    const box = await page.evaluate(() => {
      const t = document.getElementById('p4').firstChild;
      const i = t.nodeValue.indexOf('went to the market');
      const r = document.createRange();
      r.setStart(t, i);
      r.setEnd(t, i + 'went to the market'.length);
      const b = r.getBoundingClientRect();
      return { x1: b.left + 1, x2: b.right - 1, y: b.top + b.height / 2 };
    });
    await page.mouse.move(box.x1, box.y);
    await page.mouse.down();
    await page.mouse.move(box.x2, box.y, { steps: 6 });
    await page.mouse.up();
    await page.locator('inkling-ui .sel').click();
    const card = cardLocator(page);
    await expect(card.locator('.word')).toHaveText('went to the market');
    await expect(card.locator('.ai')).toHaveAttribute('data-state', 'done');
    await expect(card.locator('.ai')).toContainText('本句含义');
  });

  test('自动语境注释：按段落调用并替换释义', async ({ context, mock, sw }) => {
    await setStorage(sw, { apiBase: `${mock.base}/v1`, apiKey: GOOD_KEY, apiModel: 'mock-chat-1', autoAI: true, showPhonetic: true });
    const page = await context.newPage();
    await page.goto(mock.page('article.html'));
    await expect(page.locator('#p1 ik-a[data-ai="1"]').first()).toBeVisible();
    // 只替换释义部分，美式音标保留
    await expect(page.locator('#p1 ik-a[data-l="tariff"] rt ik-t')).toHaveText(/^语境·/);
    await expect(page.locator('#p1 ik-a[data-l="tariff"] rt ik-ipa')).toHaveText('/ˈtɛrəfs/');
    const calls = await logOf(mock, '/v1/chat/completions');
    expect(calls.length).toBeGreaterThan(0);
    // 远处段落尚未请求
    expect(calls.some((c) => c.body.includes('recalcitrant'))).toBe(false);
    // 刷新后走缓存，不重复请求同一段
    const n = calls.filter((c) => c.body.includes('Chancellor')).length;
    await page.reload();
    await expect(page.locator('#p1 ik-a[data-ai="1"]').first()).toBeVisible();
    expect((await logOf(mock, '/v1/chat/completions')).filter((c) => c.body.includes('Chancellor')).length).toBe(n);
  });
});

test.describe('B. Sign in with ChatGPT', () => {
  test('首次登录、推理、令牌过期自动刷新、退出后复用 client_id 再登录', async ({ context, mock, extId, sw }) => {
    const opt = await openOptions(context, extId);
    await loginChatGPT(context, extId, opt);
    await expect(opt.locator('#cgUsing')).toHaveText('正在使用 ChatGPT 套餐用量');
    await expect(opt.locator('#cgUsage')).toHaveAttribute('href', 'https://chatgpt.com/settings/usage');
    await expect(opt.locator('#cgAccount')).toContainText('reader@example.com');

    // 授权请求参数
    const [auth1] = await logOf(mock, '/api/accounts/authorize');
    expect(auth1.query).toMatchObject({
      client_id: 'dynamic_agent_client',
      agent_name_hint: 'Inkling',
      response_type: 'code',
      redirect_uri: 'http://127.0.0.1:14551/auth/callback',
      resource: 'https://api.openai.com/v1',
      code_challenge_method: 'S256',
      scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
    });
    expect(auth1.query.ext_agent_host_id).toMatch(/^urn:uuid:/);
    const s1 = await getStorage(sw, ['chatgptAuth', 'aiProvider', 'chatgptModel']);
    const clientId = s1.chatgptAuth.clientId;
    expect(clientId).toMatch(/^oaiapp_/);
    expect(s1.aiProvider).toBe('chatgpt');
    expect(s1.chatgptModel).toBe('gpt-mock-pro');
    const tokenReq = new URLSearchParams((await logOf(mock, '/api/accounts/oauth/token'))[0].body);
    expect(tokenReq.get('grant_type')).toBe('authorization_code');
    expect(tokenReq.get('client_id')).toBe(clientId);
    expect(tokenReq.get('code_verifier')).toBeTruthy();
    expect(tokenReq.get('redirect_uri')).toBe('http://127.0.0.1:14551/auth/callback');

    // 模型列表：只显示 visibility == list
    await expect(opt.locator('#cgModel option')).toHaveText(['GPT Mock Pro', 'GPT Mock Mini']);
    await opt.locator('#cgTest').click();
    await expect(opt.locator('#cgStatus')).toContainText('连接成功');

    // 推理请求格式
    const { box } = await explainOnArticle(context, mock);
    await expect(box).toHaveAttribute('data-state', 'done');
    await expect(box).toContainText('本句含义');
    const resp = JSON.parse((await logOf(mock, '/v1/responses')).pop().body);
    expect(resp).toMatchObject({ model: 'gpt-mock-pro', store: false, stream: true });
    expect(resp.instructions).toContain('中文母语');
    for (const k of ['temperature', 'max_output_tokens', 'top_p', 'metadata', 'user']) expect(resp).not.toHaveProperty(k);
    expect(resp.input.every((m) => m.role !== 'system')).toBe(true);

    // 令牌过期 → 自动刷新（并发请求只刷新一次），刷新令牌轮换
    const rt1 = (await getStorage(sw, ['chatgptAuth'])).chatgptAuth.refreshToken;
    await mock.expire();
    await sw.evaluate(async () => {
      const { chatgptAuth } = await chrome.storage.local.get('chatgptAuth');
      await chrome.storage.local.set({ chatgptAuth: { ...chatgptAuth, expiresAt: Date.now() - 1000 } });
    });
    const results = await opt.evaluate(() => Promise.all([1, 2, 3].map(() => chrome.runtime.sendMessage({ type: 'listModels', provider: 'chatgpt' }))));
    expect(results.every((r) => r.ok)).toBe(true);
    const refreshes = (await logOf(mock, '/api/accounts/oauth/token')).filter((e) => e.body.includes('grant_type=refresh_token'));
    expect(refreshes).toHaveLength(1);
    expect(new URLSearchParams(refreshes[0].body).get('client_id')).toBe(clientId);
    expect(new URLSearchParams(refreshes[0].body).get('resource')).toBe('https://api.openai.com/v1');
    const rt2 = (await getStorage(sw, ['chatgptAuth'])).chatgptAuth.refreshToken;
    expect(rt2).not.toBe(rt1);

    // 访问令牌被服务端提前作废（401）→ 刷新后重试成功
    await mock.expire();
    const { box: box2 } = await explainOnArticle(context, mock, 'stagnation');
    await expect(box2).toHaveAttribute('data-state', 'done');

    // 退出：先撤销刷新令牌
    const rt3 = (await getStorage(sw, ['chatgptAuth'])).chatgptAuth.refreshToken;
    await opt.bringToFront();
    await opt.locator('#cgLogout').click();
    await expect(opt.locator('#cgSignedOut')).toBeVisible();
    await expect(opt.locator('#cgStatus')).toHaveText('已退出 ChatGPT');
    const revoke = new URLSearchParams((await logOf(mock, '/oauth/revoke'))[0].body);
    expect(revoke.get('token')).toBe(rt3);
    expect(revoke.get('token_type_hint')).toBe('refresh_token');
    expect(revoke.get('client_id')).toBe(clientId);
    expect((await getStorage(sw, ['chatgptAuth'])).chatgptAuth).toBeUndefined();

    // 再次登录：复用 client_id，不带 agent_name_hint，带 login_hint
    await loginChatGPT(context, extId, opt);
    const auth2 = (await logOf(mock, '/api/accounts/authorize')).pop();
    expect(auth2.query.client_id).toBe(clientId);
    expect(auth2.query).not.toHaveProperty('agent_name_hint');
    expect(auth2.query.login_hint).toBe('reader@example.com');
    expect(auth2.query.ext_agent_host_id).toBe(auth1.query.ext_agent_host_id);
    expect((await getStorage(sw, ['chatgptAuth'])).chatgptAuth.clientId).toBe(clientId);
  });

  test('刷新令牌失效（invalid_grant）→ 清除令牌并要求重新登录；重新登录带 id_token_hint', async ({ context, mock, extId, sw }) => {
    const opt = await loginChatGPT(context, extId);
    const { chatgptAuth } = await getStorage(sw, ['chatgptAuth']);
    await fetch(`${mock.base}/oauth/revoke`, { method: 'POST', body: new URLSearchParams({ token: chatgptAuth.refreshToken }) });
    await mock.expire();
    const { box } = await explainOnArticle(context, mock);
    await expect(box).toContainText('ChatGPT 登录已失效，请重新登录');
    await expect(box.getByText('打开 Inkling 设置')).toBeVisible();
    expect((await getStorage(sw, ['chatgptAuth'])).chatgptAuth).toBeUndefined();
    await opt.bringToFront();
    await expect(opt.locator('#cgSignedOut')).toBeVisible();
    await loginChatGPT(context, extId, opt);
    const last = (await logOf(mock, '/api/accounts/authorize')).pop();
    expect(last.query.client_id).toBe(chatgptAuth.clientId);
    expect(last.query.id_token_hint).toBe(chatgptAuth.idToken);
  });

  test('错误处理：用量上限、无资格、流中途失败', async ({ context, mock, extId }) => {
    await loginChatGPT(context, extId);

    await mock.control({ responsesError: 'usage_limit' });
    let r = await explainOnArticle(context, mock);
    await expect(r.box).toContainText('ChatGPT 套餐用量已达上限');
    await expect(r.box.getByRole('link', { name: '管理用量' })).toHaveAttribute('href', 'https://chatgpt.com/settings/usage');

    await mock.control({ responsesError: 'not_eligible' });
    r = await explainOnArticle(context, mock);
    await expect(r.box).toContainText('需要 Plus 或 Pro');
    // 403 不重试
    expect((await logOf(mock, '/v1/responses')).filter((e) => e.body.includes('tariffs')).length).toBe(2);

    await mock.control({ responsesError: 'fail_midstream' });
    r = await explainOnArticle(context, mock);
    await expect(r.box).toContainText('ChatGPT 套餐用量已达上限');
    await expect(r.box).toContainText('本句含义'); // 已收到的部分仍显示
  });

  test('401 subscription_sharing_invalid_user → 清除令牌要求重新登录', async ({ context, mock, extId, sw }) => {
    await loginChatGPT(context, extId);
    await mock.control({ responsesError: 'invalid_user' });
    const { box } = await explainOnArticle(context, mock);
    await expect(box).toContainText('重新登录');
    expect((await getStorage(sw, ['chatgptAuth'])).chatgptAuth).toBeUndefined();
  });

  test('未授权套餐用量 / 拒绝授权：给出提示并引导改用 API Key', async ({ context, mock, extId, sw }) => {
    await mock.control({ omitPlanScope: true });
    const opt = await loginChatGPT(context, extId);
    await expect(opt.locator('#cgUsing')).toHaveText('已登录，但未授权使用套餐用量');
    await expect(opt.locator('#cgError')).toContainText('改用 API Key');
    expect((await getStorage(sw, ['aiProvider'])).aiProvider ?? 'apikey').toBe('apikey');

    await opt.locator('#cgLogout').click();
    await expect(opt.locator('#cgSignedOut')).toBeVisible();
    await mock.control({ omitPlanScope: false, accessDenied: true });
    const [cb] = await Promise.all([
      context.waitForEvent('page', (p) => p.url().includes('/authorize') || p.url().includes('callback.html')),
      opt.getByRole('button', { name: 'Continue with ChatGPT' }).click(),
    ]);
    await cb.waitForURL(/callback\.html/);
    await expect(cb.locator('#title')).toHaveText('登录未完成');
    await expect(cb.locator('#msg')).toContainText('改用 API Key');
  });
});

test.describe('OAuth 回调拦截', () => {
  test('declarativeNetRequest 把 127.0.0.1 回调重定向到扩展页（回调端口上的服务收不到请求）', async ({ context, mock, extId }) => {
    const http = await import('node:http');
    let hits = 0;
    const decoy = http.createServer((req, res) => { hits++; res.end('NOT INTERCEPTED'); });
    await new Promise((r) => decoy.listen(14551, '127.0.0.1', r));
    try {
      const opt = await openOptions(context, extId);
      const [tab] = await Promise.all([
        context.waitForEvent('page'),
        opt.getByRole('button', { name: 'Continue with ChatGPT' }).click(),
      ]);
      await tab.waitForURL(/callback\.html/);
      expect(tab.url()).toBe(`chrome-extension://${extId}/callback.html`); // 授权码已从地址栏清除
      await expect(opt.locator('#cgSignedIn')).toBeVisible();
      expect(hits).toBe(0);
      expect((await logOf(mock, '/api/accounts/oauth/token')).length).toBe(1);
      // 登录结束后移除重定向规则
      const rules = await opt.evaluate(() => chrome.declarativeNetRequest.getDynamicRules());
      expect(rules).toEqual([]);
    } finally {
      await new Promise((r) => decoy.close(r));
    }
  });

  test('重定向规则缺失时由 webNavigation 兜底，按 state 去重只换一次令牌', async ({ context, mock, extId, sw }) => {
    await mock.control({ authorizeDelay: 1500 });
    const opt = await openOptions(context, extId);
    const [tab] = await Promise.all([
      context.waitForEvent('page'),
      opt.getByRole('button', { name: 'Continue with ChatGPT' }).click(),
    ]);
    await sw.evaluate(() => chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [1] }));
    await tab.waitForURL(/callback\.html/, { timeout: 15_000 });
    await expect(opt.locator('#cgSignedIn')).toBeVisible();
    await expect(opt.locator('#cgUsing')).toHaveText('正在使用 ChatGPT 套餐用量');
    expect((await logOf(mock, '/api/accounts/oauth/token')).length).toBe(1);
  });
});

test.describe('AI 优化注释：语境释义 + 难度分级', () => {
  const setupAI = (sw, mock, extra = {}) => setStorage(sw, {
    apiBase: `${mock.base}/v1`, apiKey: GOOD_KEY, apiModel: 'mock-chat-1', autoAI: true, ...extra,
  });
  const annotateCalls = async (mock) => (await logOf(mock, '/v1/chat/completions'))
    .map((e) => JSON.parse(e.body)).filter((b) => b.messages[0].content.includes('"items"'));

  test('按语境取舍：去掉专有名词，补充熟词僻义和短语，过滤无效条目', async ({ context, mock, sw }) => {
    await setupAI(sw, mock);
    const page = await context.newPage();
    await page.goto(mock.page('article.html'));
    await expect(page.locator('#p1')).toHaveAttribute('data-ik-ai', 'done');

    // 词典把句首的 Chancellor 当生词，模型去掉了它
    const p1 = await page.$$eval('#p1 ik-a', (els) => els.map((e) => e.dataset.w));
    expect(p1).not.toContain('Chancellor');
    expect(p1).toContain('tariffs');

    // 熟词僻义：标题里的 brace
    await expect(page.locator('#headline')).toHaveAttribute('data-ik-ai', 'done');
    const brace = page.locator('#headline ik-a[data-l="brace"]');
    await expect(brace).toHaveAttribute('data-kind', 'sense');
    await expect(brace.locator('ik-t')).toHaveText('准备应对');

    // 短语：整体注释
    await expect(page.locator('#p5')).toHaveAttribute('data-ik-ai', 'done');
    const phrases = page.locator('#p5 ik-a[data-kind="phrase"]');
    await expect(phrases).toHaveCount(2);
    await expect(phrases.nth(0)).toHaveAttribute('data-w', 'rule out');
    await expect(phrases.nth(0).locator('ik-t')).toHaveText('排除');
    await expect(phrases.nth(1)).toHaveAttribute('data-w', 'in the wake of');
    // 无效条目（文中不存在）被丢弃，原文不变
    expect(await page.locator('ik-a[data-w="not in this paragraph at all"]').count()).toBe(0);
    expect(await page.$eval('#p5', (el) => { const c = el.cloneNode(true); c.querySelectorAll('rt').forEach((r) => r.remove()); return c.textContent; }))
      .toBe('The minister refused to rule out new taxes in the wake of the vote.');

    // 请求：带读者水平；相邻短段落合并
    const calls = await annotateCalls(mock);
    expect(calls[0].messages[0].content).toContain('读者的英语词汇量约 4500 词（约四级水平，相当于 CEFR B1–B2）');
    expect(calls[0].messages[0].content).toContain('熟词僻义');
    expect(calls.some((c) => c.messages[1].content.includes('[P2]'))).toBe(true);
    expect(calls[0].messages[1].content).toMatch(/候选生词：.*tariffs/);
  });

  test('词卡显示语境义、CEFR 等级与类型；短语可标为认识', async ({ context, mock, sw }) => {
    await setupAI(sw, mock);
    const page = await context.newPage();
    await page.goto(mock.page('article.html'));
    await expect(page.locator('#p5')).toHaveAttribute('data-ik-ai', 'done');
    await expect(page.locator('#p1')).toHaveAttribute('data-ik-ai', 'done');

    await page.locator('#p1 ik-a[data-l="tariff"]').first().click();
    const card = cardLocator(page);
    await expect(card.locator('.ctx-gloss')).toHaveText('语境·tariffs');
    await expect(card.locator('.tag.lv')).toHaveText('B2');
    await expect(card.locator('.tag.kind')).toHaveText('生词');
    await expect(card.locator('.defs')).toContainText('关税'); // 词典释义仍在

    await page.keyboard.press('Escape');
    const before = (await logOf(mock, '/v1/chat/completions')).length;
    await page.locator('#p5 ik-a[data-w="rule out"]').click();
    await expect(card.locator('.word')).toHaveText('rule out');
    await expect(card.locator('.ctx-gloss')).toHaveText('排除');
    await expect(card.locator('.tag.kind')).toHaveText('短语');
    await page.waitForTimeout(300);
    expect((await logOf(mock, '/v1/chat/completions')).length).toBe(before); // 已有语境义，不自动再请求
    await card.getByRole('button', { name: '我认识这个短语' }).click();
    await expect(page.locator('#p5 ik-a[data-w="rule out"]')).toHaveCount(0);
    await expect(page.locator('#p5 ik-a[data-w="in the wake of"]')).toHaveCount(1);
    expect((await getStorage(sw, ['knownWords'])).knownWords).toContain('rule out');
  });

  test('生词本里的词在 AI 模式下仍然注释；水平变化后按新水平重新请求；关闭后回到词典注释', async ({ context, mock, sw }) => {
    await setupAI(sw, mock, { learningWords: ['market'] });
    const page = await context.newPage();
    await page.goto(mock.page('article.html'));
    await expect(page.locator('#p4')).toHaveAttribute('data-ik-ai', 'done');
    await expect(page.locator('#p4 ik-a[data-l="market"]')).toHaveCount(1);

    await setStorage(sw, { level: 8000 });
    await expect.poll(async () => (await annotateCalls(mock)).some((c) => c.messages[0].content.includes('约 8000 词'))).toBe(true);
    await expect(page.locator('#p1')).toHaveAttribute('data-ik-ai', 'done');

    await setStorage(sw, { autoAI: false });
    await expect(page.locator('#p5 ik-a')).toHaveCount(0);
    await expect(page.locator('#p1 ik-a[data-ai="1"]')).toHaveCount(0);
    await expect(page.locator('#p1 ik-a[data-l="stagnation"]')).toBeVisible(); // 8000 档下仍超纲的词
  });

  test('ChatGPT 方式同样可用', async ({ context, mock, extId, sw }) => {
    await loginChatGPT(context, extId);
    await setStorage(sw, { autoAI: true });
    const page = await context.newPage();
    await page.goto(mock.page('article.html'));
    await expect(page.locator('#p5 ik-a[data-kind="phrase"]')).toHaveCount(2);
    const req = (await logOf(mock, '/v1/responses')).map((e) => JSON.parse(e.body)).find((b) => b.instructions.includes('"items"'));
    expect(req).toMatchObject({ store: false, stream: true });
    expect(req).not.toHaveProperty('temperature');
  });
});
