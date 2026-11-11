import { readFile, writeFile } from 'node:fs/promises';
import { expect, Page, test } from '@playwright/test';
import { foreignZip, ForeignZipEntry } from '../lib/testing/foreignZip';
import { openZip } from '../lib/zip';

/**
 * データの出入りと保全にかかわる動線のE2E:
 * CSV取込 → プレビュー → 一覧反映 / バックアップDL → 全削除 → 復元(証憑つきの ZIP・圧縮し直した ZIP も) /
 * 印刷CSS(帳簿が白紙にならない) / 証憑のサイズ超過警告。
 * 本番ビルド(basePath 付き含む)に対して実行する。
 */

/**
 * サイドバーのナビゲーションから遷移する(本文中の同名リンクと区別するため)。
 * 遷移先のリンクが選択中(青)になるまで待つ。待たずに次の操作をすると、読み込み中の
 * 前のページの要素(ダッシュボードの非表示のファイル入力など)を操作してしまうことがある
 */
async function nav(page: Page, label: RegExp) {
  const link = page.locator('aside').getByRole('link', { name: label });
  await link.click();
  await expect(link).toHaveClass(/bg-blue-600/);
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
  // 取引一覧のCSV入力を ID で指定する。汎用の input[type="file"] だと、ページ遷移の読み込み中に
  // ダッシュボードのバックアップ復元用の入力(非表示)を拾い、CSVが復元に渡って失敗することがある
  await page
    .locator('#tx-csv-file')
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

/** 端末(IndexedDB)に保存されている証憑の件数 */
function storedReceiptCount(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const open = indexedDB.open('shinkoku-snap-files');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const req = db.transaction('files').objectStore('files').count();
          req.onerror = () => reject(req.error);
          req.onsuccess = () => {
            db.close();
            resolve(req.result);
          };
        };
      }),
  );
}

const RECEIPT = Buffer.from('%PDF-1.4 e2e receipt');

/** サンプルデータの取引に証憑を1件添付し、バックアップ(ZIP)をダウンロードする。保存先のパスを返す */
async function downloadBackupWithReceipt(page: Page): Promise<string> {
  await page.goto('./');
  await page.getByRole('button', { name: 'サンプルデータを読み込む' }).first().click();
  await expect(page.getByText('売上(収入)金額 年間合計').first()).toBeVisible();

  // 取引に証憑を添付する
  await nav(page, /取引一覧/);
  const modal = page.locator('.fixed.inset-0');
  await page.getByTitle('証憑(領収書・請求書PDF)を添付・表示').first().click();
  await modal
    .locator('input[type="file"]')
    .setInputFiles({ name: 'receipt-e2e.pdf', mimeType: 'application/pdf', buffer: RECEIPT });
  await expect(modal.getByRole('button', { name: 'receipt-e2e.pdf' })).toBeVisible();
  await modal.getByRole('button', { name: '閉じる' }).click();

  // 証憑があるときのバックアップは ZIP(証憑を JSON に埋め込まない)
  await nav(page, /ダッシュボード/);
  await expect(page.getByText(/証憑ファイル: 1件/)).toBeVisible();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: /バックアップをダウンロード/ }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.zip$/);
  return download.path();
}

/** 全削除 → 帳簿だけでなく証憑も端末から消える(回帰: 以前は証憑が残り、消す手段もなかった) */
async function deleteAllData(page: Page) {
  await page.getByRole('button', { name: '全データを削除' }).click();
  await expect(page.getByRole('button', { name: 'サンプルデータを読み込む' }).first()).toBeVisible();
  await expect.poll(() => storedReceiptCount(page)).toBe(0);
}

