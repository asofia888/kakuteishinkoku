import { describe, expect, it } from 'vitest';
import { rentBreakdown, rentPayeeFor } from './rent';
import { RentPayee, Transaction } from './types';

let seq = 0;
function tx(over: Partial<Transaction> & Pick<Transaction, 'date' | 'description' | 'amount'>): Transaction {
  seq++;
  return {
    id: `t${seq}`,
    type: 'expense',
    account: 'rent',
    approved: true,
    anbunApplied: false,
    businessAmount: over.amount,
    source: 'csv',
    createdAt: seq,
    fund: 'bank',
    ...over,
  };
}
const payee = (id: string, keyword = ''): RentPayee => ({
  id,
  name: `支払先${id}`,
  address: '東京都',
  property: '事務所',
  keyword,
  createdAt: 0,
});

describe('rentPayeeFor: 地代家賃の支払先への振り分け', () => {
  it('支払先が1件なら、キーワードに関係なくその支払先', () => {
    expect(rentPayeeFor({ description: '何でも' }, [payee('a', 'ﾔﾏﾀﾞ')])?.id).toBe('a');
  });

  it('キーワード一致(半角カナ・全角英数の表記ゆれを吸収)→ キーワードなしの支払先 → 振り分けなし', () => {
    const payees = [payee('home'), payee('parking', 'ﾁｭｳｼｬｼﾞｮｳ'), payee('office', 'ＡＢＣ')];
    expect(rentPayeeFor({ description: '振込 チュウシャジョウ' }, payees)?.id).toBe('parking');
    expect(rentPayeeFor({ description: 'ﾌﾘｺﾐ abc ﾋﾞﾙ' }, payees)?.id).toBe('office');
    expect(rentPayeeFor({ description: '家賃 5月分' }, payees)?.id).toBe('home');
    // キーワードなしが2件以上あると決められない
    expect(rentPayeeFor({ description: '家賃' }, [payee('x'), payee('y')])).toBeUndefined();
  });
});

describe('rentBreakdown: 地代家賃の内訳', () => {
  it('支払先ごとに賃借料(按分前)と必要経費算入額(按分後)を集計する', () => {
    const txs = [
      tx({ date: '2026-01-25', description: '家賃 1月', amount: 100000, businessAmount: 40000 }),
      tx({ date: '2026-02-25', description: '家賃 2月', amount: 100000, businessAmount: 40000 }),
      tx({ date: '2026-02-27', description: '月極 ﾁｭｳｼｬｼﾞｮｳ', amount: 15000 }),
      tx({ date: '2025-12-25', description: '家賃 前年', amount: 100000 }), // 別の年
      tx({ date: '2026-03-01', description: '消耗品', amount: 3000, account: 'supplies' }), // 地代家賃以外
    ];
    const b = rentBreakdown(txs, 2026, [payee('home'), payee('parking', 'ﾁｭｳｼｬｼﾞｮｳ')]);
    expect(b.rows.map((r) => [r.payee.id, r.gross, r.business, r.count])).toEqual([
      ['home', 200000, 80000, 2],
      ['parking', 15000, 15000, 1],
    ]);
    expect(b.unassigned).toEqual({ gross: 0, business: 0, count: 0 });
  });

  it('振り分けられない取引は未割当に集計する(支払先が未登録の場合も)', () => {
    const txs = [tx({ date: '2026-01-25', description: '家賃', amount: 80000 })];
    expect(rentBreakdown(txs, 2026, []).unassigned).toEqual({ gross: 80000, business: 80000, count: 1 });
    const b = rentBreakdown(txs, 2026, [payee('a', 'ｱ'), payee('b', 'ｲ')]);
    expect(b.unassigned.count).toBe(1);
  });
});
