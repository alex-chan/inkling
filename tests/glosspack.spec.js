import { test, expect, setStorage, getStorage, waitAnnotated, cardLocator, GOOD_KEY } from './helpers.js';

async function chooseGloss(opt, lang) {
  await opt.locator('#glossLanguage').selectOption(lang);
}

test.describe('日语 / 韩语释义包（按需从 GitHub Pages 下载）', () => {
  test('选择日语：下载并校验释义包，页面注释改为日语，没有释义的词只加下划线', async ({ context, mock, extId, sw }) => {
    const opt = await context.newPage();
    await opt.goto(`chrome-extension://${extId}/options.html`);
    await expect(opt.locator('#glossLanguage')).toHaveValue('zh');
    await chooseGloss(opt, 'ja');
    await expect(opt.locator('#packStatus')).toContainText('日语释义包已就绪：5 个词');
    expect((await getStorage(sw, ['glossLanguage'])).glossLanguage).toBe('ja');
    // 只在选择时才请求，且只下载所选语言
    const packReqs = (await mock.log()).filter((e) => e.path.startsWith('/glosspacks/')).map((e) => e.path);
    expect(packReqs).toEqual(['/glosspacks/index.json', '/glosspacks/ja/gloss-ja-test.tsv']);

    const page = await context.newPage();
    await page.goto(mock.page('article.html'));
    await waitAnnotated(page, '#p1');
    await expect(page.locator('#p1 ik-a[data-l="tariff"] rt')).toHaveText('関税');
    await expect(page.locator('#p1 ik-a[data-l="stagnation"] rt')).toHaveText('停滞');
    // 释义包里没有的词：仍按词频判断为生词，但只加下划线
    await expect(page.locator('#p1 ik-a[data-l="retaliate"]')).toHaveCount(1);
    await expect(page.locator('#p1 ik-a[data-l="retaliate"] rt')).toHaveCount(0);

    await page.locator('#p1 ik-a[data-l="tariff"]').first().click();
    const card = cardLocator(page);
    await expect(card.locator('.defs')).toHaveText('関税、税率');
    await expect(card.locator('.note.src')).toContainText('维基词典');
    await page.keyboard.press('Escape');
    await page.locator('#p1 ik-a[data-l="retaliate"]').click();
    await expect(card.locator('.note')).toContainText('释义包里暂时没有这个词的日语释义');

    // 已打开的页面切换释义语言后立即生效；切回中文离线可用
    await chooseGloss(opt, 'zh');
    await expect(page.locator('#p1 ik-a[data-l="tariff"] rt')).toHaveText('关税');
    // 再次选日语：已缓存，不再下载释义包文件
    const before = (await mock.log()).filter((e) => e.path.endsWith('.tsv')).length;
    await chooseGloss(opt, 'ja');
    await expect(page.locator('#p1 ik-a[data-l="tariff"] rt')).toHaveText('関税');
    expect((await mock.log()).filter((e) => e.path.endsWith('.tsv')).length).toBe(before);
  });

  test('校验失败时不切换，仍保持原来的释义语言', async ({ context, mock, extId, sw }) => {
    await mock.control({ packCorrupt: true });
    const opt = await context.newPage();
    await opt.goto(`chrome-extension://${extId}/options.html`);
    await chooseGloss(opt, 'ko');
    await expect(opt.locator('#packStatus')).toContainText('释义包校验失败');
    await expect(opt.locator('#glossLanguage')).toHaveValue('zh');
    expect((await getStorage(sw, ['glossLanguage'])).glossLanguage ?? 'zh').toBe('zh');
  });

  test('韩语释义包；删除释义包后回到中文', async ({ context, mock, extId, sw }) => {
    const opt = await context.newPage();
    await opt.goto(`chrome-extension://${extId}/options.html`);
    await chooseGloss(opt, 'ko');
    await expect(opt.locator('#packStatus')).toContainText('韩语释义包已就绪：3 个词');
    const page = await context.newPage();
    await page.goto(mock.page('article.html'));
    await waitAnnotated(page, '#p1');
    await expect(page.locator('#p1 ik-a[data-l="tariff"] rt')).toHaveText('관세');

    await opt.bringToFront();
    await opt.getByRole('button', { name: '删除已下载的释义包' }).click();
    await expect(opt.locator('#packStatus')).toHaveText('已删除，释义语言改回中文。');
    await expect(opt.locator('#glossLanguage')).toHaveValue('zh');
    expect((await getStorage(sw, ['glossLanguage'])).glossLanguage).toBe('zh');
    await expect(page.locator('#p1 ik-a[data-l="tariff"] rt')).toHaveText('关税');
  });

  test('释义语言为日语时，AI 解释用日语输出（含日语栏目名）', async ({ context, mock, extId, sw }) => {
    await setStorage(sw, { apiBase: `${mock.base}/v1`, apiKey: GOOD_KEY, apiModel: 'mock-chat-1' });
    const opt = await context.newPage();
    await opt.goto(`chrome-extension://${extId}/options.html`);
    await chooseGloss(opt, 'ja');
    await expect(opt.locator('#packStatus')).toContainText('已就绪');
    const page = await context.newPage();
    await page.goto(mock.page('article.html'));
    await waitAnnotated(page, '#p1');
    await page.locator('#p1 ik-a[data-l="tariff"]').first().click();
    await cardLocator(page).getByRole('button', { name: 'AI 语境解释' }).click();
    await expect(cardLocator(page).locator('.ai')).toHaveAttribute('data-state', 'done');
    const sys = JSON.parse((await mock.log()).filter((e) => e.path === '/v1/chat/completions').pop().body).messages[0].content;
    expect(sys).toContain('用日本語');
    expect(sys).toContain('この文での意味');
    expect(sys).toContain('日语母语读者');
  });
});
