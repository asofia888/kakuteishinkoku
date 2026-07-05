import { describe, expect, it } from 'vitest';
import {
  defaultTaxCategory,
  effectiveTaxCategory,
  nonQualifiedDeductionRate,
  summarizeTax,
  taxInclusive,
} from './tax';
import { TaxSettings, Transaction } from './types';

let seq = 0;
function tx(over: Partial<Transaction> & Pick<Transaction, 'description' | 'type'>): Transaction {
  seq++;
  const amount = over.amount ?? 11000;
  return {
    id: `t${seq}`,
    date: '2026-06-15',
    amount,
    account: 'supplies',
    approved: true,
    anbunApplied: false,
    businessAmount: over.businessAmount ?? amount,
    source: 'csv',
    createdAt: seq,
    fund: 'bank',
    ...over,
  };
}

const settings: TaxSettings = { taxable: true, method: 'general', simplifiedType: 5 };

describe('税区分の自動判定', () => {
  it('売上は課税10%、租税公課は不課税、保険は非課税が既定になる', () => {
    expect(defaultTaxCategory({ type: 'income', account: 'sales' })).toBe('taxable10');
    expect(defaultTaxCategory({ type: 'expense', account: 'taxes_dues' })).toBe('none');
    expect(defaultTaxCategory({ type: 'expense', account: 'insurance' })).toBe('exempt');
    expect(defaultTaxCategory({ type: 'expense', account: 'supplies' })).toBe('taxable10');
  });

  it('未仕訳・対象外・決済(振替)は不課税・対象外になる', () => {
    expect(defaultTaxCategory({ type: 'expense', account: null })).toBe('none');
    expect(defaultTaxCategory({ type: 'expense', account: 'excluded' })).toBe('none');
    expect(defaultTaxCategory({ type: 'income', account: 'ar_collect' })).toBe('none');
  });

  it('取引に明示された税区分が既定より優先される(住宅家賃の非課税など)', () => {
    const t = tx({ description: '自宅家賃', type: 'expense', account: 'rent', taxCategory: 'exempt' });
    expect(effectiveTaxCategory(t)).toBe('exempt');
  });
});

describe('taxInclusive: 税込金額からの割り戻し', () => {
  it('10%と軽減8%を切り捨てで計算する', () => {
    expect(taxInclusive(11000, 10)).toBe(1000);
    expect(taxInclusive(10800, 8)).toBe(800);
    expect(taxInclusive(999, 10)).toBe(90); // 999×10/110 = 90.8 → 90
  });
});

describe('nonQualifiedDeductionRate: インボイス経過措置', () => {
  it('2026/9まで80%・2029/9まで50%・以降0%', () => {
    expect(nonQualifiedDeductionRate('2026-09-30')).toBe(80);
    expect(nonQualifiedDeductionRate('2026-10-01')).toBe(50);
    expect(nonQualifiedDeductionRate('2029-10-01')).toBe(0);
    expect(nonQualifiedDeductionRate('2023-09-30')).toBe(100);
  });
});

describe('summarizeTax: 年間集計', () => {
  const txs: Transaction[] = [
    tx({ description: '報酬', type: 'income', account: 'sales', amount: 3_300_000 }),
    tx({ description: '非課税の収入', type: 'income', account: 'misc_income', amount: 50_000, taxCategory: 'none' }),
    // 課税仕入: 税込110,000 → 消費税10,000
    tx({ description: '機材', type: 'expense', amount: 110_000 }),
    // 家事按分50%: 課税仕入は事業分の55,000のみ(税5,000)
    tx({ description: '電気', type: 'expense', account: 'utilities', amount: 110_000, businessAmount: 55_000 }),
    // 適格請求書なし(2026年6月 → 経過措置80%): 税10,000のうち8,000のみ控除
    tx({ description: '免税店からの仕入', type: 'expense', amount: 110_000, qualifiedInvoice: false }),
    // 不課税(租税公課)は仕入税額控除に入らない
    tx({ description: '税金', type: 'expense', account: 'taxes_dues', amount: 30_000 }),
    // 対象外・振替は無視される
    tx({ description: '私的', type: 'expense', account: 'excluded', amount: 99_000 }),
    tx({ description: 'カード引落し', type: 'expense', account: 'card_payment', amount: 88_000 }),
  ];

  it('売上・仕入・控除・納付額(3方式)を正しく計算する', () => {
    const s = summarizeTax(txs, 2026, settings);
    expect(s.sales10).toBe(3_300_000);
    expect(s.salesTax).toBe(300_000);
    expect(s.salesOther).toBe(50_000);
    // 課税仕入: 110,000 + 55,000 + 110,000
    expect(s.purchase10).toBe(275_000);
    expect(s.purchaseTax).toBe(25_000);
    // 控除: 適格 10,000 + 5,000 + 適格なし 10,000×80% = 23,000
    expect(s.deductibleTax).toBe(23_000);
    expect(s.nonQualifiedCount).toBe(1);
    expect(s.nonQualifiedLostTax).toBe(2_000);
    // 本則: 300,000 - 23,000
    expect(s.payGeneral).toBe(277_000);
    // 簡易(第5種50%): 300,000 - 150,000
    expect(s.paySimplified).toBe(150_000);
    // 2割特例: 300,000 × 20%
    expect(s.paySpecial20).toBe(60_000);
    expect(s.paySelected).toBe(277_000); // method: general
  });

  it('軽減8%の売上を別集計する', () => {
    const s = summarizeTax(
      [tx({ description: '食品販売', type: 'income', account: 'sales', amount: 1_080_000, taxCategory: 'taxable8' })],
      2026,
      settings,
    );
    expect(s.sales8).toBe(1_080_000);
    expect(s.salesTax).toBe(80_000);
  });

  it('2割特例は個人事業者は2026年分まで。期限外の年分は本則課税へフォールバックする', () => {
    const sale = (date: string) =>
      tx({ description: '報酬', type: 'income', account: 'sales', amount: 1_100_000, date });
    const special20: TaxSettings = { taxable: true, method: 'special20', simplifiedType: 5 };

    const in2026 = summarizeTax([sale('2026-06-15')], 2026, special20);
    expect(in2026.special20Available).toBe(true);
    expect(in2026.paySelected).toBe(in2026.paySpecial20); // 100,000×20% = 20,000

    const in2027 = summarizeTax([sale('2027-06-15')], 2027, special20);
    expect(in2027.special20Available).toBe(false);
    expect(in2027.paySelected).toBe(in2027.payGeneral); // 2割特例の20,000ではなく本則の100,000

    const in2022 = summarizeTax([sale('2022-06-15')], 2022, special20);
    expect(in2022.special20Available).toBe(false); // 制度開始(2023年10月)前
  });
});
