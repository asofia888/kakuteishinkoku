import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // ユニットテストは lib/ 配下のみ。e2e/ は Playwright が実行する
    include: ['lib/**/*.test.ts'],
  },
});
