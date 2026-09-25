import { describe, expect, it } from 'vitest';
import { yearEndChecklist } from './checklist';
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

function data(over: Partial<AppData>): AppData {
  return {
    transactions: [],
    rules: [],
    anbunSettings: [],
    openingBalances: [],
    taxSettings: DEFAULT_TAX_SETTINGS,
    invoices: [],
    issuer: DEFAULT_ISSUER,
    assets: [],
    inventories: [],
    deductions: [],
    partners: [],
    payrolls: [],
    yearEndAdjustments: [],
    lockedYears: [],
    fundAccounts: [],
    reconciliations: [],
    rentPayees: [],
    ...over,
  };
}

const statusOf = (items: ReturnType<typeof yearEndChecklist>) =>
  Object.fromEntries(items.map((i) => [i.id, i.status]));

describe('yearEndChecklist: 決算・申告チェックリスト', () => {
  it('手つかずの年: 期首残高・照合・ロック・バックアップが未完了、該当のない項目は対象外', () => {
    const s = statusOf(yearEndChecklist(data({}), 2026, { lastBackupDays: null }));
    expect(s).toMatchObject({
      opening: 'todo',
      classify: 'na',
      assets: 'na',
      inventory: 'na',
      loan: 'na',
      rent: 'na',
      recon: 'todo',
      lock: 'todo',
      backup: 'todo',
    });
  });

  it('記帳の状態から要対応を判定する(未承認・家賃の支払先・利息・現金のマイナス)', () => {
    const d = data({
      openingBalances: [{ year: 2026, cash: 1000, bank: 500000, receivable: 0, card: 0, payable: 0, loan: 0, deposit: 0 }],
      transactions: [
        tx({ date: '2026-01-25', description: '家賃', type: 'expense', account: 'rent', amount: 80000, approved: false }),
        tx({ date: '2026-02-25', description: '返済', type: 'expense', account: 'loan_repayment', amount: 50000 }),
        tx({ date: '2026-03-01', description: '現金で文具', type: 'expense', fund: 'cash', amount: 5000 }),
      ],
    });
    const items = yearEndChecklist(d, 2026, { lastBackupDays: 3 });
    const s = statusOf(items);
    expect(s).toMatchObject({
      opening: 'done',
      classify: 'todo',
      rent: 'todo',
      loan: 'todo',
      negative: 'warn',
      backup: 'done',
    });
    expect(items.find((i) => i.id === 'negative')!.detail).toContain('現金が03/01にマイナス');
  });

  it('対応が済めば完了になる(照合・ロック・支払先・利息)', () => {
    const d = data({
      openingBalances: [{ year: 2026, cash: 10000, bank: 500000, receivable: 0, card: 0, payable: 0, loan: 1000000, deposit: 0 }],
      transactions: [
        tx({ date: '2026-01-25', description: '家賃', type: 'expense', account: 'rent', amount: 80000 }),
        tx({ date: '2026-02-25', description: '返済', type: 'expense', account: 'loan_repayment', amount: 50000, interest: 3000 }),
      ],
      rentPayees: [{ id: 'p', name: '大家', address: '', property: '事務所', keyword: '', createdAt: 0 }],
      reconciliations: [{ id: 'r', target: 'bank', date: '2026-12-31', balance: 370000, createdAt: 0 }],
      lockedYears: [2026],
    });
    const s = statusOf(yearEndChecklist(d, 2026, { lastBackupDays: 0 }));
    expect(s).toMatchObject({ classify: 'done', rent: 'done', loan: 'done', negative: 'done', recon: 'done', lock: 'done', balanced: 'done' });
  });
});
