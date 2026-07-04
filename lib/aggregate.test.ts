import { describe, expect, it } from 'vitest';
import { EXCLUDED_ACCOUNT } from './accounts';
import {
  availableYears,
  depreciationCandidates,
  periodSlipCandidates,
  summarizeYear,
  summaryToCsv,
} from './aggregate';
import { Transaction } from './types';

let seq = 0;
function tx(
  over: Partial<Transaction> & Pick<Transaction, 'date' | 'amount' | 'type'>,
): Transaction {
  seq++;
  return {
    id: `t${seq}`,
    description: '',
    account: null,
    approved: true,
    anbunApplied: false,
    businessAmount: over.amount,
    source: 'csv',
    createdAt: seq,
    fund: 'bank',
    ...over,
  };
}

describe('summarizeYear', () => {
  const txs: Transaction[] = [
    // 収入(1月・2月)
    tx({ date: '2026-01-25', amount: 100000, type: 'income', account: 'sales' }),
    tx({ date: '2026-02-25', amount: 200000, type: 'income', account: 'sales' }),
    tx({ date: '2026-03-10', amount: 5000, type: 'income', account: 'misc_income' }),
    // 経費(家賃は按分済み: 80,000のうち30,000を経費計上)
    tx({
      date: '2026-01-27',
      amount: 80000,
      type: 'expense',
      account: 'rent',
      businessAmount: 30000,
      anbunApplied: true,
    }),
    tx({ date: '2026-02-08', amount: 5000, type: 'expense', account: 'supplies' }),
    // 未仕訳・未承認
    tx({ date: '2026-06-14', amount: 12800, type: 'expense', account: null }),
    tx({ date: '2026-04-01', amount: 3000, type: 'expense', account: 'supplies', approved: false }),
    // 対象外(プライベート)── 集計にもアラートにも入らない
    tx({ date: '2026-07-19', amount: 999999, type: 'expense', account: EXCLUDED_ACCOUNT, approved: false }),
    tx({ date: '2026-07-20', amount: 888888, type: 'income', account: EXCLUDED_ACCOUNT }),
    // 他の年 ── 集計対象外
    tx({ date: '2025-12-25', amount: 500000, type: 'income', account: 'sales' }),
  ];
  const s = summarizeYear(txs, 2026);

  it('売上は月別・年間で集計される(対象外・他年は除く)', () => {
    expect(s.monthlySales[0]).toBe(100000);
    expect(s.monthlySales[1]).toBe(200000);
    expect(s.monthlySales[2]).toBe(5000);
    expect(s.totalSales).toBe(305000);
  });

  it('経費は按分前・按分後・事業主貸に分かれる', () => {
    const rent = s.expenseLines.find((l) => l.account === 'rent')!;
    expect(rent.gross).toBe(80000);
    expect(rent.business).toBe(30000);
    expect(rent.owner).toBe(50000);
    expect(s.totalExpense).toBe(30000 + 5000 + 3000);
    expect(s.totalGross).toBe(80000 + 5000 + 3000);
    expect(s.totalOwner).toBe(50000);
  });

  it('差引金額 = 売上 − 経費(按分後)', () => {
    expect(s.profit).toBe(305000 - 38000);
  });

  it('未仕訳・未承認の件数を数える(対象外は含めない)', () => {
    expect(s.unclassifiedCount).toBe(1);
    expect(s.unapprovedCount).toBe(1);
  });

  it('対象外(プライベート)は金額にいっさい影響しない', () => {
    const withoutExcluded = summarizeYear(
      txs.filter((t) => t.account !== EXCLUDED_ACCOUNT),
      2026,
    );
    expect(s).toEqual({ ...withoutExcluded, year: 2026 });
  });
});

describe('availableYears', () => {
  it('データに含まれる年+今年を降順で返す', () => {
    const txs = [
      tx({ date: '2024-05-01', amount: 1000, type: 'income', account: 'sales' }),
      tx({ date: '2026-05-01', amount: 1000, type: 'income', account: 'sales' }),
    ];
    expect(availableYears(txs, 2026)).toEqual([2026, 2024]);
    expect(availableYears([], 2026)).toEqual([2026]);
  });
});

