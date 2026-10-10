import { test, expect, setStorage, getStorage, waitAnnotated, annotatedWords, cardLocator } from './helpers.js';

test.describe('生词自动注释', () => {
  test('注释生词，跳过人名地名、导航、代码、缩写、外文与可编辑区域', async ({ context, mock }) => {
    const page = await context.newPage();
    await page.goto(mock.page('article.html'));
    await waitAnnotated(page, '#p1');

    const p1 = await annotatedWords(page, '#p1');
    expect(p1).toContain('tariffs');
    expect(p1).toContain('stagnation');
    expect(p1).toContain('levies');
    // 专有名词、全大写缩写不注释
    for (const w of ['Rachel', 'Reeves', 'Trump', 'Turkey', 'NATO']) expect(p1).not.toContain(w);
    // 常见词不注释
    for (const w of ['government', 'said', 'would', 'warning']) expect(p1).not.toContain(w);

    // 词形还原：tariffs -> tariff，levies -> levy
    const lemmas = await page.$$eval('#p1 ik-a', (els) => Object.fromEntries(els.map((e) => [e.dataset.w, e.dataset.l])));
    expect(lemmas.tariffs).toBe('tariff');
    expect(lemmas.levies).toBe('levy');

    // went -> go：认识，不注释
    await page.waitForTimeout(300);
    expect(await annotatedWords(page, '#p4')).toEqual([]);

    // 导航、代码、页脚、外文、可编辑区域、输入框
    for (const sel of ['#nav', '#pre', '#footer', '#fr', '#editable']) {
      expect(await page.locator(`${sel} ik-a`).count(), sel).toBe(0);
    }
    expect(await page.inputValue('#input')).toBe('perfunctory quagmire');
    expect(await page.inputValue('#ta')).toBe('perfunctory quagmire');

    // 默认显示方式为词上方小字（ruby），只有首次出现带释义
    const p2 = page.locator('#p2 ik-a[data-l="tariff"]');
    await expect(p2).toHaveCount(2);
    await expect(p2.nth(0).locator('rt')).toHaveCount(1);
    await expect(p2.nth(1).locator('rt')).toHaveCount(0);
    await expect(page.locator('#p1 ik-a[data-l="tariff"] rt')).toHaveText('关税');

    // 原文文本保持不变（去掉注释后）
    const plain = await page.$eval('#p2', (el) => {
      const c = el.cloneNode(true);
      c.querySelectorAll('rt').forEach((r) => r.remove());
      return c.textContent;
    });
    expect(plain).toBe('Analysts describe the tariffs as a quagmire. The tariffs were levied on steel, and the ensuing turmoil rattled investors. Keir Starmer met Erdogan to discuss the embargo, and later called Trump.');
  });

  test('懒处理：远处段落滚动到附近才注释；动态内容补扫', async ({ context, mock }) => {
    const page = await context.newPage();
    await page.goto(mock.page('article.html'));
    await waitAnnotated(page, '#p1');
    expect(await page.locator('#far ik-a').count()).toBe(0);
    await page.waitForSelector('#dyn ik-a');
    expect(await annotatedWords(page, '#dyn')).toEqual(expect.arrayContaining(['belated', 'rejoinder', 'exacerbated']));
    await page.locator('#far').scrollIntoViewIfNeeded();
    await waitAnnotated(page, '#far');
    expect(await annotatedWords(page, '#far')).toEqual(expect.arrayContaining(['recalcitrant', 'bureaucracy']));
  });

  test('调整词汇量与显示方式后，已打开页面立即生效', async ({ context, mock, sw }) => {
    const page = await context.newPage();
    await page.goto(mock.page('article.html'));
    await waitAnnotated(page, '#p1');
    const count = () => page.locator('article ik-a').count();
    const base = await count();

    await setStorage(sw, { level: 1500 });
    await expect.poll(count).toBeGreaterThan(base);
    const low = await count();

    await setStorage(sw, { level: 20000 });
    await expect.poll(count).toBeLessThan(base);
    const high = await count();
    expect(low).toBeGreaterThan(high);

    await setStorage(sw, { level: 4500, displayMode: 'paren' });
    await expect(page.locator('#p1 ik-a[data-l="tariff"] ik-g')).toHaveText('（关税）');
    await expect(page.locator('#p1 rt')).toHaveCount(0);

    await setStorage(sw, { displayMode: 'underline' });
    await expect(page.locator('#p1 ik-g')).toHaveCount(0);
    await expect(page.locator('#p1 ik-a').first()).toBeVisible();

    // 当前网站关闭 → 注释全部移除
    await setStorage(sw, { disabledSites: ['127.0.0.1'] });
    await expect.poll(count).toBe(0);
    await setStorage(sw, { disabledSites: [] });
    await expect.poll(count).toBeGreaterThan(0);
  });

  test('复制网页文字时不带注释', async ({ context, mock }) => {
    const page = await context.newPage();
    await page.goto(mock.page('article.html'));
    await waitAnnotated(page, '#p2');
    // rt 不可选中
    expect(await page.$eval('#p2 rt', (el) => getComputedStyle(el).userSelect)).toBe('none');
    for (const mode of ['ruby', 'paren']) {
      if (mode === 'paren') {
        const sw = context.serviceWorkers()[0];
        await setStorage(sw, { displayMode: 'paren' });
        await page.waitForSelector('#p2 ik-g');
      }
      const copied = await page.evaluate(() => {
        const r = document.createRange();
        r.selectNodeContents(document.getElementById('p2'));
        const sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(r);
        const dt = new DataTransfer();
        document.dispatchEvent(new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true }));
        return dt.getData('text/plain');
      });
      expect(copied.trim(), mode).toBe('Analysts describe the tariffs as a quagmire. The tariffs were levied on steel, and the ensuing turmoil rattled investors. Keir Starmer met Erdogan to discuss the embargo, and later called Trump.');
    }
  });
});

