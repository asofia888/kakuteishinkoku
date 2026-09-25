import { describe, expect, it } from 'vitest';
import {
  bookBalanceAt,
  lineLabel,
  lineMatcher,
  negativeBalances,
  reconTargets,
  resolveSub,
  subClosingBalances,
  subOpening,
} from './fundAccounts';
import { buildBalanceSheet, deriveJournal, entryForTransaction, generalLedger } from './ledger';
import { FundAccount, OpeningBalance, Transaction } from './types';

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

const rakuten: FundAccount = { id: 'rk', fund: 'bank', name: '楽天銀行', createdAt: 1 };
const chigin: FundAccount = { id: 'cg', fund: 'bank', name: '地方銀行', createdAt: 2 };
const visa: FundAccount = { id: 'visa', fund: 'card', name: 'VISA', createdAt: 3 };
const amex: FundAccount = { id: 'amex', fund: 'card', name: 'AMEX', createdAt: 4 };
const list = [rakuten, chigin, visa, amex];

const opening: OpeningBalance = {
  year: 2026,
  cash: 20000,
  bank: 1_000_000,
  receivable: 0,
  card: 50_000,
  payable: 0,
  loan: 0,
  deposit: 0,
  subBalances: { cg: 300_000, amex: 20_000 },
};

// 楽天(既定口座・口座指定なし含む)と地銀、VISA と AMEX を使う1年
const txs: Transaction[] = [
  tx({ date: '2026-01-10', description: '報酬(楽天)', type: 'income', account: 'sales', amount: 200_000 }),
  tx({ date: '2026-01-20', description: '家賃(地銀)', type: 'expense', account: 'rent', amount: 80_000, fundAccount: 'cg' }),
  tx({ date: '2026-02-05', description: '楽天→地銀へ振替', type: 'expense', account: 'fund_transfer', amount: 100_000, counterFund: 'bank', counterAccount: 'cg' }),
  tx({ date: '2026-02-10', description: 'VISAで購入', type: 'expense', fund: 'card', fundAccount: 'visa', amount: 30_000 }),
  tx({ date: '2026-02-12', description: 'AMEXで購入', type: 'expense', fund: 'card', fundAccount: 'amex', amount: 15_000 }),
  tx({ date: '2026-02-27', description: 'VISA引落し(地銀)', type: 'expense', account: 'card_payment', amount: 60_000, fundAccount: 'cg', counterAccount: 'visa' }),
];

describe('口座(補助科目)の解決', () => {
  it('登録済みの ID はそのまま、未指定・削除済みは既定(最初)の口座、口座がなければ undefined', () => {
    expect(resolveSub(list, 'bank', 'cg')).toBe('cg');
    expect(resolveSub(list, 'bank', undefined)).toBe('rk');
    expect(resolveSub(list, 'bank', 'deleted')).toBe('rk');
    expect(resolveSub(list, 'bank', 'visa')).toBe('rk'); // 別の資金の ID は既定へ
    expect(resolveSub([], 'bank', 'cg')).toBeUndefined();
  });

  it('期首残高: 口座別の登録があればそれ、既定の口座は合計から他の口座を引いた残り', () => {
    expect(subOpening(opening, list, 'bank', 'cg')).toBe(300_000);
    expect(subOpening(opening, list, 'bank', 'rk')).toBe(700_000);
    expect(subOpening(opening, list, 'card', 'amex')).toBe(20_000);
    expect(subOpening(opening, list, 'card', 'visa')).toBe(30_000);
    expect(subOpening(undefined, list, 'bank', 'rk')).toBe(0);
  });
});

describe('仕訳の口座(sub)', () => {
  it('口座間の振替は 借方:地銀 / 貸方:楽天(既定)になり、合計の普通預金は動かない', () => {
    const e = entryForTransaction(txs[2])!;
    expect(e.debits).toEqual([{ account: 'bank', amount: 100_000, sub: 'cg' }]);
    expect(e.credits).toEqual([{ account: 'bank', amount: 100_000 }]); // 口座指定なし = 既定の楽天
  });

  it('カード引落しは、引き落とされたカードの未払金と、引落し口座に口座IDが付く', () => {
    const e = entryForTransaction(txs[5])!;
    expect(e.debits).toEqual([{ account: 'card', amount: 60_000, sub: 'visa' }]);
    expect(e.credits).toEqual([{ account: 'bank', amount: 60_000, sub: 'cg' }]);
  });

  it('普通預金・カード以外の行には口座IDを付けない', () => {
    const e = entryForTransaction(tx({ date: '2026-03-01', description: '現金払い', type: 'expense', fund: 'cash', fundAccount: 'rk' }))!;
    expect(e.credits).toEqual([{ account: 'cash', amount: 10000 }]);
  });

  it('表示名: 口座を分けている資金には口座名を付ける', () => {
    expect(lineLabel({ account: 'bank', amount: 1, sub: 'cg' }, list)).toBe('普通預金(地方銀行)');
    expect(lineLabel({ account: 'bank', amount: 1 }, list)).toBe('普通預金(楽天銀行)');
    expect(lineLabel({ account: 'bank', amount: 1 }, [rakuten])).toBe('普通預金'); // 1口座なら付けない
    expect(lineLabel({ account: 'rent', amount: 1 }, list)).toBe('地代家賃');
  });
});

