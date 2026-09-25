import { describe, expect, it } from 'vitest';
import { applyAnbun } from './anbun';
import { changedLockedYears, isLockedDate, yearFingerprint } from './lock';
import { AppData, DEFAULT_ISSUER, DEFAULT_TAX_SETTINGS, Transaction } from './types';

let seq = 0;
function tx(over: Partial<Transaction> & Pick<Transaction, 'date' | 'description' | 'type'>): Transaction {
  seq++;
  const amount = over.amount ?? 10000;
  return {
    id: `t${seq}`,
    amount,
    account: 'supplies',
    approved: true,
    anbunApplied: false,
    businessAmount: amount,
    source: 'csv',
    createdAt: seq,
    fund: 'bank',
    ...over,
  };
}

/** 2025年を申告済みロックにした帳簿(2025・2026年に取引あり) */
function base(): AppData {
  const transactions = [
    tx({ id: 'sale25', date: '2025-03-01', description: '報酬', type: 'income', account: 'sales', amount: 500000 }),
    tx({ id: 'rent25', date: '2025-04-25', description: '家賃', type: 'expense', account: 'rent', amount: 100000 }),
    tx({ id: 'rent26', date: '2026-04-25', description: '家賃', type: 'expense', account: 'rent', amount: 100000 }),
  ];
  const anbunSettings = [{ id: 'a1', account: 'rent', type: 'percent' as const, value: 30 }];
  return {
    transactions: applyAnbun(transactions, anbunSettings),
    rules: [],
    anbunSettings,
    openingBalances: [
      { year: 2025, cash: 0, bank: 300000, receivable: 0, card: 0, payable: 0, loan: 0, deposit: 0 },
      { year: 2026, cash: 0, bank: 700000, receivable: 0, card: 0, payable: 0, loan: 0, deposit: 0 },
    ],
    taxSettings: DEFAULT_TAX_SETTINGS,
    invoices: [],
    issuer: DEFAULT_ISSUER,
    assets: [],
    inventories: [],
    deductions: [],
    partners: [],
    payrolls: [],
    yearEndAdjustments: [],
    lockedYears: [2025],
    fundAccounts: [],
    reconciliations: [],
    rentPayees: [],
  };
}

/** store の mutate と同じく、変更後に按分を再計算する */
function change(prev: AppData, fn: (d: AppData) => AppData): AppData {
  const next = fn(prev);
  return { ...next, transactions: applyAnbun(next.transactions, next.anbunSettings) };
}

const editTx = (d: AppData, id: string, patch: Partial<Transaction>) => ({
  ...d,
  transactions: d.transactions.map((t) => (t.id === id ? { ...t, ...patch } : t)),
});

describe('changedLockedYears: 申告済みの年の帳簿が変わる変更の検出', () => {
  it('ロックしていない年の変更は通す', () => {
    const prev = base();
    expect(changedLockedYears(prev, change(prev, (d) => editTx(d, 'rent26', { amount: 120000 })))).toEqual([]);
  });

  it('ロック中の年の取引の金額・科目・摘要・決済手段の変更と削除を検出する', () => {
    const prev = base();
    for (const patch of [{ amount: 90000 }, { account: 'misc' }, { description: '家賃(訂正)' }, { fund: 'cash' as const }]) {
      expect(changedLockedYears(prev, change(prev, (d) => editTx(d, 'rent25', patch)))).toEqual([2025]);
    }
    const deleted = change(prev, (d) => ({ ...d, transactions: d.transactions.filter((t) => t.id !== 'sale25') }));
    expect(changedLockedYears(prev, deleted)).toEqual([2025]);
  });

  it('承認の付け外しは帳簿の数字を変えないので通す', () => {
    const prev = base();
    expect(changedLockedYears(prev, change(prev, (d) => editTx(d, 'rent25', { approved: false })))).toEqual([]);
  });

  it('按分設定: 全期間の割合を変えると検出し、翌年からの設定の追加は通す', () => {
    const prev = base();
    const overwrite = change(prev, (d) => ({
      ...d,
      anbunSettings: [{ id: 'a1', account: 'rent', type: 'percent' as const, value: 50 }],
    }));
    expect(changedLockedYears(prev, overwrite)).toEqual([2025]);
    const fromNextYear = change(prev, (d) => ({
      ...d,
      anbunSettings: [...d.anbunSettings, { id: 'a2', account: 'rent', type: 'percent' as const, value: 50, fromYear: 2026 }],
    }));
    expect(changedLockedYears(prev, fromNextYear)).toEqual([]);
    expect(fromNextYear.transactions.find((t) => t.id === 'rent26')!.businessAmount).toBe(50000);
  });

  it('固定資産・棚卸・期首残高の変更も、ロック中の年の数字が変わるなら検出する', () => {
    const prev = base();
    const asset = change(prev, (d) => ({
      ...d,
      assets: [{ id: 'pc', name: 'PC', acquiredDate: '2024-07-01', cost: 240000, method: 'straight' as const, usefulLife: 4, businessRatio: 100, createdAt: 1 }],
    }));
    expect(changedLockedYears(prev, asset)).toEqual([2025]);
    const inventory = change(prev, (d) => ({ ...d, inventories: [{ year: 2025, amount: 50000 }] }));
    expect(changedLockedYears(prev, inventory)).toEqual([2025]);
    const opening25 = change(prev, (d) => ({
      ...d,
      openingBalances: d.openingBalances.map((o) => (o.year === 2025 ? { ...o, cash: 1000 } : o)),
    }));
    expect(changedLockedYears(prev, opening25)).toEqual([2025]);
    // 2026年の期首残高・2027年取得の資産はロック中の2025年に影響しない
    const opening26 = change(prev, (d) => ({
      ...d,
      openingBalances: d.openingBalances.map((o) => (o.year === 2026 ? { ...o, cash: 1000 } : o)),
    }));
    expect(changedLockedYears(prev, opening26)).toEqual([]);
  });

  it('ロックの付け外し自体は帳簿を変えないので通る(解除後は編集できる)', () => {
    const prev = base();
    const unlocked = change(prev, (d) => ({ ...d, lockedYears: [] }));
    expect(changedLockedYears(prev, unlocked)).toEqual([]);
    expect(changedLockedYears(unlocked, change(unlocked, (d) => editTx(d, 'rent25', { amount: 1 })))).toEqual([]);
  });

  it('指紋は同じデータなら同じ値(キャッシュ)で、年ごとに異なる', () => {
    const d = base();
    expect(yearFingerprint(d, 2025)).toBe(yearFingerprint(d, 2025));
    expect(yearFingerprint(d, 2025)).not.toBe(yearFingerprint(d, 2026));
  });
});

describe('isLockedDate', () => {
  it('取引日の年がロック中か', () => {
    expect(isLockedDate([2025], '2025-12-31')).toBe(true);
    expect(isLockedDate([2025], '2026-01-01')).toBe(false);
    expect(isLockedDate([], '2025-06-01')).toBe(false);
  });
});
