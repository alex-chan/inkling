// 生成 Chrome Web Store 素材：node store/make-assets.mjs
// 截图 1280×800、小型宣传图 440×280。AI 结果由本地假服务返回，内容针对 showcase.html 手写。
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(here, '..', 'extension');
const OUT = path.join(here, 'assets');
fs.mkdirSync(OUT, { recursive: true });

const ITEMS = [
  [/brace for a long winter/, [['brace', '准备应对', 'B2', 'sense'], ['stall', '陷入僵局', 'B2', 'sense']]],
  [/^Global markets/, [['braced', '准备应对', 'B2', 'sense'], ['turbulence', '动荡', 'C1', 'word'], ['deadlock', '僵局', 'C1', 'word'],
    ['tariffs', '关税', 'B2', 'word'], ['grapple with', '努力应对', 'C1', 'phrase'], ['mounting', '不断加剧的', 'B2', 'sense']]],
  [/^Officials/, [['rule out', '排除', 'B2', 'phrase'], ['levies', '征税', 'C1', 'word'], ['protracted', '旷日持久的', 'C2', 'word'],
    ['exacerbate', '加剧', 'C1', 'word'], ['sluggish', '低迷的', 'C1', 'word'], ['In the wake of', '紧随…之后', 'C1', 'phrase'],
    ['postpone', '推迟', 'B2', 'word'], ['opaque', '不明朗', 'C1', 'sense']]],
  [/Nobody wants/, [['escalation', '升级', 'C1', 'word'], ['rhetoric', '言辞', 'C1', 'word'], ['entrenched', '根深蒂固的', 'C2', 'word']]],
  [/^Shipping firms/, [['hedging against', '防范', 'C1', 'phrase'], ['standoff', '僵持', 'C1', 'word'], ['prolonged', '长期的', 'B2', 'word']]],
];
const EXPLAIN = '本句含义：形容争端拖了很久、迟迟解决不了，即“旷日持久的”。\n读音：/proʊˈtræktəd/\n用法：形容词，常修饰 dispute、negotiations、war 等，带有“拖得太久”的负面色彩。';

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', async () => {
    if (req.url.startsWith('/pages/')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(path.join(here, 'showcase.html')));
    }
    if (req.url === '/v1/models') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"data":[{"id":"demo"}]}'); }
    const j = JSON.parse(body || '{}');
    const sys = j.messages?.[0]?.content || '';
    const user = j.messages?.[1]?.content || '';
    let text = EXPLAIN;
    if (sys.includes('"items"')) {
      const items = [];
      for (const chunk of user.split(/\n\n(?=\[P\d+\])/)) {
        const m = /^\[P(\d+)\] ([\s\S]*?)\n候选生词/.exec(chunk);
        if (!m) continue;
        const hit = ITEMS.find(([re]) => re.test(m[2]));
        for (const [t, gloss, level, kind] of hit ? hit[1] : []) items.push({ p: Number(m[1]), text: t, gloss, level, kind });
      }
      text = JSON.stringify({ items });
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const part of text.match(/[\s\S]{1,8}/g)) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: part } }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
});
await new Promise((r) => server.listen(18090, '127.0.0.1', r));
const base = 'http://127.0.0.1:18090';

async function launch(settings) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ik-store-'));
  const ctx = await chromium.launchPersistentContext(dir, {
    channel: 'chromium', headless: true, viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  await sw.evaluate((s) => chrome.storage.local.set(s), {
    devConfig: { noWelcome: true, extraSites: ['http://127.0.0.1/*'] }, apiBase: `${base}/v1`, apiKey: 'demo', apiModel: 'demo', ...settings,
  });
  // 展示页在 127.0.0.1 上，不在默认网站列表里：等动态注册的 content script 就绪
  for (let i = 0; i < 100; i++) {
    if ((await sw.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).length)) > 0) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  for (const p of ctx.pages()) if (p.url().includes('options.html')) await p.close();
  return { ctx, id: new URL(sw.url()).host };
}

// 1. 词卡（AI 语境解释）
{
  const { ctx } = await launch({ autoAI: true });
  const p = await ctx.newPage();
  await p.goto(`${base}/pages/showcase.html`);
  await p.waitForSelector('#a2[data-ik-ai="done"]');
  await p.waitForSelector('#h[data-ik-ai="done"]');
  await p.locator('#a2 ik-a[data-w="protracted"]').click();
  await p.locator('inkling-ui .card').getByRole('button', { name: 'AI 语境解释' }).click();
  await p.waitForFunction(() => document.querySelector('inkling-ui').shadowRoot.querySelector('.ai')?.dataset.state === 'done');
  await p.screenshot({ path: path.join(OUT, 'screenshot-1-card.png') });
  await ctx.close();
}
// 2. 美式音标
{
  const { ctx } = await launch({ showPhonetic: true, autoAI: true });
  const p = await ctx.newPage();
  await p.goto(`${base}/pages/showcase.html`);
  await p.waitForSelector('#a2[data-ik-ai="done"]');
  await p.waitForSelector('#a4[data-ik-ai="done"]');
  await p.waitForTimeout(400);
  await p.screenshot({ path: path.join(OUT, 'screenshot-2-phonetic.png') });
  await ctx.close();
}
// 3. AI 优化注释：熟词僻义、短语、CEFR
{
  const { ctx } = await launch({ autoAI: true });
  const p = await ctx.newPage();
  await p.goto(`${base}/pages/showcase.html`);
  await p.waitForSelector('#a2[data-ik-ai="done"]');
  await p.waitForSelector('#a1[data-ik-ai="done"]');
  await p.locator('#a2 ik-a[data-w="In the wake of"]').click();
  await p.waitForTimeout(300);
  await p.screenshot({ path: path.join(OUT, 'screenshot-3-ai.png') });
  await ctx.close();
}
// 4. 设置页：词汇水平
{
  const { ctx, id } = await launch({ knownWords: ['tariff', 'escalation'], learningWords: ['hedge'] });
  const p = await ctx.newPage();
  await p.goto(`chrome-extension://${id}/options.html`);
  await p.waitForSelector('#near .chip'); // 首次加载词典约 1–2 秒
  await p.waitForTimeout(300);
  await p.screenshot({ path: path.join(OUT, 'screenshot-4-settings.png') });
  await ctx.close();
}
// 宣传图：小型 440×280、顶部 1400×560
{
  const b = await chromium.launch();
  for (const [file, w, h, out] of [
    ['promo-tile.html', 440, 280, 'promo-small-440x280.png'],
    ['promo-marquee.html', 1400, 560, 'promo-marquee-1400x560.png'],
  ]) {
    const p = await b.newPage({ viewport: { width: w, height: h } });
    await p.goto('file://' + path.join(here, file));
    await p.waitForLoadState('load');
    await p.screenshot({ path: path.join(OUT, out) });
    await p.close();
  }
  await b.close();
}
server.close();
console.log('assets in', OUT);
