import fs from 'node:fs';
import { test, expect, setStorage, getStorage, waitRegistered, annotatedWords, cardLocator, GOOD_KEY } from './helpers.js';
import { DEFAULT_MATCHES, patternToRegExp, matchesAny } from '../extension/lib/sites.js';

const manifest = JSON.parse(fs.readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8'));

test.describe('网站权限', () => {
  test('manifest 不再申请 <all_urls>；默认只在指定新闻和视频网站运行', () => {
    const all = [...manifest.host_permissions, ...manifest.permissions];
    expect(all).not.toContain('<all_urls>');
    expect(all.some((p) => /^\*:\/\/\*\/\*$|^https?:\/\/\*\/\*$/.test(p))).toBe(false);
    expect(manifest.content_scripts[0].matches).toEqual(DEFAULT_MATCHES);
    for (const p of DEFAULT_MATCHES) expect(manifest.host_permissions).toContain(p);
    for (const url of [
      'https://edition.cnn.com/2026/10/10/world/x', 'https://www.nbcnews.com/politics/x', 'https://www.cnbc.com/2026/10/10/x.html',
      'https://www.reuters.com/world/x/', 'https://www.bbc.com/news/articles/x', 'https://www.bbc.co.uk/news/x',
      'https://news.google.com/home', 'https://www.wsj.com/articles/x', 'https://www.youtube.com/watch?v=x', 'https://m.youtube.com/watch?v=x',
      'https://www.nytimes.com/2026/10/10/x.html', 'https://abcnews.go.com/x',
    ]) expect(matchesAny(url, DEFAULT_MATCHES), url).toBe(true);
    for (const url of ['https://www.google.com/search?q=x', 'https://example.com/', 'https://cnn.com.evil.example/x', 'https://notcnn.com/']) {
      expect(matchesAny(url, DEFAULT_MATCHES), url).toBe(false);
    }
    expect(manifest.optional_host_permissions).toEqual(['https://*/*', 'http://*/*']);
    expect(patternToRegExp('*://*.cnn.com/*').test('https://cnn.com/')).toBe(true);
  });

  test('未启用的网站不运行；启用后注册脚本并立即注入当前页；移除后停止', async ({ context, mock, sw, extId }) => {
    await sw.evaluate(async () => {
      const { devConfig } = await chrome.storage.local.get('devConfig');
      await chrome.storage.local.set({ devConfig: { ...devConfig, extraSites: [] } });
    });
    await waitRegistered(sw, false);

    const page = await context.newPage();
    await page.goto(mock.page('article.html'));
    await page.waitForTimeout(1500);
    expect(await page.locator('ik-a').count()).toBe(0);

    // 弹窗授权成功后的流程：记录网站、注册脚本、注入当前标签页（无需刷新）
    const opt = await context.newPage();
    await opt.goto(`chrome-extension://${extId}/options.html#sites`);
    await expect(opt.locator('#defaultSites')).toContainText('YouTube');
    await expect(opt.locator('#extraEmpty')).toBeVisible();
    const url = page.url();
    const res = await opt.evaluate(async (u) => {
      const [tab] = await chrome.tabs.query({ url: u });
      return chrome.runtime.sendMessage({ type: 'enableSite', url: u, tabId: tab.id });
    }, url);
    expect(res).toEqual({ ok: true, data: { pattern: 'http://127.0.0.1/*' } });
    await page.bringToFront();
    await page.waitForSelector('#p1 ik-a');
    await waitRegistered(sw, true);
    expect((await getStorage(sw, ['enabledSites'])).enabledSites).toEqual(['http://127.0.0.1/*']);

    // 新打开的页面由注册的脚本注入
    const page2 = await context.newPage();
    await page2.goto(mock.page('nyt-like.html'));
    await page2.waitForSelector('#n1 ik-a');

    // 设置页移除
    await opt.bringToFront();
    await expect(opt.locator('#extraSites')).toContainText('127.0.0.1');
    await opt.getByRole('button', { name: '移除 http://127.0.0.1/*' }).click();
    await expect(opt.locator('#extraEmpty')).toBeVisible();
    await waitRegistered(sw, false);
    const page3 = await context.newPage();
    await page3.goto(mock.page('article.html'));
    await page3.waitForTimeout(1500);
    expect(await page3.locator('ik-a').count()).toBe(0);
  });

  test('弹窗：默认网站显示开关；其他网站显示「在此网站启用」', async ({ context, extId }) => {
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extId}/popup.html?url=${encodeURIComponent('https://www.bbc.com/news/articles/abc')}`);
    await expect(popup.locator('#siteRow')).toBeVisible();
    await expect(popup.locator('#host')).toHaveText('www.bbc.com');
    await expect(popup.locator('#siteOn')).toBeChecked();
    await expect(popup.locator('#grantRow')).toBeHidden();

    await popup.goto(`chrome-extension://${extId}/popup.html?url=${encodeURIComponent('https://blog.example.org/post')}`);
    await expect(popup.locator('#grantRow')).toBeVisible();
    await expect(popup.locator('#grantHost')).toHaveText('blog.example.org');
    await expect(popup.getByRole('button', { name: '在此网站启用' })).toBeVisible();
    await expect(popup.locator('#siteRow')).toBeHidden();
  });

  test('自定义 API 地址未授权时给出明确提示', async ({ context, extId }) => {
    const opt = await context.newPage();
    await opt.goto(`chrome-extension://${extId}/options.html`);
    const res = await opt.evaluate((key) => chrome.runtime.sendMessage({
      type: 'listModels', provider: 'apikey', apiBase: 'http://localhost:18080/v1', apiKey: key,
    }), GOOD_KEY);
    expect(res.ok).toBe(false);
    expect(res.error.message).toContain('还没有授权访问 localhost:18080');
  });
});

