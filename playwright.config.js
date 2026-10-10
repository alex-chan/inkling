import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests',
  testMatch: /.*\.spec\.js/,
  timeout: 60_000,
  expect: { timeout: 8_000 },
  workers: 1,          // 共用 mock 服务器端口与回调端口
  fullyParallel: false,
  reporter: [['list']],
  use: { trace: 'retain-on-failure' },
});