test.describe('词卡', () => {
  test('点击生词弹出词卡，可朗读；「我认识这个词」后注释消失且刷新后仍生效', async ({ context, mock, sw }) => {
    const page = await context.newPage();
    await page.goto(mock.page('article.html'));
    await waitAnnotated(page, '#p1');
    await page.locator('#p1 ik-a[data-l="stagnation"]').click();
    const card = cardLocator(page);
    await expect(card).toBeVisible();
    await expect(card.locator('.word')).toHaveText('stagnation');
    await expect(card.locator('.ph')).toContainText('/');
    await expect(card.locator('.defs')).toContainText('停滞');
    await expect(card.locator('.meta')).toContainText('词频');

    await card.locator('.speak').click();
    await expect(card).toHaveAttribute('data-speaking', 'stagnation');

    await card.getByRole('button', { name: '我认识这个词' }).click();
    await expect(card).toBeHidden();
    await expect(page.locator('ik-a[data-l="stagnation"]')).toHaveCount(0);
    expect((await getStorage(sw, ['knownWords'])).knownWords).toContain('stagnation');

    await page.reload();
    await waitAnnotated(page, '#p1');
    await expect(page.locator('ik-a[data-l="stagnation"]')).toHaveCount(0);
    await expect(page.locator('#p1 ik-a[data-l="tariff"]')).toHaveCount(1);
  });

  test('链接里的生词：点击只弹词卡、不跳转', async ({ context, mock }) => {
    const page = await context.newPage();
    await page.goto(mock.page('article.html'));
    await waitAnnotated(page, '#p3');
    const before = page.url();
    await page.locator('#link ik-a').click();
    await expect(cardLocator(page)).toBeVisible();
    await expect(cardLocator(page).locator('.word')).toHaveText('ubiquitous');
    await page.waitForTimeout(500);
    expect(page.url()).toBe(before);
  });

  test('划词出现「注」按钮；单词可加入生词本', async ({ context, mock, sw }) => {
    const page = await context.newPage();
    await page.goto(mock.page('article.html'));
    await waitAnnotated(page, '#p1');
    // 选中 "market"（常见词，本未注释）
    const box = await page.evaluate(() => {
      const t = document.getElementById('p4').firstChild;
      const i = t.nodeValue.indexOf('market');
      const r = document.createRange();
      r.setStart(t, i);
      r.setEnd(t, i + 6);
      const b = r.getBoundingClientRect();
      return { x1: b.left + 1, x2: b.right - 1, y: b.top + b.height / 2 };
    });
    await page.mouse.move(box.x1, box.y);
    await page.mouse.down();
    await page.mouse.move(box.x2, box.y, { steps: 5 });
    await page.mouse.up();
    const btn = page.locator('inkling-ui .sel');
    await expect(btn).toBeVisible();
    await btn.click();
    const card = cardLocator(page);
    await expect(card.locator('.word')).toHaveText('market');
    await card.getByRole('button', { name: '加入生词本' }).click();
    await expect(card.getByRole('button', { name: '移出生词本' })).toBeVisible();
    expect((await getStorage(sw, ['learningWords'])).learningWords).toContain('market');
    // 生词本里的词不论词频都注释
    await expect(page.locator('#p4 ik-a[data-l="market"]')).toHaveCount(1);
  });
});

