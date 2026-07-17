import { describe, expect, it } from 'vitest';
import {
  buildBackupJson,
  isNewerBackup,
  parseBackupFilesJson,
  parseBackupJson,
  sanitizeAppData,
} from './backup';
import { PortableFile } from './files';
import { AppData, DEFAULT_ISSUER, DEFAULT_TAX_SETTINGS, Transaction } from './types';

const goodTx: Transaction = {
  id: 'tx-1',
  date: '2026-01-25',
  amount: 320000,
  description: '振込 カブシキガイシャABC',
  type: 'income',
  account: 'sales',
  approved: true,
  anbunApplied: false,
  businessAmount: 320000,
  source: 'csv',
  createdAt: 1000,
  fund: 'bank',
};

/** 給与機能が起票する源泉預りの取引(貸方が預り金になる) */
const depositTx: Transaction = {
  id: 'tx-dep-1',
  date: '2026-01-31',
  amount: 10210,
  description: '給与 佐藤(1月分) 源泉所得税(預り)',
  type: 'expense',
  account: 'salaries',
  approved: true,
  anbunApplied: false,
  businessAmount: 10210,
  source: 'manual',
  createdAt: 1100,
  fund: 'deposit',
};

const goodData: AppData = {
  transactions: [goodTx, depositTx],
  rules: [{ id: 'r1', keyword: 'amazon', account: 'supplies' }],
  anbunSettings: [{ id: 's1', account: 'rent', type: 'fixed', value: 30000 }],
  openingBalances: [{ year: 2026, cash: 50000, bank: 800000, receivable: 0, card: 0, payable: 0, deposit: 0 }],
  taxSettings: { taxable: true, method: 'special20', simplifiedType: 5 },
  invoices: [
    {
      id: 'inv-1',
      number: '2026-001',
      issueDate: '2026-12-31',
      dueDate: '2027-01-31',
      client: '株式会社ABC',
      clientSuffix: '御中',
      title: '12月分 業務委託',
      items: [{ id: 'it-1', description: 'デザイン制作', quantity: 1, unitPrice: 200000, taxRate: 10 }],
      taxIncluded: false,
      withholding: true,
      notes: '',
      createdAt: 2000,
    },
  ],
  issuer: { ...DEFAULT_ISSUER, name: '山田 太郎', invoiceRegNumber: 'T1234567890123' },
  assets: [
    {
      id: 'as-1',
      name: 'ノートPC',
      acquiredDate: '2025-07-10',
      cost: 240000,
      method: 'straight',
      usefulLife: 4,
      businessRatio: 100,
      createdAt: 3000,
    },
  ],
  inventories: [{ year: 2026, amount: 120000 }],
  deductions: [],
  payrolls: [],
  partners: [
    { id: 'p1', name: '株式会社ABC', invoiceRegNumber: 'T9999999999999', memo: '', createdAt: 4000 },
  ],
};

describe('バックアップの往復(エクスポート → インポート)', () => {
  it('buildBackupJson の出力を parseBackupJson で完全に復元できる', () => {
    const json = buildBackupJson(goodData);
    expect(parseBackupJson(json)).toEqual(goodData);
  });

  it('localStorage の生データ(AppData形式)も復元できる', () => {
    expect(parseBackupJson(JSON.stringify(goodData))).toEqual(goodData);
  });
});

describe('parseBackupJson: 不正な入力', () => {
  it('JSONでない・形が違うものは null', () => {
    expect(parseBackupJson('こんにちは')).toBeNull();
    expect(parseBackupJson('{}')).toBeNull();
    expect(parseBackupJson('123')).toBeNull();
    expect(parseBackupJson(JSON.stringify({ transactions: '配列でない' }))).toBeNull();
  });
});

