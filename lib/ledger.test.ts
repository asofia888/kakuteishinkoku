import { describe, expect, it } from 'vitest';
import { summarizeYear } from './aggregate';
import {
  buildBalanceSheet,
  carryForwardOpening,
  deriveJournal,
  entryForTransaction,
  generalLedger,
} from './ledger';
import { FixedAsset, Transaction } from './types';

let seq = 0;
function tx(over: Partial<Transaction> & Pick<Transaction, 'description' | 'type'>): Transaction {
  seq++;
  const amount = over.amount ?? 1000;
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

/** 仕訳の借方合計・貸方合計 */
function totals(e: NonNullable<ReturnType<typeof entryForTransaction>>) {
  return {
    dr: e.debits.reduce((s, l) => s + l.amount, 0),
    cr: e.credits.reduce((s, l) => s + l.amount, 0),
  };
}

describe('entryForTransaction: 仕訳の導出', () => {
  it('銀行入金の売上: (借)普通預金 / (貸)売上', () => {
    const e = entryForTransaction(
      tx({ description: '振込 報酬', type: 'income', account: 'sales', amount: 100000 }),
    )!;
    expect(e.debits).toEqual([{ account: 'bank', amount: 100000 }]);
    expect(e.credits).toEqual([{ account: 'sales', amount: 100000 }]);
  });

  it('カード払いの経費: (借)消耗品費 / (貸)未払金(カード)', () => {
    const e = entryForTransaction(
      tx({ description: 'AMAZON', type: 'expense', fund: 'card', amount: 5000 }),
    )!;
    expect(e.debits).toEqual([{ account: 'supplies', amount: 5000 }]);
    expect(e.credits).toEqual([{ account: 'card', amount: 5000 }]);
  });

  it('家事按分のある経費は事業分と事業主貸に分かれる(複合仕訳)', () => {
    const e = entryForTransaction(
      tx({
        description: '電気料金',
        type: 'expense',
        account: 'utilities',
        amount: 10000,
        businessAmount: 4000,
      }),
    )!;
    expect(e.debits).toEqual([
      { account: 'utilities', amount: 4000 },
      { account: 'owner_draw', amount: 6000 },
    ]);
    expect(e.credits).toEqual([{ account: 'bank', amount: 10000 }]);
    const { dr, cr } = totals(e);
    expect(dr).toBe(cr); // 貸借一致
  });

  it('売掛金の計上と回収: 発生時は売上、回収時は損益に触れない', () => {
    const invoice = entryForTransaction(
      tx({ description: '請求書発行', type: 'income', account: 'sales', fund: 'receivable', amount: 220000 }),
    )!;
    expect(invoice.debits).toEqual([{ account: 'receivable', amount: 220000 }]);
    expect(invoice.credits).toEqual([{ account: 'sales', amount: 220000 }]);

    const collect = entryForTransaction(
      tx({ description: '入金', type: 'income', account: 'ar_collect', fund: 'bank', amount: 220000 }),
    )!;
    expect(collect.debits).toEqual([{ account: 'bank', amount: 220000 }]);
    expect(collect.credits).toEqual([{ account: 'receivable', amount: 220000 }]);
  });

  it('カード引落しは未払金の決済になり経費にならない(二重計上の防止)', () => {
    const e = entryForTransaction(
      tx({ description: 'カード利用代金', type: 'expense', account: 'card_payment', amount: 52340 }),
    )!;
    expect(e.debits).toEqual([{ account: 'card', amount: 52340 }]);
    expect(e.credits).toEqual([{ account: 'bank', amount: 52340 }]);
  });

  it('対象外(プライベート)は事業主貸/借になり、私費×対象外は帳簿外', () => {
    const priv = entryForTransaction(
      tx({ description: 'スーパー', type: 'expense', account: 'excluded', amount: 8000 }),
    )!;
    expect(priv.debits).toEqual([{ account: 'owner_draw', amount: 8000 }]);
    expect(priv.credits).toEqual([{ account: 'bank', amount: 8000 }]);

    const offBook = entryForTransaction(
      tx({ description: '私費で私的な買い物', type: 'expense', account: 'excluded', fund: 'owner' }),
    );
    expect(offBook).toBeNull();
  });

  it('私費で払った経費: (借)経費 / (貸)事業主借', () => {
    const e = entryForTransaction(
      tx({ description: '文房具(私費)', type: 'expense', fund: 'owner', amount: 1200 }),
    )!;
    expect(e.credits).toEqual([{ account: 'owner_invest', amount: 1200 }]);
  });

  it('未仕訳は仕訳されない', () => {
    expect(entryForTransaction(tx({ description: '不明', type: 'expense', account: null }))).toBeNull();
  });
});

describe('buildBalanceSheet: 貸借対照表', () => {
  const year = 2026;
  const opening = { year, cash: 50000, bank: 800000, receivable: 0, card: 0, payable: 0 };
  const txs: Transaction[] = [
    tx({ date: '2026-01-25', description: '報酬', type: 'income', account: 'sales', amount: 300000 }),
    tx({
      date: '2026-02-15',
      description: '電気(按分40%)',
      type: 'expense',
      account: 'utilities',
      amount: 10000,
      businessAmount: 4000,
    }),
    tx({ date: '2026-03-08', description: 'AMAZON', type: 'expense', fund: 'card', amount: 5000 }),
    tx({ date: '2026-04-27', description: 'カード引落し', type: 'expense', account: 'card_payment', amount: 5000 }),
    tx({
      date: '2026-12-31',
      description: '12月分請求',
      type: 'income',
      account: 'sales',
      fund: 'receivable',
      amount: 220000,
    }),
    tx({ date: '2026-07-19', description: '私的支出', type: 'expense', account: 'excluded', amount: 8000 }),
  ];

  it('期末残高・所得・貸借一致がすべて正しい', () => {
    const bs = buildBalanceSheet(txs, year, opening);
    const closing = (rows: typeof bs.assets, id: string) => rows.find((r) => r.id === id)!.closing;

    // 普通預金: 800,000 + 300,000(売上) - 10,000(電気) - 5,000(引落し) - 8,000(私的) = 1,077,000
    expect(closing(bs.assets, 'bank')).toBe(1_077_000);
    expect(closing(bs.assets, 'cash')).toBe(50_000);
    expect(closing(bs.assets, 'receivable')).toBe(220_000); // 未回収の売掛金
    expect(closing(bs.liabilities, 'card')).toBe(0); // 引落しで消えた
    // 事業主貸: 按分の家事分6,000 + 私的支出8,000
    expect(closing(bs.assets, 'owner_draw')).toBe(14_000);
    // 所得: 売上520,000 - 経費(4,000 + 5,000)
    expect(bs.profit).toBe(511_000);
    expect(bs.capital).toBe(850_000);
    expect(bs.balanced).toBe(true);
    expect(bs.totalAssetsClosing).toBe(bs.totalLiabEquityClosing);
    // 翌年元入金 = 850,000 + 511,000 + 0 - 14,000
    expect(bs.nextCapital).toBe(1_347_000);
  });

  it('所得(青色申告特別控除前)は損益集計(summarizeYear)と一致する', () => {
    const bs = buildBalanceSheet(txs, year, opening);
    const summary = summarizeYear(txs, year);
    expect(bs.profit).toBe(summary.profit);
  });

  it('翌年への繰越: 期首残高が前年末残高と一致し、元入金の恒等式が成り立つ', () => {
    const bs = buildBalanceSheet(txs, year, opening);
    const next = carryForwardOpening(bs);
    expect(next.year).toBe(2027);
    expect(next.bank).toBe(1_077_000);
    expect(next.receivable).toBe(220_000);
    // 翌年の元入金(資産-負債)= nextCapital
    const nextCapital = next.cash + next.bank + next.receivable - next.card - next.payable;
    expect(nextCapital).toBe(bs.nextCapital);
  });

  it('全仕訳が貸借一致している', () => {
    for (const e of deriveJournal(txs)) {
      const dr = e.debits.reduce((s, l) => s + l.amount, 0);
      const cr = e.credits.reduce((s, l) => s + l.amount, 0);
      expect(dr, `${e.description} の仕訳`).toBe(cr);
    }
  });
});

describe('generalLedger: 総勘定元帳', () => {
  it('普通預金の残高が入出金で増減する(資産は借方プラス)', () => {
    const entries = deriveJournal([
      tx({ date: '2026-01-25', description: '売上入金', type: 'income', account: 'sales', amount: 100000 }),
      tx({ date: '2026-02-10', description: '経費支払い', type: 'expense', amount: 30000 }),
    ]);
    const rows = generalLedger(entries, 'bank', 500000);
    expect(rows).toHaveLength(2);
    expect(rows[0].balance).toBe(600000);
    expect(rows[1].balance).toBe(570000);
    expect(rows[0].counter).toBe('売上(収入)金額');
  });

  it('複合仕訳の相手勘定は「諸口」になる', () => {
    const entries = deriveJournal([
      tx({
        date: '2026-02-15',
        description: '電気(按分)',
        type: 'expense',
        account: 'utilities',
        amount: 10000,
        businessAmount: 4000,
      }),
    ]);
    const rows = generalLedger(entries, 'bank', 0);
    expect(rows[0].counter).toBe('諸口');
    expect(rows[0].balance).toBe(-10000);
  });
});

describe('固定資産・棚卸の帳簿統合', () => {
  const year = 2026;
  const opening = { year, cash: 0, bank: 500000, receivable: 0, card: 0, payable: 0 };
  const pc: FixedAsset = {
    id: 'a1',
    name: 'ノートPC',
    acquiredDate: '2025-07-10',
    cost: 240000,
    method: 'straight',
    usefulLife: 4,
    businessRatio: 100,
    createdAt: 1,
  };
  const camera: FixedAsset = {
    id: 'a2',
    name: 'カメラ',
    acquiredDate: '2026-03-10',
    cost: 150000,
    method: 'lump3',
    usefulLife: 5,
    businessRatio: 100,
    createdAt: 2,
  };
  const inventories = [
    { year: 2025, amount: 80000 },
    { year: 2026, amount: 50000 },
  ];
  const txs: Transaction[] = [
    tx({ date: '2026-03-10', description: 'カメラ購入', type: 'expense', account: 'asset_purchase', amount: 150000 }),
    tx({ date: '2026-05-01', description: '商品仕入', type: 'expense', account: 'purchases', amount: 200000 }),
  ];

  it('減価償却・棚卸が貸借対照表と損益に反映され、貸借が一致する', () => {
    const bs = buildBalanceSheet(txs, year, opening, [pc, camera], inventories);
    const row = (rows: typeof bs.assets, id: string) => rows.find((r) => r.id === id)!;

    // 減価償却資産: 期首はPCの簿価210,000、期末は PC150,000 + カメラ100,000
    expect(row(bs.assets, 'fixed_asset').opening).toBe(210000);
    expect(row(bs.assets, 'fixed_asset').closing).toBe(250000);
    // 棚卸資産: 期首80,000(前年末)→ 期末50,000
    expect(row(bs.assets, 'inventory').opening).toBe(80000);
    expect(row(bs.assets, 'inventory').closing).toBe(50000);
    // 預金: 500,000 − 150,000(取得) − 200,000(仕入)
    expect(row(bs.assets, 'bank').closing).toBe(150000);
    // 元入金は棚卸・固定資産の期首も含む: 500,000 + 80,000 + 210,000
    expect(bs.capital).toBe(790000);
    // 損益: 仕入200,000 + 棚卸調整(80,000−50,000) + 償却費(60,000+50,000)
    expect(bs.profit).toBe(-(200000 + 30000 + 110000));
    expect(bs.balanced).toBe(true);
  });

  it('損益は summarizeYear と一致する', () => {
    const bs = buildBalanceSheet(txs, year, opening, [pc, camera], inventories);
    const summary = summarizeYear(txs, year, [pc, camera], inventories);
    expect(bs.profit).toBe(summary.profit);
  });

  it('「固定資産の取得」取引を忘れると貸借不一致になり検算で気づける', () => {
    const withoutPurchase = txs.filter((t) => t.account !== 'asset_purchase');
    const bs = buildBalanceSheet(withoutPurchase, year, opening, [pc, camera], inventories);
    expect(bs.balanced).toBe(false);
  });
});

describe('資金移動(fund_transfer)', () => {
  it('預金からの引き出し: (借)現金 / (貸)普通預金(損益に影響しない)', () => {
    const e = entryForTransaction(
      tx({ description: 'ATM引き出し', type: 'expense', account: 'fund_transfer', fund: 'bank', counterFund: 'cash', amount: 30000 }),
    )!;
    expect(e.debits).toEqual([{ account: 'cash', amount: 30000 }]);
    expect(e.credits).toEqual([{ account: 'bank', amount: 30000 }]);
  });

  it('現金の預け入れ(収入行): (借)普通預金 / (貸)現金', () => {
    const e = entryForTransaction(
      tx({ description: 'ATM預け入れ', type: 'income', account: 'fund_transfer', fund: 'bank', counterFund: 'cash', amount: 50000 }),
    )!;
    expect(e.debits).toEqual([{ account: 'bank', amount: 50000 }]);
    expect(e.credits).toEqual([{ account: 'cash', amount: 50000 }]);
  });

  it('counterFund 未設定は預金⇔現金を自動補完し、B/Sの残高が正しく動く', () => {
    const e = entryForTransaction(
      tx({ description: '引き出し', type: 'expense', account: 'fund_transfer', fund: 'bank', amount: 10000 }),
    )!;
    expect(e.debits[0].account).toBe('cash');

    const bs = buildBalanceSheet(
      [tx({ date: '2026-04-05', description: 'ATM', type: 'expense', account: 'fund_transfer', fund: 'bank', counterFund: 'cash', amount: 30000 })],
      2026,
      { year: 2026, cash: 0, bank: 100000, receivable: 0, card: 0, payable: 0 },
    );
    const closing = (id: string) => bs.assets.find((r) => r.id === id)!.closing;
    expect(closing('bank')).toBe(70000);
    expect(closing('cash')).toBe(30000);
    expect(bs.profit).toBe(0); // 損益に影響しない
    expect(bs.balanced).toBe(true);
  });
});

describe('繰延資産(開業費)の帳簿統合', () => {
  const kaigyo: FixedAsset = {
    id: 'k1',
    name: '開業費',
    acquiredDate: '2026-04-01',
    cost: 300000,
    method: 'deferred',
    usefulLife: 5,
    businessRatio: 100,
    deferredDep: [{ year: 2026, amount: 100000 }],
    createdAt: 1,
  };

  it('計上仕訳(開業費/事業主借)が自動起票され、償却後もB/Sが一致する', () => {
    const bs = buildBalanceSheet(
      [],
      2026,
      { year: 2026, cash: 0, bank: 500000, receivable: 0, card: 0, payable: 0 },
      [kaigyo],
      [],
    );
    const deferredRow = bs.assets.find((r) => r.id === 'deferred_asset')!;
    expect(deferredRow.opening).toBe(0); // 開業年の期首は0
    expect(deferredRow.closing).toBe(200000); // 300,000 − 100,000
    // 事業主借に開業費の計上30万が入る
    const invest = bs.equity.find((r) => r.id === 'owner_invest')!;
    expect(invest.closing).toBe(300000);
    // 償却10万は経費(減価償却費)として損益に載る
    expect(bs.profit).toBe(-100000);
    expect(bs.balanced).toBe(true);
  });

  it('翌年は期首残高に未償却残高が引き継がれる', () => {
    const bs = buildBalanceSheet(
      [],
      2027,
      { year: 2027, cash: 0, bank: 0, receivable: 0, card: 0, payable: 0 },
      [kaigyo],
      [],
    );
    const deferredRow = bs.assets.find((r) => r.id === 'deferred_asset')!;
    expect(deferredRow.opening).toBe(200000);
    expect(deferredRow.closing).toBe(200000); // 2027年は償却指定なし
    expect(bs.capital).toBe(200000); // 元入金に繰延資産の期首が含まれる
    expect(bs.balanced).toBe(true);
  });
});