describe('depreciationCandidates(減価償却の検討候補)', () => {
  it('10万円以上の消耗品費だけを検出する', () => {
    const txs = [
      tx({ date: '2026-01-01', amount: 100000, type: 'expense', account: 'supplies' }), // 検出
      tx({ date: '2026-01-02', amount: 99999, type: 'expense', account: 'supplies' }), // 10万未満
      tx({ date: '2026-01-03', amount: 200000, type: 'expense', account: 'rent' }), // 別科目
      tx({ date: '2026-01-04', amount: 150000, type: 'income', account: 'sales' }), // 収入
    ];
    const found = depreciationCandidates(txs);
    expect(found).toHaveLength(1);
    expect(found[0].amount).toBe(100000);
  });
});

describe('periodSlipCandidates(期ズレ候補)', () => {
  it('翌年1月に入金された売上だけを検出する', () => {
    const txs = [
      tx({ date: '2027-01-05', amount: 300000, type: 'income', account: 'sales' }), // 検出
      tx({ date: '2027-01-06', amount: 100, type: 'income', account: null }), // 未仕訳の入金も検出
      tx({ date: '2027-01-07', amount: 5000, type: 'expense', account: 'supplies' }), // 支出は対象外
      tx({ date: '2027-01-08', amount: 8000, type: 'income', account: EXCLUDED_ACCOUNT }), // 対象外
      tx({ date: '2027-02-05', amount: 300000, type: 'income', account: 'sales' }), // 2月は対象外
      tx({ date: '2026-01-05', amount: 300000, type: 'income', account: 'sales' }), // 当年1月は対象外
    ];
    const found = periodSlipCandidates(txs, 2026);
    expect(found.map((t) => t.amount)).toEqual([300000, 100]);
  });
});

describe('summaryToCsv', () => {
  it('Excel対応のBOMで始まり、主要な行を含む', () => {
    const s = summarizeYear(
      [tx({ date: '2026-01-25', amount: 100000, type: 'income', account: 'sales' })],
      2026,
    );
    const csv = summaryToCsv(s);
    expect(csv.startsWith('\ufeff')).toBe(true);
    expect(csv).toContain('差引金額(青色申告特別控除前の所得金額)');
    expect(csv).toContain('売上(収入)金額');
  });
});

describe('決済・振替科目の扱い', () => {
  it('売掛金の回収・カード引落しは売上・経費に入らない(二重計上の防止)', () => {
    const txs = [
      tx({ date: '2026-01-25', amount: 100000, type: 'income', account: 'sales' }),
      tx({ date: '2026-02-01', amount: 100000, type: 'income', account: 'ar_collect' }),
      tx({ date: '2026-02-27', amount: 50000, type: 'expense', account: 'card_payment' }),
    ];
    const s = summarizeYear(txs, 2026);
    expect(s.totalSales).toBe(100000);
    expect(s.monthlySales[1]).toBe(0); // 2月の回収入金は売上グラフに乗らない
    expect(s.totalExpense).toBe(0);
  });

  it('「売掛金の回収」にした翌年1月の入金は期ズレ候補から外れる', () => {
    const txs = [
      tx({ date: '2027-01-10', amount: 220000, type: 'income', account: 'ar_collect' }),
      tx({ date: '2027-01-15', amount: 88000, type: 'income', account: 'sales' }),
    ];
    const slips = periodSlipCandidates(txs, 2026);
    expect(slips).toHaveLength(1);
    expect(slips[0].amount).toBe(88000);
  });
});

describe('減価償却・棚卸の損益への反映', () => {
  it('台帳の償却費が経費に合算され、棚卸調整が売上原価に効く', () => {
    const assets = [
      {
        id: 'a1',
        name: 'ノートPC',
        acquiredDate: '2025-07-10',
        cost: 240000,
        method: 'straight' as const,
        usefulLife: 4,
        businessRatio: 50, // 事業割合50%
        createdAt: 1,
      },
    ];
    const inventories = [
      { year: 2025, amount: 80000 },
      { year: 2026, amount: 50000 },
    ];
    const s = summarizeYear(
      [tx({ date: '2026-05-01', amount: 200000, type: 'expense', account: 'purchases' })],
      2026,
      assets,
      inventories,
    );
    // 2026年の償却費60,000のうち事業分50% = 30,000(残りは事業主貸)
    const dep = s.expenseLines.find((l) => l.account === 'depreciation')!;
    expect(dep.gross).toBe(60000);
    expect(dep.business).toBe(30000);
    expect(dep.owner).toBe(30000);
    // 売上原価調整: 期首80,000 加算・期末50,000 控除
    expect(s.inventoryOpening).toBe(80000);
    expect(s.inventoryClosing).toBe(50000);
    expect(s.totalExpense).toBe(200000 + 30000 + 80000 - 50000);
    expect(s.profit).toBe(-(200000 + 30000 + 30000));
  });
});
