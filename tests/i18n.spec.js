import fs from 'node:fs';
import { test, expect, setStorage, waitAnnotated, cardLocator } from './helpers.js';

const loc = (l) => JSON.parse(fs.readFileSync(new URL(`../extension/_locales/${l}/messages.json`, import.meta.url), 'utf8'));
const zhCN = loc('zh_CN');
const zhTW = loc('zh_TW');
const en = loc('en');
const ja = loc('ja');
const ko = loc('ko');

test.describe('界面多语言', () => {
  test('三种语言的 key 完全一致，没有空文案，占位符数量一致', () => {
    const keys = Object.keys(zhCN).sort();
    for (const m of [zhTW, en, ja, ko]) expect(Object.keys(m).sort()).toEqual(keys);
    for (const k of keys) {
      const ph = (s) => (s.match(/\{\d\}/g) || []).sort().join();
      for (const m of [zhCN, zhTW, en, ja, ko]) {
        expect(m[k].message.trim(), k).not.toBe('');
        expect(ph(m[k].message), k).toBe(ph(zhCN[k].message));
      }
    }
    for (const m of [zhCN, zhTW, en, ja, ko]) {
      expect(m.appDesc.message.length).toBeLessThanOrEqual(132);
      expect(m.appName.message.length).toBeLessThanOrEqual(75);
    }
  });

  test('manifest 名称和说明走 _locales，扩展能正常加载', async ({ sw }) => {
    const r = await sw.evaluate(() => ({ name: chrome.i18n.getMessage('appName'), m: chrome.runtime.getManifest().default_locale }));
    expect(r.m).toBe('zh_CN');
    expect(r.name).toBeTruthy();
  });

  test('设置页切换语言：English / 繁體中文 / 跟随浏览器', async ({ context, extId, sw }) => {
    const opt = await context.newPage();
    await opt.goto(`chrome-extension://${extId}/options.html`);
    await expect(opt.locator('h2[data-i18n="sites_h"]')).toHaveText('支持的网站');

    await opt.locator('#uiLanguage').selectOption('en');
    await expect(opt.locator('h2[data-i18n="sites_h"]')).toHaveText('Supported sites');
    await expect(opt.locator('html')).toHaveAttribute('lang', 'en');
    await expect(opt).toHaveTitle('Inkling · Settings');
    await expect(opt.locator('#knownLabel')).toHaveText('Known (0) · never glossed');
    await expect(opt.locator('#aboutText a')).toHaveText('ECDICT');
    await expect(opt.locator('#presets')).toContainText('CET-4 4500');
    await expect(opt.locator('#defaultSites')).toContainText('Google News');
    await expect(opt.locator('.swatch').first()).toHaveAttribute('title', 'Black');

    await opt.locator('#uiLanguage').selectOption('zh_TW');
    await expect(opt.locator('h2[data-i18n="sites_h"]')).toHaveText('支援的網站');
    await expect(opt.getByRole('button', { name: '測試連線' }).first()).toBeVisible();

    await opt.locator('#uiLanguage').selectOption('ja');
    await expect(opt.locator('h2[data-i18n="sites_h"]')).toHaveText('対応サイト');
    await expect(opt.locator('html')).toHaveAttribute('lang', 'ja');
    await opt.locator('#uiLanguage').selectOption('ko');
    await expect(opt.locator('h2[data-i18n="sites_h"]')).toHaveText('지원 사이트');
    await expect(opt.getByRole('button', { name: '연결 테스트' }).first()).toBeVisible();

    // 跟随浏览器：测试浏览器为英文
    await opt.locator('#uiLanguage').selectOption('auto');
    await expect(opt.locator('h2[data-i18n="sites_h"]')).toHaveText('Supported sites');
    expect((await sw.evaluate(() => chrome.storage.local.get('uiLanguage'))).uiLanguage).toBe('auto');
  });

  test('弹窗按所选语言显示，网站名嵌在译文中', async ({ context, extId, sw }) => {
    await setStorage(sw, { uiLanguage: 'en' });
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extId}/popup.html?url=${encodeURIComponent('https://www.bbc.com/news/x')}`);
    await expect(popup.locator('#siteLabel')).toHaveText('Enabled on www.bbc.com');
    await expect(popup.locator('#counts')).toHaveText('Known 0 · Learning 0');
    await expect(popup.getByRole('button', { name: 'Settings' })).toBeVisible();
    await popup.goto(`chrome-extension://${extId}/popup.html?url=${encodeURIComponent('https://blog.example.org/')}`);
    await expect(popup.locator('#grantText')).toContainText("blog.example.org isn't on the default list");
    await expect(popup.getByRole('button', { name: 'Enable on this site' })).toBeVisible();
  });

  test('页面词卡与后台错误随语言切换（无需刷新页面）', async ({ context, mock, sw }) => {
    await setStorage(sw, { uiLanguage: 'en' });
    const page = await context.newPage();
    await page.goto(mock.page('article.html'));
    await waitAnnotated(page, '#p1');
    await page.locator('#p1 ik-a[data-l="tariff"]').first().click();
    const card = cardLocator(page);
    await expect(card.getByRole('button', { name: 'I know this word' })).toBeVisible();
    await expect(card.locator('.meta')).toContainText('Frequency #');
    await expect(card.locator('.meta')).toContainText('Base form tariff');
    await expect(card.locator('.tag').first()).toHaveText('CET-6');
    // 未配置 API Key：后台返回英文错误，并提供设置链接
    await card.getByRole('button', { name: 'Explain in context (AI)' }).click();
    await expect(card.locator('.ai')).toContainText('No API key yet');
    await expect(card.getByText('Open Inkling settings')).toBeVisible();

    await setStorage(sw, { uiLanguage: 'zh_TW' });
    await expect(card).toBeHidden(); // 切换语言时关闭旧词卡
    await page.waitForTimeout(300); // 等新语言文案从后台取回
    await page.locator('#p1 ik-a[data-l="tariff"]').first().click();
    await expect(card.getByRole('button', { name: '我認識這個詞' })).toBeVisible();
    await card.getByRole('button', { name: 'AI 語境解釋' }).click();
    await expect(card.locator('.ai')).toContainText('尚未填寫 API Key');
  });

  test('繁体界面时，AI 提示词要求输出繁體中文', async ({ context, mock, sw }) => {
    await setStorage(sw, { uiLanguage: 'zh_TW', apiBase: `${mock.base}/v1`, apiKey: 'sk-test-good', apiModel: 'mock-chat-1' });
    const page = await context.newPage();
    await page.goto(mock.page('article.html'));
    await waitAnnotated(page, '#p1');
    await page.locator('#p1 ik-a[data-l="tariff"]').first().click();
    await cardLocator(page).getByRole('button', { name: 'AI 語境解釋' }).click();
    await expect(cardLocator(page).locator('.ai')).toHaveAttribute('data-state', 'done');
    const body = JSON.parse((await mock.log()).filter((e) => e.path === '/v1/chat/completions').pop().body);
    expect(body.messages[0].content).toContain('用繁體中文');
  });
});