describe('parseBackupFilesJson: 証憑の同梱と復元', () => {
  const goodFile: PortableFile = {
    id: 'f-1',
    txId: 'tx-1',
    name: '領収書.pdf',
    type: 'application/pdf',
    size: 5,
    createdAt: 5000,
    data: 'aGVsbG8=', // "hello"
  };

  it('files付きバックアップは帳簿と証憑の両方を往復できる', () => {
    const json = buildBackupJson(goodData, [goodFile]);
    expect(parseBackupJson(json)).toEqual(goodData);
    expect(parseBackupFilesJson(json)).toEqual([goodFile]);
  });

  it('filesキーがない(v6以前・生データ)は null = 端末の証憑に触れない', () => {
    expect(parseBackupFilesJson(buildBackupJson(goodData))).toBeNull();
    expect(parseBackupFilesJson(JSON.stringify(goodData))).toBeNull();
    expect(parseBackupFilesJson('壊れたJSON')).toBeNull();
  });

  it('壊れた証憑(txIdなし・base64不正・上限超過)は捨て、ID重複は最初の1件だけ残す', () => {
    const oversized = 'A'.repeat(Math.ceil((10 * 1024 * 1024 * 4) / 3) + 8);
    const json = buildBackupJson(goodData, [
      goodFile,
      { ...goodFile, id: 'f-1' }, // ID重複 → 捨てる
      { ...goodFile, id: 'f-2', txId: '' }, // 紐づく取引なし → 捨てる
      { ...goodFile, id: 'f-3', data: 'これはbase64ではない' },
      { ...goodFile, id: 'f-4', data: oversized },
    ]);
    expect(parseBackupFilesJson(json)).toEqual([goodFile]);
  });

  it('欠けたメタ情報(名前・種類)は既定値で補う', () => {
    const json = JSON.stringify({
      app: 'shinkoku-snap',
      version: 7,
      data: goodData,
      files: [{ txId: 'tx-1', data: 'aGVsbG8=' }],
    });
    const files = parseBackupFilesJson(json)!;
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      txId: 'tx-1',
      name: '証憑',
      type: 'application/octet-stream',
      data: 'aGVsbG8=',
    });
    expect(files[0].id).not.toBe('');
  });
});

describe('isNewerBackup: バックアップ版数の前方互換チェック', () => {
  const envelope = (version: unknown, app: unknown = 'shinkoku-snap') =>
    JSON.stringify({ app, version, exportedAt: '2026-07-17T00:00:00.000Z', data: {} });

  it('このアプリ自身の出力は新しい版と判定しない', () => {
    expect(isNewerBackup(buildBackupJson(goodData))).toBe(false);
  });

  it('新しい版のバックアップだけを検知する(古い版は対象外)', () => {
    expect(isNewerBackup(envelope(999))).toBe(true);
    expect(isNewerBackup(envelope(1))).toBe(false);
  });

  it('別アプリのJSON・版数のない生データ・壊れたJSONは対象外', () => {
    expect(isNewerBackup(envelope(999, 'other-app'))).toBe(false);
    expect(isNewerBackup(JSON.stringify(goodData))).toBe(false); // localStorage の生データ形式
    expect(isNewerBackup('壊れたJSON')).toBe(false);
  });
});

