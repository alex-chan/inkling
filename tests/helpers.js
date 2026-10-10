// Playwright 夹具：加载扩展的持久化上下文 + mock 服务器
import { test as base, expect, chromium } from '@playwright/test';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startMockServer, GOOD_KEY } from './mock-server.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const EXT = path.resolve(here, '..', 'extension');
export const MOCK_PORT = 18080;

export const test = base.extend({
  // eslint-disable-next-line no-empty-pattern
  mock: [async ({}, use) => {
    const m = await startMockServer(MOCK_PORT);
    await use({
      ...m,
      log: () => fetch(`${m.base}/__log`).then((r) => r.json()),
      control: (c) => fetch(`${m.base}/__control`, { method: 'POST', body: JSON.stringify(c) }).then((r) => r.json()),
      expire: () => fetch(`${m.base}/__expire`, { method: 'POST' }),
      page: (name) => `${m.base}/pages/${name}`,
    });
    await m.close();
  }, { scope: 'test' }],

  context: async ({ mock }, use) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inkling-pw-'));
    const context = await chromium.launchPersistentContext(dir, {
      channel: 'chromium',
      headless: !process.env.HEADED,
      viewport: { width: 1200, height: 900 },
      args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
    });
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker');
    // 指向 mock 服务器的开发配置
    await sw.evaluate(async (base) => {
      await chrome.storage.local.set({
        devConfig: { authBase: base, issuer: base, apiBase: `${base}/v1`, noWelcome: true },
      });
    }, mock.base);
    // 关掉首次安装打开的设置页
    for (const p of context.pages()) if (p.url().includes('options.html')) await p.close();
    await use(context);
    await context.close();
    fs.rmSync(dir, { recursive: true, force: true });
  },

  sw: async ({ context }, use) => {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker');
    await use(sw);
  },

  extId: async ({ sw }, use) => {
    await use(new URL(sw.url()).host);
  },
});

export { expect, GOOD_KEY };

export async function setStorage(sw, obj) {
  await sw.evaluate((o) => chrome.storage.local.set(o), obj);
}
export async function getStorage(sw, keys) {
  return sw.evaluate((k) => chrome.storage.local.get(k), keys);
}

// 等待某段落注释完成
export async function waitAnnotated(page, sel) {
  await page.waitForFunction((s) => document.querySelector(s)?.querySelector('ik-a'), sel);
}

export async function annotatedWords(page, sel) {
  return page.$$eval(`${sel} ik-a`, (els) => els.map((e) => e.dataset.w));
}

export function cardLocator(page) {
  return page.locator('inkling-ui .card');
}