// 开关的 input 是隐藏的，点击可见的滑轨
async function toggle(page, sel, on) {
  if ((await page.locator(sel).isChecked()) !== on) await page.locator(`${sel} + span`).click();
  await expect(page.locator(sel)).toBeChecked({ checked: on });
}

test.describe('音标与发音设置', () => {
  test('设置页开关美式音标：注释里显示 / 隐藏，括注模式同样生效，复制不带音标', async ({ context, mock, extId, sw }) => {
    const page = await context.newPage();
    await page.goto(mock.page('article.html'));
    await waitAnnotated(page, '#p1');
    await expect(page.locator('#p1 ik-ipa')).toHaveCount(0);

    const opt = await context.newPage();
    await opt.goto(`chrome-extension://${extId}/options.html#pron`);
    await expect(opt.locator('#phonPreview')).toContainText('/ˈtɛrəf/');
    await toggle(opt, '#showPhonetic', true);
    expect((await getStorage(sw, ['showPhonetic'])).showPhonetic).toBe(true);

    await page.bringToFront();
    const tariff = page.locator('#p1 ik-a[data-l="tariff"]');
    await expect(tariff.locator('rt ik-ipa')).toHaveText('/ˈtɛrəfs/'); // 按所见词形 tariffs 发音
    await expect(tariff.locator('rt ik-t')).toHaveText('关税');
    await expect(tariff).toHaveClass(/ik-ph/);
    // 同一行相邻的宽注释互不重叠
    await page.waitForTimeout(200);
    const overlaps = await page.evaluate(() => {
      const bad = [];
      for (const p of document.querySelectorAll('article p')) {
        const rs = [...p.querySelectorAll('ik-a.ik-ph rt')].map((r) => r.getBoundingClientRect());
        for (let i = 0; i + 1 < rs.length; i++) {
          if (Math.abs(rs[i].top - rs[i + 1].top) < 2 && rs[i].right > rs[i + 1].left + 0.5) bad.push(p.id);
        }
      }
      return bad;
    });
    expect(overlaps).toEqual([]);
    // 第二次出现只加下划线，不带音标
    await expect(page.locator('#p2 ik-a[data-l="tariff"]').nth(1).locator('ik-ipa')).toHaveCount(0);

    const copied = await page.evaluate(() => {
      const r = document.createRange();
      r.selectNodeContents(document.getElementById('p1'));
      getSelection().removeAllRanges();
      getSelection().addRange(r);
      const dt = new DataTransfer();
      document.dispatchEvent(new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true }));
      return dt.getData('text/plain');
    });
    expect(copied).not.toContain('ˈ');
    expect(copied).not.toContain('关税');

    await setStorage(sw, { displayMode: 'paren' });
    await expect(tariff.locator('ik-g')).toHaveText('（/ˈtɛrəfs/ 关税）');
    await setStorage(sw, { displayMode: 'underline' });
    await expect(page.locator('#p1 ik-ipa')).toHaveCount(0);

    await setStorage(sw, { displayMode: 'ruby' });
    await toggle(opt, '#showPhonetic', false);
    await expect(page.locator('#p1 ik-a.ik-gloss').first()).toBeVisible();
    await expect(page.locator('#p1 ik-ipa')).toHaveCount(0);
  });

  test('词卡显示美式音标；打开词卡自动朗读，使用设置的语速', async ({ context, mock, extId, sw }) => {
    const opt = await context.newPage();
    await opt.goto(`chrome-extension://${extId}/options.html#pron`);
    await toggle(opt, '#autoSpeak', true);
    await opt.locator('#speechRate').fill('1.2');
    await opt.locator('#speechRate').dispatchEvent('change');
    await expect(opt.locator('#rateVal')).toHaveText('1.20×');
    await expect(opt.locator('#speechVoice option').first()).toHaveText('自动（优先美式英语）');
    expect(await getStorage(sw, ['autoSpeak', 'speechRate'])).toEqual({ autoSpeak: true, speechRate: 1.2 });

    const page = await context.newPage();
    await page.goto(mock.page('article.html'));
    await waitAnnotated(page, '#p1');
    await page.locator('#p1 ik-a[data-l="stagnation"]').click();
    const card = cardLocator(page);
    await expect(card.locator('.ph')).toHaveText('美/stæɡˈneɪʃən/');
    await expect(card).toHaveAttribute('data-speaking', 'stagnation'); // 没点 🔊 也朗读了
    await expect(card).toHaveAttribute('data-rate', '1.2');

    await setStorage(sw, { autoSpeak: false });
    await page.keyboard.press('Escape');
    await page.evaluate(() => document.querySelector('inkling-ui').shadowRoot.querySelector('.card').removeAttribute('data-speaking'));
    await page.locator('#p1 ik-a[data-l="tariff"]').click();
    await expect(card.locator('.word')).toHaveText('tariffs');
    await page.waitForTimeout(300);
    expect(await card.getAttribute('data-speaking')).toBeNull();
  });
});