describe('sanitizeAppData: 壊れた要素の除去と補正', () => {
  it('不正な取引(日付・金額・種別)は捨て、正常な取引だけ残す', () => {
    const data = sanitizeAppData({
      transactions: [
        goodTx,
        { ...goodTx, id: 'bad-1', date: '2026/01/25' }, // 日付形式が違う
        { ...goodTx, id: 'bad-2', amount: -100 }, // 金額が負
        { ...goodTx, id: 'bad-3', amount: 'たくさん' }, // 金額が数値でない
        { ...goodTx, id: 'bad-4', type: 'both' }, // 種別が不正
        'ただの文字列',
      ],
      rules: [],
      anbunSettings: [],
    })!;
    expect(data.transactions).toHaveLength(1);
    expect(data.transactions[0].id).toBe('tx-1');
  });

  it('IDが重複・欠落した取引には新しいIDを振る', () => {
    const data = sanitizeAppData({
      transactions: [goodTx, { ...goodTx }, { ...goodTx, id: undefined }],
      rules: [],
      anbunSettings: [],
    })!;
    expect(data.transactions).toHaveLength(3);
    const ids = data.transactions.map((t) => t.id);
    expect(new Set(ids).size).toBe(3); // 全IDがユニーク
  });

  it('欠けたフィールドは安全な既定値で補う', () => {
    const data = sanitizeAppData({
      transactions: [{ date: '2026-03-01', amount: 1234.6, type: 'expense' }],
      rules: [],
      anbunSettings: [],
    })!;
    const t = data.transactions[0];
    expect(t.amount).toBe(1235); // 整数に丸め
    expect(t.account).toBeNull();
    expect(t.approved).toBe(false);
    expect(t.businessAmount).toBe(1235);
    expect(t.source).toBe('csv');
  });

  it('不正なルール(キーワード空など)は捨てる', () => {
    const data = sanitizeAppData({
      transactions: [],
      rules: [
        { id: 'r1', keyword: ' amazon ', account: 'supplies' }, // trimして残る
        { id: 'r2', keyword: '   ', account: 'supplies' }, // 空 → 捨てる
        { id: 'r3', keyword: 'ガス', account: '' }, // 科目なし → 捨てる
      ],
      anbunSettings: [],
    })!;
    expect(data.rules).toHaveLength(1);
    expect(data.rules[0].keyword).toBe('amazon');
  });

  it('決済手段(fund)がない旧データは普通預金として引き継ぎ、不正値も補正する', () => {
    const data = sanitizeAppData({
      transactions: [
        { ...goodTx, fund: undefined },
        { ...goodTx, id: 'tx-2', fund: 'card' },
        { ...goodTx, id: 'tx-3', fund: 'ビットコイン' },
      ],
      rules: [],
      anbunSettings: [],
    })!;
    expect(data.transactions[0].fund).toBe('bank');
    expect(data.transactions[1].fund).toBe('card');
    expect(data.transactions[2].fund).toBe('bank');
  });

  it('源泉預り(fund: deposit)の取引は補正されず保持される(回帰: 預り金が普通預金に化ける)', () => {
    // 給与機能が起票する「(借)給料賃金 / (貸)預り金」の取引。
    // FUND_IDS に deposit が漏れていると、リロードのたびに fund が bank へ書き換わり
    // 預金残高・預り金残高の両方が狂う(貸借は一致したままなので検算では気づけない)。
    const data = sanitizeAppData({
      transactions: [
        {
          ...goodTx,
          id: 'tx-dep',
          type: 'expense',
          account: 'salaries',
          description: '給与 山田(1月分) 源泉所得税(預り)',
          fund: 'deposit',
        },
        { ...goodTx, id: 'tx-cf', counterFund: 'deposit' },
      ],
      rules: [],
      anbunSettings: [],
    })!;
    expect(data.transactions[0].fund).toBe('deposit');
    expect(data.transactions[1].counterFund).toBe('deposit');
  });

  it('taxCategory と qualifiedInvoice を保持し、不正値は捨てる', () => {
    const data = sanitizeAppData({
      transactions: [
        { ...goodTx, taxCategory: 'exempt', qualifiedInvoice: false },
        { ...goodTx, id: 'tx-2', taxCategory: '10%くらい', qualifiedInvoice: 'たぶん' },
      ],
      rules: [],
      anbunSettings: [],
    })!;
    expect(data.transactions[0].taxCategory).toBe('exempt');
    expect(data.transactions[0].qualifiedInvoice).toBe(false);
    expect(data.transactions[1].taxCategory).toBeUndefined();
    expect(data.transactions[1].qualifiedInvoice).toBeUndefined();
  });

  it('期首残高は年ごとに1件へ検証・補正し、消費税設定の壊れた値は既定に戻す', () => {
    const data = sanitizeAppData({
      transactions: [],
      rules: [],
      anbunSettings: [],
      openingBalances: [
        { year: 2026, cash: -100, bank: 500000.7, receivable: 'たくさん', card: 0, payable: 0 },
        { year: 2026, cash: 0, bank: 1, receivable: 0, card: 0, payable: 0 }, // 同年 → 後勝ち
        { year: '来年' },
      ],
      taxSettings: { taxable: true, method: 'まとめて', simplifiedType: 99 },
    })!;
    expect(data.openingBalances).toHaveLength(1);
    expect(data.openingBalances[0]).toEqual({
      year: 2026,
      cash: 0,
      bank: 1,
      receivable: 0,
      card: 0,
      payable: 0,
      deposit: 0,
    });
    expect(data.taxSettings).toEqual({ ...DEFAULT_TAX_SETTINGS, taxable: true });
  });

  it('期首残高の負値(前年末繰越のマイナス残高)は0化せず保持する(回帰)', () => {
    // 「前年末の残高から自動設定」で入った負の残高が、リロード(sanitize往復)で
    // 0に化けると貸借対照表が前年末と静かに食い違う
    const data = sanitizeAppData({
      transactions: [],
      rules: [],
      anbunSettings: [],
      openingBalances: [
        { year: 2027, cash: -3500, bank: 120000.4, receivable: 0, card: -200, payable: 0, deposit: 0 },
      ],
    })!;
    expect(data.openingBalances[0]).toEqual({
      year: 2027,
      cash: -3500,
      bank: 120000,
      receivable: 0,
      card: -200,
      payable: 0,
      deposit: 0,
    });
  });

  it('請求書は番号必須・不正な明細/日付を補正して引き継ぐ', () => {
    const data = sanitizeAppData({
      transactions: [],
      rules: [],
      anbunSettings: [],
      invoices: [
        {
          id: 'inv-1',
          number: ' 2026-001 ',
          issueDate: '2026/12/31', // 形式不正 → 空にする
          dueDate: '2027-01-31',
          client: '株式会社ABC',
          items: [
            { id: 'it-1', description: '制作', quantity: 2, unitPrice: 5000.4, taxRate: 8 },
            { id: 'it-2', description: '', quantity: -1, unitPrice: 'たくさん', taxRate: 5 },
            'ただの文字列',
          ],
          linkedTxIds: ['tx-1', 123],
        },
        { number: '' }, // 番号なし → 捨てる
      ],
      issuer: { name: '山田', invoiceRegNumber: 12345 },
    })!;
    expect(data.invoices).toHaveLength(1);
    const inv = data.invoices[0];
    expect(inv.number).toBe('2026-001');
    expect(inv.issueDate).toBe('');
    expect(inv.dueDate).toBe('2027-01-31');
    expect(inv.clientSuffix).toBe('御中'); // 既定の敬称
    expect(inv.items).toHaveLength(2);
    expect(inv.items[0]).toMatchObject({ quantity: 2, unitPrice: 5000, taxRate: 8 });
    expect(inv.items[1]).toMatchObject({ quantity: 1, unitPrice: 0, taxRate: 10 }); // 補正
    expect(inv.linkedTxIds).toEqual(['tx-1']);
    expect(data.issuer.name).toBe('山田');
    expect(data.issuer.invoiceRegNumber).toBe(''); // 文字列以外は捨てる
  });

  it('按分設定の根拠メモは trim して残し、空・文字列以外は捨てる', () => {
    const data = sanitizeAppData({
      transactions: [],
      rules: [],
      anbunSettings: [
        { id: 's1', account: 'rent', type: 'fixed', value: 30000, memo: ' 床面積 20㎡/50㎡ ' },
        { id: 's2', account: 'utilities', type: 'percent', value: 40, memo: '   ' },
        { id: 's3', account: 'communication', type: 'percent', value: 60, memo: 12345 },
      ],
    })!;
    expect(data.anbunSettings.find((s) => s.account === 'rent')!.memo).toBe('床面積 20㎡/50㎡');
    expect(data.anbunSettings.find((s) => s.account === 'utilities')!.memo).toBeUndefined();
    expect(data.anbunSettings.find((s) => s.account === 'communication')!.memo).toBeUndefined();
  });

  it('按分設定は科目ごとに1件へ重複排除し、パーセントは100%に丸める', () => {
    const data = sanitizeAppData({
      transactions: [],
      rules: [],
      anbunSettings: [
        { id: 's1', account: 'rent', type: 'fixed', value: 30000 },
        { id: 's2', account: 'rent', type: 'percent', value: 50 }, // 同一科目 → 後勝ち
        { id: 's3', account: 'utilities', type: 'percent', value: 150 }, // → 100に丸め
        { id: 's4', account: 'communication', type: 'percent', value: 0 }, // 0以下 → 捨てる
      ],
    })!;
    expect(data.anbunSettings).toHaveLength(2);
    expect(data.anbunSettings.find((s) => s.account === 'rent')).toMatchObject({
      type: 'percent',
      value: 50,
    });
    expect(data.anbunSettings.find((s) => s.account === 'utilities')!.value).toBe(100);
  });
});
