import { test, expect, annotatedWords } from './helpers.js';

test('Reuters 式结构：div 段落、行内 span/链接、页眉横幅与署名', async ({ context, mock }) => {
  const page = await context.newPage();
  await page.goto(mock.page('reuters-like.html'));
  await page.waitForSelector('[data-testid="paragraph-0"] ik-a');
  const p0 = await annotatedWords(page, '[data-testid="paragraph-0"]');
  expect(p0).toEqual(expect.arrayContaining(['embargo', 'scrutiny', "cartel's", 'opaque']));
  expect(p0).not.toContain('LONDON');
  expect(p0).not.toContain('Reuters');
  const p1 = await annotatedWords(page, '[data-testid="paragraph-1"]');
  expect(p1).toEqual(expect.arrayContaining(['volatility', 'exacerbate', 'stagnation']));
  expect(p1).not.toContain('Trump');
  for (const sel of ['[role="banner"]', '.byline', 'footer']) expect(await page.locator(`${sel} ik-a`).count(), sel).toBe(0);
  // 同一个块里，跨 span 的词只在首次出现时显示释义
  await expect(page.locator('[data-testid="paragraph-0"] ik-a.ik-gloss')).toHaveCount(p0.length);
});

test('NYT 式结构：正文 p、页眉 nav、Mr. 前缀人名、句首生词', async ({ context, mock }) => {
  const page = await context.newPage();
  await page.goto(mock.page('nyt-like.html'));
  await page.waitForSelector('#n1 ik-a');
  const n1 = await annotatedWords(page, '#n1');
  expect(n1).toEqual(expect.arrayContaining(['perfunctory', 'rejoinder', 'ubiquitous']));
  for (const w of ['WASHINGTON', 'Beijing', 'Trump', 'Mr']) expect(n1).not.toContain(w);
  const n2 = await annotatedWords(page, '#n2');
  expect(n2).toEqual(expect.arrayContaining(['Stagnation', 'embargo', 'exacerbate']));
  expect(await page.locator('nav ik-a, footer ik-a').count()).toBe(0);
  // 文章内 header 里的标题照常处理
  expect(await annotatedWords(page, 'h1')).toEqual(expect.arrayContaining(['Perfunctory', 'Belated']));
});