test.describe('YouTube 字幕', () => {
  test('字幕里的生词被注释（浅色释义），点击出词卡且不触发播放器点击；字幕不做 AI 优化', async ({ context, mock, sw }) => {
    await setStorage(sw, { apiBase: `${mock.base}/v1`, apiKey: GOOD_KEY, apiModel: 'mock-chat-1', autoAI: true });
    const page = await context.newPage();
    await page.goto(mock.page('youtube-like.html'));
    await page.waitForSelector('#cw0 ik-a');
    expect(await annotatedWords(page, '#cw0')).toEqual(expect.arrayContaining(['tariffs', 'exacerbate']));
    expect(await page.$eval('#cw0 rt', (el) => getComputedStyle(el).color)).toBe('rgb(255, 212, 121)');

    // 字幕换行后很快被注释
    await page.waitForSelector('#cw1 ik-a', { timeout: 4000 });
    expect(await annotatedWords(page, '#cw1')).toEqual(expect.arrayContaining(['protracted', 'rattled']));
    await page.locator('#cw1 ik-a[data-w="protracted"]').click();
    await expect(cardLocator(page).locator('.word')).toHaveText('protracted');
    expect(await page.evaluate(() => window.playerClicks)).toBe(0);

    // 被行数截断的标题只加下划线，不撑高行距
    await page.waitForSelector('#clamped ik-a');
    expect(await page.locator('#clamped ik-a').count()).toBeGreaterThan(1);
    expect(await page.locator('#clamped rt').count()).toBe(0);
    expect(await page.$eval('#clamped', (el) => el.getBoundingClientRect().height)).toBeLessThanOrEqual(40);

    // 标题照常走 AI 优化，字幕不请求
    await expect(page.locator('#title')).toHaveAttribute('data-ik-ai', 'done');
    const bodies = (await mock.log()).filter((e) => e.path === '/v1/chat/completions').map((e) => e.body);
    expect(bodies.some((b) => b.includes('How tariffs exacerbate inflation'))).toBe(true);
    expect(bodies.some((b) => b.includes('rattled markets') || b.includes('could exacerbate inflation'))).toBe(false);
  });
});
