import { describe, expect, it } from 'vitest';
import {
  buildInvoiceTransactions,
  computeInvoiceTotals,
  suggestInvoiceNumber,
  withholdingAmount,
} from './invoice';
import { Invoice, InvoiceItem } from './types';

let seq = 0;
function item(over: Partial<InvoiceItem>): InvoiceItem {
  seq++;
  return { id: `i${seq}`, description: '作業', quantity: 1, unitPrice: 10000, taxRate: 10, ...over };
}

function invoice(over: Partial<Invoice>): Invoice {
  seq++;
  return {
    id: `inv${seq}`,
    number: '2026-001',
    issueDate: '2026-12-31',
    dueDate: '2027-01-31',
    client: '株式会社ABC',
    clientSuffix: '御中',
    title: '12月分 業務委託',
    items: [item({ unitPrice: 200000 })],
    taxIncluded: false,
    withholding: false,
    notes: '',
    createdAt: seq,
    ...over,
  };
}

describe('computeInvoiceTotals: 税抜単価(標準)', () => {
  it('税率ごとに合算してから1回だけ端数処理する(インボイスの要件)', () => {
    // 333円×3行 = 999円。行ごとに税を丸めると 33×3=99円だが、正しくは floor(999×0.1)=99…
    // 端数が出る例: 335円×3行 = 1005円 → 税100円(行ごとなら 33×3=99円)
    const t = computeInvoiceTotals({
      items: [
        item({ unitPrice: 335 }),
        item({ unitPrice: 335 }),
        item({ unitPrice: 335 }),
      ],
      taxIncluded: false,
      withholding: false,
    });
    expect(t.subtotal).toBe(1005);
    expect(t.taxTotal).toBe(100); // floor(1005 × 10%)。行ごと丸め(99円)とは異なる
    expect(t.grossTotal).toBe(1105);
  });

  it('10%・軽減8%・対象外を区分して集計する', () => {
    const t = computeInvoiceTotals({
      items: [
        item({ unitPrice: 100000, taxRate: 10 }),
        item({ unitPrice: 50000, taxRate: 8 }),
        item({ unitPrice: 3000, taxRate: 0 }), // 立替交通費など
      ],
      taxIncluded: false,
      withholding: false,
    });
    expect(t.rates).toEqual([
      { rate: 10, base: 100000, tax: 10000, gross: 110000 },
      { rate: 8, base: 50000, tax: 4000, gross: 54000 },
      { rate: 0, base: 3000, tax: 0, gross: 3000 },
    ]);
    expect(t.grossTotal).toBe(167000);
  });

  it('数量に小数を使える(1.5時間 × 単価)', () => {
    const t = computeInvoiceTotals({
      items: [item({ quantity: 1.5, unitPrice: 5000 })],
      taxIncluded: false,
      withholding: false,
    });
    expect(t.subtotal).toBe(7500);
  });
});

describe('computeInvoiceTotals: 税込単価', () => {
  it('税込合計から税額を割り戻す', () => {
    const t = computeInvoiceTotals({
      items: [item({ unitPrice: 220000 })],
      taxIncluded: true,
      withholding: false,
    });
    expect(t.grossTotal).toBe(220000);
    expect(t.taxTotal).toBe(20000);
    expect(t.subtotal).toBe(200000);
  });
});

describe('源泉徴収', () => {
  it('100万円以下は10.21%・超える部分は20.42%(切り捨て)', () => {
    expect(withholdingAmount(100000)).toBe(10210);
    expect(withholdingAmount(1_000_000)).toBe(102_100);
    // 150万円: 102,100 + 500,000×20.42% = 102,100 + 102,100 = 204,200
    expect(withholdingAmount(1_500_000)).toBe(204_200);
    expect(withholdingAmount(0)).toBe(0);
  });

  it('請求額 = 税込合計 − 源泉徴収(源泉は税抜報酬額ベース)', () => {
    const t = computeInvoiceTotals({
      items: [item({ unitPrice: 200000 })],
      taxIncluded: false,
      withholding: true,
    });
    expect(t.withholdingTax).toBe(20420); // 200,000 × 10.21%
    expect(t.billedAmount).toBe(220000 - 20420);
  });
});

describe('suggestInvoiceNumber: 自動採番', () => {
  it('同じ年の最大連番+1を提案する(年が変わればリセット)', () => {
    const invoices = [
      invoice({ number: '2026-001' }),
      invoice({ number: '2026-007' }),
      invoice({ number: '2025-099' }),
      invoice({ number: '自由形式' }), // 形式外は無視
    ];
    expect(suggestInvoiceNumber(invoices, '2026-12-31')).toBe('2026-008');
    expect(suggestInvoiceNumber(invoices, '2027-01-05')).toBe('2027-001');
    expect(suggestInvoiceNumber([], '2026-06-01')).toBe('2026-001');
  });
});

describe('buildInvoiceTransactions: 売掛金計上', () => {
  it('税率ごとの売上(売掛金)と源泉の事業主貸を生成する', () => {
    const drafts = buildInvoiceTransactions(
      invoice({
        items: [item({ unitPrice: 200000, taxRate: 10 }), item({ unitPrice: 50000, taxRate: 8 })],
        withholding: true,
      }),
    );
    expect(drafts).toHaveLength(3);
    // 10%分: 税込220,000の売上
    expect(drafts[0]).toMatchObject({
      type: 'income',
      account: 'sales',
      fund: 'receivable',
      amount: 220000,
      taxCategory: 'taxable10',
      date: '2026-12-31',
    });
    // 軽減8%分: 税込54,000
    expect(drafts[1]).toMatchObject({ amount: 54000, taxCategory: 'taxable8' });
    // 源泉: 250,000 × 10.21% = 25,525 を事業主貸(対象外)として売掛金から差し引く
    expect(drafts[2]).toMatchObject({
      type: 'expense',
      account: 'excluded',
      fund: 'receivable',
      amount: 25525,
    });
    // 売掛金の純増 = 220,000 + 54,000 − 25,525 = 入金予定額
    const receivable = 220000 + 54000 - 25525;
    expect(receivable).toBe(248475);
  });

  it('発行日が不正なら生成しない', () => {
    expect(buildInvoiceTransactions(invoice({ issueDate: '' }))).toEqual([]);
  });
});