describe('口座ごとの残高(補助元帳・繰越・照合)', () => {
  it('年末の口座別残高の合計は、貸借対照表の普通預金・カード未払金と一致する', () => {
    const closing = subClosingBalances(txs, 2026, opening, list);
    // 楽天: 700,000 + 200,000 − 100,000 = 800,000 / 地銀: 300,000 − 80,000 + 100,000 − 60,000 = 260,000
    expect(closing).toEqual({ rk: 800_000, cg: 260_000, visa: 0, amex: 35_000 });
    const bs = buildBalanceSheet(txs, 2026, opening);
    expect(bs.assets.find((r) => r.id === 'bank')!.closing).toBe(closing.rk + closing.cg);
    expect(bs.liabilities.find((r) => r.id === 'card')!.closing).toBe(closing.visa + closing.amex);
  });

  it('補助元帳: 地銀だけの入出金と残高', () => {
    const rows = generalLedger(
      deriveJournal(txs),
      'bank',
      subOpening(opening, list, 'bank', 'cg'),
      lineMatcher(list, 'bank', 'cg'),
    );
    expect(rows.map((r) => [r.description, r.balance])).toEqual([
      ['家賃(地銀)', 220_000],
      ['楽天→地銀へ振替', 320_000],
      ['VISA引落し(地銀)', 260_000],
    ]);
    expect(rows[1].counter).toBe('普通預金'); // 振替の相手は楽天側の普通預金
  });

  it('照合日の帳簿残高(その日の取引まで含む)', () => {
    const ob = [opening];
    expect(bookBalanceAt(txs, ob, list, 'cg', '2026-02-05')).toEqual({ balance: 320_000, hasOpening: true });
    expect(bookBalanceAt(txs, ob, list, 'cg', '2026-02-04')!.balance).toBe(220_000);
    expect(bookBalanceAt(txs, ob, list, 'visa', '2026-02-10')!.balance).toBe(60_000); // 未払残高
    expect(bookBalanceAt(txs, ob, list, 'cash', '2026-12-31')!.balance).toBe(20_000);
    expect(bookBalanceAt(txs, ob, list, 'bank', '2026-12-31')!.balance).toBe(1_060_000); // 資金の合計
    expect(bookBalanceAt(txs, [], list, 'rk', '2026-01-31')).toEqual({ balance: 200_000, hasOpening: false });
    expect(bookBalanceAt(txs, ob, list, 'deleted', '2026-01-31')).toBeNull();
  });

  it('照合の対象: 口座があれば口座ごと、なければ資金全体', () => {
    expect(reconTargets(list).map((t) => t.label)).toEqual([
      '現金',
      '普通預金(楽天銀行)',
      '普通預金(地方銀行)',
      'カード未払金(VISA)',
      'カード未払金(AMEX)',
    ]);
    expect(reconTargets([]).map((t) => t.id)).toEqual(['cash', 'bank', 'card']);
  });
});

describe('negativeBalances: 現金・預金の日末残高のマイナス', () => {
  it('現金の使いすぎ(私費の立替えの計上漏れ)を、最初の日と最低残高で知らせる', () => {
    const ob = { ...opening, cash: 5_000 };
    const found = negativeBalances(
      [
        tx({ date: '2026-03-01', description: '現金で文具', type: 'expense', fund: 'cash', amount: 8_000 }),
        tx({ date: '2026-03-01', description: 'ATMで引出し', type: 'expense', account: 'fund_transfer', counterFund: 'cash', amount: 10_000 }),
        tx({ date: '2026-04-10', description: '現金で交通費', type: 'expense', fund: 'cash', amount: 9_000 }),
        tx({ date: '2026-04-20', description: '現金で交際費', type: 'expense', fund: 'cash', amount: 5_000 }),
      ],
      2026,
      ob,
      [],
    );
    // 3/1 は同じ日の引出しで日末 7,000(プラス)。4/10 に −2,000、4/20 に −7,000
    expect(found).toEqual([
      { target: 'cash', label: '現金', firstDate: '2026-04-10', lowest: -7_000, lowestDate: '2026-04-20' },
    ]);
  });

  it('口座を分けていれば口座ごとに判定する(合計はプラスでも片方のマイナスを見つける)', () => {
    const found = negativeBalances(
      [tx({ date: '2026-05-01', description: '地銀から家賃', type: 'expense', account: 'rent', fundAccount: 'cg', amount: 400_000 })],
      2026,
      opening,
      list,
    );
    expect(found.map((f) => [f.label, f.firstDate, f.lowest])).toEqual([['普通預金(地方銀行)', '2026-05-01', -100_000]]);
  });
});