test.describe('释义颜色', () => {
  const rtColor = (page, sel) => page.$eval(sel, (el) => getComputedStyle(el).color);

  test('默认黑色；设置页改颜色后页面立即生效，音标颜色不受影响', async ({ context, mock, extId, sw }) => {
    const page = await context.newPage();
    await page.goto(mock.page('article.html'));
    await waitAnnotated(page, '#p1');
    const rt = '#p1 ik-a[data-l="tariff"] rt';
    expect(await rtColor(page, rt)).toBe('rgb(0, 0, 0)');

    const opt = await context.newPage();
    await opt.goto(`chrome-extension://${extId}/options.html`);
    await expect(opt.locator('.swatch[aria-checked="true"]')).toHaveAttribute('title', '黑色');
    await opt.getByRole('radio', { name: '蓝色' }).click();
    await expect(opt.locator('#glossHex')).toHaveText('#1a5fb4');
    expect(await opt.$eval('#glossPreview rt', (el) => getComputedStyle(el).color)).toBe('rgb(26, 95, 180)');
    expect((await getStorage(sw, ['glossColor'])).glossColor).toBe('#1a5fb4');

    await expect.poll(() => rtColor(page, rt)).toBe('rgb(26, 95, 180)');

    // 自定义颜色
    await opt.locator('#glossColor').evaluate((el) => { el.value = '#aa3377'; el.dispatchEvent(new Event('change')); });
    await expect.poll(() => rtColor(page, rt)).toBe('rgb(170, 51, 119)');
    await expect(opt.locator('.swatch[aria-checked="true"]')).toHaveCount(0);

    // 括注模式同样生效；音标保持自己的颜色
    await setStorage(sw, { displayMode: 'paren', showPhonetic: true });
    await expect(page.locator('#p1 ik-a[data-l="tariff"] ik-ipa')).toBeVisible();
    expect(await rtColor(page, '#p1 ik-a[data-l="tariff"] ik-g')).toBe('rgb(170, 51, 119)');
    expect(await rtColor(page, '#p1 ik-a[data-l="tariff"] ik-ipa')).not.toBe('rgb(170, 51, 119)');
  });

  test('深色背景网页上，看不清的颜色（默认黑色）自动换成浅灰', async ({ context, mock, sw }) => {
    const page = await context.newPage();
    await page.goto(mock.page('dark.html'));
    await waitAnnotated(page, '#d1');
    expect(await rtColor(page, '#d1 rt')).toBe('rgb(232, 232, 232)');
    await setStorage(sw, { glossColor: '#f0a46a' }); // 浅色在深色网页上照常使用
    await expect.poll(() => rtColor(page, '#d1 rt')).toBe('rgb(240, 164, 106)');
  });
});
