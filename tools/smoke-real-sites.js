// 真实新闻站点冒烟检查（需要联网，不属于 CI 测试）：node tools/smoke-real-sites.js [输出目录]
// 从各站首页找一篇文章，加载扩展后统计注释情况并截图。
import { chromium } from '@playwright/test';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'extension');
const OUT = process.argv[2] || path.join(os.tmpdir(), 'inkling-smoke');
fs.mkdirSync(OUT, { recursive: true });

const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;
const SITES = [
  { name: 'bbc', home: 'https://www.bbc.com/news', link: /bbc\.com\/news\/articles\/[a-z0-9]+$/ },
  { name: 'guardian', home: 'https://www.theguardian.com/international', link: /theguardian\.com\/[a-z-]+(\/[a-z-]+)?\/\d{4}\/[a-z]{3}\/\d{2}\/[a-z0-9-]+$/ },
  { name: 'nyt', home: 'https://www.nytimes.com/', link: /nytimes\.com\/\d{4}\/\d{2}\/\d{2}\/[a-z/-]+\.html/ },
  { name: 'reuters', home: 'https://www.reuters.com/world/', link: /reuters\.com\/[a-z-]+\/[a-z0-9-/]+-\d{4}-\d{2}-\d{2}\/$/ },
];

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inkling-smoke-'));
const ctx = await chromium.launchPersistentContext(dir, {
  channel: 'chromium',
  headless: !process.env.HEADED,
  viewport: { width: 1280, height: 900 },
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker');
await sw.evaluate(() => chrome.storage.local.set({ devConfig: { noWelcome: true } }));

const report = [];
for (const s of SITES.filter((x) => !ONLY || ONLY.includes(x.name))) {
  const page = await ctx.newPage();
  const r = { site: s.name };
  try {
    await page.goto(s.home, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(2500);
    const hrefs = await page.$$eval('a[href]', (as) => as.map((a) => a.href));
    const url = s.url || hrefs.find((h) => s.link.test(h.split('?')[0]));
    if (!url) throw new Error(`no article link found on ${s.home} (title: ${await page.title()})`);
    r.url = url;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(3000);
    for (let i = 0; i < 8; i++) { await page.mouse.wheel(0, 900); await page.waitForTimeout(400); }
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(800);
    Object.assign(r, await page.evaluate(() => {
      const all = [...document.querySelectorAll('ik-a')];
      const inBad = all.filter((a) => a.closest('nav, footer, code, pre, [contenteditable="true"], input, textarea'));
      const caps = all.filter((a) => /^[A-Z]/.test(a.dataset.w)).map((a) => {
        const b = a.closest('p, li, h1, h2, h3, figcaption, div');
        return `${a.dataset.w} ← ${(b?.textContent || '').replace(/\s+/g, ' ').slice(0, 70)}`;
      });
      return {
        title: document.title.slice(0, 80),
        annotations: all.length,
        glossed: document.querySelectorAll('ik-a.ik-gloss').length,
        inNavFooterCode: inBad.length,
        capitalized: [...new Set(caps)].slice(0, 30),
        sample: [...new Set(all.map((a) => a.dataset.w))].slice(0, 40),
        h: document.documentElement.scrollHeight,
      };
    }));
    const first = page.locator('ik-a.ik-gloss').first();
    if (await first.count()) await first.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(OUT, `${s.name}.png`) });
    if (await first.count()) {
      await first.dispatchEvent('click');
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(OUT, `${s.name}-card.png`) });
      r.cardVisible = await page.locator('inkling-ui .card').isVisible();
      r.urlUnchanged = page.url() === url;
    }
  } catch (e) {
    r.error = e.message.split('\n')[0];
    await page.screenshot({ path: path.join(OUT, `${s.name}-error.png`) }).catch(() => {});
  }
  report.push(r);
  console.log(JSON.stringify(r, null, 1));
  await page.close();
}
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
await ctx.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log('screenshots in', OUT);