/** バックアップから復元し、帳簿と証憑(同じ取引に、同じ中身のまま)が戻ったことを確かめる */
async function restoreAndExpectReceipt(page: Page, backupFile: string) {
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('button', { name: /バックアップから復元/ }).first().click(),
  ]);
  await chooser.setFiles(backupFile);
  await expect(page.getByText('売上(収入)金額 年間合計').first()).toBeVisible();
  await expect(page.getByText(/証憑ファイル: 1件/)).toBeVisible();

  await nav(page, /取引一覧/);
  await page.getByTitle('証憑(領収書・請求書PDF)を添付・表示').first().click();
  await expect(page.locator('.fixed.inset-0').getByRole('button', { name: 'receipt-e2e.pdf' })).toBeVisible();
  const restored = await page.evaluate(
    () =>
      new Promise<{ type: string; text: string }>((resolve, reject) => {
        const open = indexedDB.open('shinkoku-snap-files');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const req = open.result.transaction('files').objectStore('files').getAll();
          req.onerror = () => reject(req.error);
          req.onsuccess = () => {
            const blob = (req.result[0] as { blob: Blob }).blob;
            void blob.text().then((text) => resolve({ type: blob.type, text }));
          };
        };
      }),
  );
  expect(restored).toEqual({ type: 'application/pdf', text: RECEIPT.toString() });
}

test('証憑つきバックアップ: ZIP でダウンロード → 全削除で証憑も消える → ZIP から復元で証憑が戻る', async ({ page }) => {
  const backupFile = await downloadBackupWithReceipt(page);
  await deleteAllData(page);
  // ZIP をそのまま指定して復元
  await restoreAndExpectReceipt(page, backupFile);
});

test('証憑つきバックアップ: 展開してから圧縮し直した ZIP からも復元できる', async ({ page }, testInfo) => {
  const backupFile = await downloadBackupWithReceipt(page);

  // Mac の Safari はダウンロードした ZIP を自動で展開する。展開後のフォルダを OS の機能で
  // 圧縮し直した ZIP(フォルダ入り・Deflate 圧縮・濁点が分かれたファイル名)を再現する
  const original = await openZip(new Blob([new Uint8Array(await readFile(backupFile))]));
  expect(original.map((e) => e.path)).toContain('backup.json');
  const entries: ForeignZipEntry[] = [];
  for (const e of original) {
    entries.push({
      path: `申告スナップ_バックアップ/${e.path}`.normalize('NFD'),
      data: new Uint8Array(await (await e.blob()).arrayBuffer()),
    });
  }
  const rezipped = testInfo.outputPath('rezipped.zip');
  await writeFile(rezipped, new Uint8Array(await foreignZip(entries, { descriptor: true }).arrayBuffer()));

  await deleteAllData(page);
  await restoreAndExpectReceipt(page, rezipped);
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

test('旧版(localStorage)の帳簿データは IndexedDB へ移行され、localStorage から消える', async ({ page }) => {
  const year = new Date().getFullYear();
  const legacy = {
    transactions: [
      {
        id: 'legacy-1',
        date: `${year}-04-10`,
        amount: 123456,
        description: '移行テストの売上',
        type: 'income',
        account: 'sales',
        approved: true,
        anbunApplied: false,
        businessAmount: 123456,
        source: 'manual',
        createdAt: 1,
        fund: 'bank',
      },
    ],
    rules: [],
    anbunSettings: [],
  };
  // v3.10.0 以前と同じく localStorage に保存された状態から起動する(最初の読込の前に1回だけ置く)
  await page.addInitScript((json) => {
    if (sessionStorage.getItem('legacy-seeded')) return;
    localStorage.setItem('shinkoku-snap:v2', json);
    sessionStorage.setItem('legacy-seeded', '1');
  }, JSON.stringify(legacy));

  await page.goto('./');
  await nav(page, /取引一覧/);
  await expect(page.getByText('移行テストの売上').first()).toBeVisible();
  // 移行が終わると localStorage の旧データは消え、再読込後も IndexedDB から読める
  await expect.poll(() => page.evaluate(() => localStorage.getItem('shinkoku-snap:v2'))).toBeNull();
  await page.reload();
  await expect(page.getByText('移行テストの売上').first()).toBeVisible();
});
