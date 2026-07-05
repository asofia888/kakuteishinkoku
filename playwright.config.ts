import { defineConfig } from '@playwright/test';

/**
 * E2Eテスト: 本番ビルド(out/)を軽量サーバで配信して主要動線を検証する。
 * 実行前に `npm run build` が必要(CIではビルド後に実行される)。
 *
 * NEXT_PUBLIC_BASE_PATH(例: /kakuteishinkoku)を設定してビルド・実行すると、
 * GitHub Pages と同じサブパス配信で検証できる(CIでは両方の構成を検証する)。
 */
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    // 末尾スラッシュ必須: 各テストは相対パス(`./` や `./books/`)で遷移することで
    // ルート配信・サブパス配信のどちらでも同じスペックが動く
    baseURL: `http://localhost:4173${basePath}/`,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node scripts/serve-out.mjs',
    port: 4173,
    reuseExistingServer: !process.env.CI,
  },
});
