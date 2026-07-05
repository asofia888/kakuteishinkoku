import { expect, Page, test } from '@playwright/test';

/**
 * データの出入りと保全にかかわる動線のE2E:
 * CSV取込 → プレビュー → 一覧反映 / バックアップDL → 全削除 → 復元 /
 * 印刷CSS(帳簿が白紙にならない) / 証憑のサイズ超過警告。
 * 本番ビルド(basePath 付き含む)に対して実行する。
 */

/** サイドバーのナビゲーションから遷移する(本文中の同名リンクと区別するため) */
async function nav(page: Page, label: RegExp) {
  await page.locator('aside').getByRole('link', { name: label }).click();
}

test.beforeEach(async ({ page }) => {
  // confirm / alert はすべて受け入れる(全データ削除・復元の確認など)
  page.on('dialog', (dialog) => void dialog.accept());
});

test('CSV明細を取り込める(プレビュー → 取込 → 一覧に反映)', async ({ page }) => {
  await page.goto('./');
  await nav(page, /取引一覧/);

  const csv = [
    '日付,金額,摘要',
    '2026/05/10,-3300,AMAZONテスト購入',
    '2026/05/15,220000,振込 テストクライアント',
  ].join('\r\n');
  await page
    .locator('input[type="file"]')
    .first()
    .setInputFiles({ name: 'bank.csv', mimeType: 'text/csv', buffer: Buffer.from(csv, 'utf-8') });

  // プレビューに2件が並び、取込を確定すると一覧に反映される(括弧の全角/半角には依存しない)
  await expect(page.getByRole('heading', { name: /取込プレビュー.*2\/2件を取込/ })).toBeVisible();
  await page.getByRole('button', { name: 'この内容で取り込む' }).click();
  await expect(page.getByText('AMAZONテスト購入').first()).toBeVisible();
  await expect(page.getByText('振込 テストクライアント').first()).toBeVisible();
});

test('バックアップをダウンロード → 全削除 → 復元でデータが戻る', async ({ page }) => {
  await page.goto('./');
  await page.getByRole('button', { name: 'サンプルデータを読み込む' }).first().click();
  await expect(page.getByText('売上(収入)金額 年間合計').first()).toBeVisible();

  // ダウンロード(実ファイルとして保存されることまで確認)
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: /バックアップをダウンロード/ }).click(),
  ]);
  const backupFile = await download.path();
  expect(backupFile).toBeTruthy();

  // 全削除(confirm は自動承認)→ 空の状態に戻る
  await page.getByRole('button', { name: '全データを削除' }).click();
  await expect(page.getByRole('button', { name: 'サンプルデータを読み込む' }).first()).toBeVisible();

  // 復元 → 集計が戻る
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('button', { name: /バックアップから復元/ }).first().click(),
  ]);
  await chooser.setFiles(backupFile);
  await expect(page.getByText('売上(収入)金額 年間合計').first()).toBeVisible();
  await expect(page.getByText(/月次推移/).first()).toBeVisible();
});

test('印刷: 帳簿ページは白紙にならず、請求書プレビューでは請求書だけが印刷される', async ({ page }) => {
  await page.goto('./');
  await page.getByRole('button', { name: 'サンプルデータを読み込む' }).first().click();
  await expect(page.getByText('売上(収入)金額 年間合計').first()).toBeVisible();

  // 帳簿・決算書: 印刷メディアでも本文が可視(回帰: 印刷用CSSが全ページを白紙にしていた)
  await nav(page, /帳簿・決算書/);
  await expect(page.getByText('✓ 貸借一致').first()).toBeVisible();
  await page.emulateMedia({ media: 'print' });
  expect(
    await page.evaluate(() => {
      const el = document.querySelector('main table, main h2');
      return el ? getComputedStyle(el).visibility : 'missing';
    }),
  ).toBe('visible');
  await page.emulateMedia({ media: null });

  // 請求書プレビュー: 印刷時は請求書シートのみ可視・サイドバー等は不可視
  await nav(page, /請求書発行/);
  await page.getByRole('button', { name: '表示・印刷' }).first().click();
  await expect(page.locator('.invoice-sheet').first()).toBeVisible();
  await page.emulateMedia({ media: 'print' });
  expect(
    await page.evaluate(() => getComputedStyle(document.querySelector('.invoice-sheet')!).visibility),
  ).toBe('visible');
  expect(
    await page.evaluate(() => getComputedStyle(document.querySelector('aside')!).visibility),
  ).toBe('hidden');
});

test('証憑: 10MBを超えるファイルは保存されず、警告が表示される', async ({ page }) => {
  await page.goto('./');
  await page.getByRole('button', { name: 'サンプルデータを読み込む' }).first().click();
  await expect(page.getByText('売上(収入)金額 年間合計').first()).toBeVisible();

  await nav(page, /取引一覧/);
  await page.getByTitle('証憑(領収書・請求書PDF)を添付・表示').first().click();
  await expect(page.getByRole('heading', { name: '証憑の添付' })).toBeVisible();

  // 10MB+1バイトのダミーPDFを添付 → 保存されず警告(回帰: 以前は黙ってスキップ)
  const modal = page.locator('.fixed.inset-0');
  await modal.locator('input[type="file"]').setInputFiles({
    name: 'huge-receipt.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.alloc(10 * 1024 * 1024 + 1),
  });
  await expect(page.getByText(/10MBを超えるため保存しませんでした/).first()).toBeVisible();
  // ファイル名は警告文の中の1回だけ = 証憑一覧には保存されていない
  await expect(page.getByText('huge-receipt.pdf')).toHaveCount(1);
});
