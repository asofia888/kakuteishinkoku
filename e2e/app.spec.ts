import { expect, Page, test } from '@playwright/test';

/**
 * 主要動線のスモークテスト:
 * サンプルデータ読込 → ダッシュボード → 取引一覧 → 帳簿(貸借一致) →
 * 固定資産台帳 → 請求書(未回収) → 転記ガイド → 所得税シミュレーション。
 * 本番ビルド(静的エクスポート)に対して実行する。
 * ※ ローカル実行にはブラウザの依存ライブラリが必要:
 *   sudo npx playwright install-deps chromium
 */

/** サイドバーのナビゲーションから遷移する(本文中の同名リンクと区別するため) */
async function nav(page: Page, label: RegExp) {
  await page.locator('aside').getByRole('link', { name: label }).click();
}

test.beforeEach(async ({ page }) => {
  // confirm / alert はすべて受け入れる(サンプル読込の確認など)
  page.on('dialog', (dialog) => void dialog.accept());
});

test('サンプルデータで全ページの主要機能が動く', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'サンプルデータを読み込む' }).first().click();

  // ダッシュボード: 集計・月次推移・未回収アラート
  await expect(page.getByText('売上(収入)金額 年間合計').first()).toBeVisible();
  await expect(page.getByText(/月次推移/).first()).toBeVisible();
  await expect(page.getByText(/未回収の請求書が1件/).first()).toBeVisible();

  // 取引一覧: デモ取引が並ぶ
  await nav(page, /取引一覧/);
  await expect(page.getByText('AMAZON.CO.JP').first()).toBeVisible();

  // 帳簿: 複式簿記の検算が通っている
  await nav(page, /帳簿・決算書/);
  await expect(page.getByText('✓ 貸借一致').first()).toBeVisible();

  // 固定資産台帳: 償却費が自動計算されている
  await nav(page, /固定資産台帳/);
  await expect(page.getByText('ノートPC(MacBook Pro)').first()).toBeVisible();

  // 請求書: 売掛中(未回収)の状態表示
  await nav(page, /請求書発行/);
  await expect(page.getByText(/売掛中(未回収)|期限超過/).first()).toBeVisible();

  // 転記ガイド: 決算書の欄が並ぶ
  await nav(page, /転記ガイド/);
  await expect(page.getByText('① 売上(収入)金額').first()).toBeVisible();
  await expect(page.getByText('青色申告特別控除前の所得金額').first()).toBeVisible();

  // 所得税シミュレーション: 納付見込みが計算される
  await nav(page, /所得税シミュレーション/);
  await expect(page.getByText(/納付見込み|還付見込み/).first()).toBeVisible();
});

test('データはリロード後も保持される(localStorage永続化)', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'サンプルデータを読み込む' }).first().click();
  await expect(page.getByText('売上(収入)金額 年間合計').first()).toBeVisible();

  await page.reload();
  await expect(page.getByText('売上(収入)金額 年間合計').first()).toBeVisible();
  await expect(page.getByText(/月次推移/).first()).toBeVisible();
});
