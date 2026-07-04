import { defineConfig } from '@playwright/test';

/**
 * E2Eテスト: 本番ビルド(out/)を軽量サーバで配信して主要動線を検証する。
 * 実行前に `npm run build` が必要(CIではビルド後に実行される)。
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node scripts/serve-out.mjs',
    port: 4173,
    reuseExistingServer: !process.env.CI,
  },
});
