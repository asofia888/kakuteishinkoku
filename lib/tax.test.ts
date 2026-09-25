import { describe, expect, it } from 'vitest';
import {
  assetPurchaseBusinessAmounts,
  calcTaxReturn,
  defaultTaxCategory,
  effectiveTaxCategory,
  nonQualifiedDeductionRate,
  summarizeTax,
  taxInclusive,
} from './tax';
import { FixedAsset, TaxSettings, Transaction } from './types';

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
    expect(defaultTaxCategory({ type: 'expense', account: 'card_payment' })).toBe('none');
  });

  it('固定資産の取得は振替科目でも課税仕入(課税10%)になる', () => {
    expect(defaultTaxCategory({ type: 'expense', account: 'asset_purchase' })).toBe('taxable10');
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

describe('nonQualifiedDeductionRate: インボイス経過措置(令和8年度改正後)', () => {
  it('2026/9まで80%・2028/9まで70%・2030/9まで50%・2031/9まで30%・以降0%', () => {
    expect(nonQualifiedDeductionRate('2023-09-30')).toBe(100);
    expect(nonQualifiedDeductionRate('2023-10-01')).toBe(80);
    expect(nonQualifiedDeductionRate('2026-09-30')).toBe(80);
    expect(nonQualifiedDeductionRate('2026-10-01')).toBe(70);
    expect(nonQualifiedDeductionRate('2028-09-30')).toBe(70);
    expect(nonQualifiedDeductionRate('2028-10-01')).toBe(50);
    expect(nonQualifiedDeductionRate('2030-09-30')).toBe(50);
    expect(nonQualifiedDeductionRate('2030-10-01')).toBe(30);
    expect(nonQualifiedDeductionRate('2031-09-30')).toBe(30);
    expect(nonQualifiedDeductionRate('2031-10-01')).toBe(0);
  });

  it('同じ年の中でも取引日で割合が切り替わる(2026年は9月まで80%・10月から70%)', () => {
    const s = summarizeTax(
      [
        tx({ description: '免税事業者から9月', type: 'expense', amount: 110_000, qualifiedInvoice: false, date: '2026-09-30' }),
        tx({ description: '免税事業者から10月', type: 'expense', amount: 110_000, qualifiedInvoice: false, date: '2026-10-01' }),
      ],
      2026,
      settings,
    );
    // 税10,000×80% + 税10,000×70% = 15,000
    expect(s.deductibleTax).toBe(15_000);
    expect(s.nonQualifiedLostTax).toBe(5_000);
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

  it('申告書ベース(calcTaxReturn): 課税標準の千円未満切捨・7.8%/6.24%・差引百円未満切捨・地方22/78', () => {
    // 手計算による検証例:
    //   10%売上(税込) 11,000,000 → 課税標準 10,000,000 → 国税 780,000
    //   8%売上(税込) 1,080,540 → 税抜 1,000,500 → 千円未満切捨 1,000,000 → 国税 62,400
    //   適格仕入(税込10%) 5,500,000 → 5,500,000×7.8/110 = 390,000
    //   適格なし仕入 550,000(2026/5 → 80%) → 39,000×80% = 31,200
    const txs = [
      tx({ description: '売上10%', type: 'income', account: 'sales', amount: 11_000_000 }),
      tx({ description: '売上8%', type: 'income', account: 'sales', amount: 1_080_540, taxCategory: 'taxable8' }),
      tx({ description: '適格仕入', type: 'expense', amount: 5_500_000 }),
      tx({ description: '適格なし仕入', type: 'expense', amount: 550_000, qualifiedInvoice: false, date: '2026-05-01' }),
    ];
    const r = calcTaxReturn(txs, 2026, settings);
    expect(r.base10).toBe(10_000_000);
    expect(r.base8).toBe(1_000_000);
    expect(r.tax10).toBe(780_000);
    expect(r.tax8).toBe(62_400);
    expect(r.salesTaxNational).toBe(842_400);
    expect(r.deductibleNational).toBe(421_200);
    expect(r.netNational).toBe(421_200); // 百円未満なし
    expect(r.localTax).toBe(118_800); // 421,200 × 22/78
    expect(r.totalDue).toBe(540_000);

    // 簡易課税(第1種90%): 控除 758,160 → 差引 84,240 → 百円未満切捨 84,200
    // 譲渡割 84,200×22/78 = 23,748.7… → 23,748 → 百円未満切捨 23,700
    const rs = calcTaxReturn(txs, 2026, { taxable: true, method: 'simplified', simplifiedType: 1 });
    expect(rs.deductibleNational).toBe(758_160);
    expect(rs.netNational).toBe(84_200);
    expect(rs.localTax).toBe(23_700);
    expect(rs.totalDue).toBe(107_900);

    // 2割特例: 特別控除80% = 673,920 → 差引 168,480 → 168,400
    // 譲渡割 168,400×22/78 = 47,497.4… → 47,400
    const r2 = calcTaxReturn(txs, 2026, { taxable: true, method: 'special20', simplifiedType: 1 });
    expect(r2.applied).toBe('special20');
    expect(r2.deductibleNational).toBe(673_920);
    expect(r2.netNational).toBe(168_400);
    expect(r2.localTax).toBe(47_400);
    expect(r2.totalDue).toBe(215_800);

    // 期限外(2027年分)の2割特例は本則へ読み替え
    const txs2027 = txs.map((t) => ({ ...t, date: '2027-05-01' }));
    const r3 = calcTaxReturn(txs2027, 2027, { taxable: true, method: 'special20', simplifiedType: 1 });
    expect(r3.applied).toBe('general');
    // 2027年の適格なし仕入は経過措置70%(令和8年度改正): 39,000×70% = 27,300 → 控除 417,300
    expect(r3.deductibleNational).toBe(417_300);
  });

  it('申告書ベース: 控除不足(還付)は円単位のまま・地方も22/78で還付', () => {
    // 売上0・適格仕入 1,100,000 → 国税控除不足 78,000 → 地方 22,000 → 合計還付 100,000
    const txs = [tx({ description: '仕入のみ', type: 'expense', amount: 1_100_000 })];
    const r = calcTaxReturn(txs, 2026, settings);
    expect(r.salesTaxNational).toBe(0);
    expect(r.netNational).toBe(-78_000);
    expect(r.localTax).toBe(-22_000);
    expect(r.totalDue).toBe(-100_000);
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

describe('固定資産の取得: 購入年の課税仕入(本則課税の仕入税額控除)', () => {
  function asset(over: Partial<FixedAsset> & Pick<FixedAsset, 'id' | 'cost'>): FixedAsset {
    return {
      name: over.id,
      acquiredDate: '2026-06-15',
      method: 'straight',
      usefulLife: 6,
      businessRatio: 100,
      createdAt: 0,
      ...over,
    };
  }
  const sales = tx({ description: '売上', type: 'income', account: 'sales', amount: 5_500_000 });
  const buy = (amount: number, over: Partial<Transaction> = {}) =>
    tx({ description: '備品の購入', type: 'expense', account: 'asset_purchase', amount, ...over });

  it('取得価額の消費税を購入年に控除する(減価償却費ではなく取得時)', () => {
    const txs = [sales, buy(550_000)];
    const assets = [asset({ id: 'machine', cost: 550_000 })];
    const s = summarizeTax(txs, 2026, settings, assets);
    expect(s.purchase10).toBe(550_000);
    expect(s.purchaseAssets).toBe(550_000);
    expect(s.deductibleTax).toBe(50_000);
    expect(s.payGeneral).toBe(450_000); // 以前は控除漏れで 500,000 になっていた

    // 申告書ベース: 国税 390,000 − 550,000×7.8/110(39,000)= 351,000 → 地方 99,000 → 合計 450,000
    const r = calcTaxReturn(txs, 2026, settings, assets);
    expect(r.deductibleNational).toBe(39_000);
    expect(r.netNational).toBe(351_000);
    expect(r.totalDue).toBe(450_000);
  });

  it('家事共用資産は台帳の事業専用割合だけを課税仕入にする(同じ金額の資産と対応づけ)', () => {
    const txs = [sales, buy(3_300_000), buy(220_000)];
    const assets = [
      asset({ id: 'car', cost: 3_300_000, businessRatio: 60 }),
      asset({ id: 'pc', cost: 220_000, businessRatio: 100 }),
    ];
    const s = summarizeTax(txs, 2026, settings, assets);
    // 車 3,300,000×60% = 1,980,000(税180,000)+ PC 220,000(税20,000)
    expect(s.purchaseAssets).toBe(2_200_000);
    expect(s.deductibleTax).toBe(200_000);
  });

  it('金額で対応がつかない一括払いは、その年の取得資産の加重平均割合を使う', () => {
    const txs = [buy(3_520_000)]; // 車とPCをまとめて支払い
    const assets = [
      asset({ id: 'car', cost: 3_300_000, businessRatio: 60 }),
      asset({ id: 'pc', cost: 220_000, businessRatio: 100 }),
    ];
    const m = assetPurchaseBusinessAmounts(txs, assets, 2026);
    // (3,300,000×60 + 220,000×100) / 3,520,000 = 62.5% → 2,200,000(個別に対応づけた場合と同額)
    expect(m.get(txs[0].id)).toBe(2_200_000);
  });

  it('台帳に登録がない・別の年の資産・繰延資産(開業費)とは対応づけず全額を事業分とする', () => {
    const t = buy(330_000);
    const m = assetPurchaseBusinessAmounts(
      [t],
      [
        asset({ id: 'old', cost: 330_000, businessRatio: 50, acquiredDate: '2025-06-01' }),
        asset({ id: 'kaigyo', cost: 330_000, businessRatio: 50, method: 'deferred' }),
      ],
      2026,
    );
    expect(m.get(t.id)).toBe(330_000);
  });

  it('税区分「不課税」(個人からの中古購入など)は控除せず、適格請求書なしは経過措置を適用する', () => {
    const assets = [asset({ id: 'a', cost: 1_100_000 }), asset({ id: 'b', cost: 550_000 })];
    const s = summarizeTax(
      [
        buy(1_100_000, { taxCategory: 'none' }),
        buy(550_000, { qualifiedInvoice: false, date: '2026-06-15' }),
      ],
      2026,
      settings,
      assets,
    );
    expect(s.purchaseAssets).toBe(550_000);
    expect(s.deductibleTax).toBe(40_000); // 税50,000 × 80%
    expect(s.nonQualifiedCount).toBe(1);
  });

  it('簡易課税・2割特例の納付額は固定資産の取得の影響を受けない', () => {
    const assets = [asset({ id: 'machine', cost: 550_000 })];
    const without = summarizeTax([sales], 2026, settings);
    const withAsset = summarizeTax([sales, buy(550_000)], 2026, settings, assets);
    expect(withAsset.paySimplified).toBe(without.paySimplified);
    expect(withAsset.paySpecial20).toBe(without.paySpecial20);
  });
});
