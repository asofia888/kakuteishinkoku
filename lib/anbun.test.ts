import { describe, expect, it } from 'vitest';
import { EXCLUDED_ACCOUNT } from './accounts';
import { applyAnbun } from './anbun';
import { AnbunSetting, Transaction } from './types';

let seq = 0;
function tx(
  over: Partial<Transaction> & Pick<Transaction, 'date' | 'amount' | 'type'>,
): Transaction {
  seq++;
  return {
    id: `t${seq}`,
    description: '',
    account: null,
    approved: false,
    anbunApplied: false,
    businessAmount: over.amount,
    source: 'csv',
    createdAt: seq,
    fund: 'bank',
    ...over,
  };
}

const percent40: AnbunSetting = { id: 's1', account: 'utilities', type: 'percent', value: 40 };
const fixed30k: AnbunSetting = { id: 's2', account: 'rent', type: 'fixed', value: 30000 };

describe('applyAnbun: percent(事業割合)', () => {
  it('金額 × 割合を四捨五入で経費計上する', () => {
    const txs = [tx({ date: '2026-01-15', amount: 10000, type: 'expense', account: 'utilities' })];
    const out = applyAnbun(txs, [percent40]);
    expect(out[0].businessAmount).toBe(4000);
    expect(out[0].anbunApplied).toBe(true);
  });

  it('端数は四捨五入(999円 × 33% = 330円)', () => {
    const txs = [tx({ date: '2026-01-15', amount: 999, type: 'expense', account: 'utilities' })];
    const out = applyAnbun(txs, [{ ...percent40, value: 33 }]);
    expect(out[0].businessAmount).toBe(330);
  });

  it('100%を超える設定値は100%に丸める', () => {
    const txs = [tx({ date: '2026-01-15', amount: 10000, type: 'expense', account: 'utilities' })];
    const out = applyAnbun(txs, [{ ...percent40, value: 150 }]);
    expect(out[0].businessAmount).toBe(10000);
  });
});

describe('applyAnbun: fixed(月次固定額)', () => {
  it('月あたりの固定額まで経費計上し、超過分は事業主貸になる', () => {
    const txs = [tx({ date: '2026-01-27', amount: 80000, type: 'expense', account: 'rent' })];
    const out = applyAnbun(txs, [fixed30k]);
    expect(out[0].businessAmount).toBe(30000); // 事業主貸 = 50,000
  });

  it('同一月の複数取引は日付順に固定額へ充当する', () => {
    // 入力順は15日→1日だが、充当は1日が先
    const txs = [
      tx({ date: '2026-01-15', amount: 50000, type: 'expense', account: 'rent' }),
      tx({ date: '2026-01-01', amount: 50000, type: 'expense', account: 'rent' }),
    ];
    const out = applyAnbun(txs, [{ ...fixed30k, value: 60000 }]);
    // 元の並び順は保たれる
    expect(out[0].date).toBe('2026-01-15');
    expect(out[0].businessAmount).toBe(10000); // 60,000 − 先に充当された50,000
    expect(out[1].businessAmount).toBe(50000);
  });

  it('月が変わると充当額はリセットされる', () => {
    const txs = [
      tx({ date: '2026-01-27', amount: 80000, type: 'expense', account: 'rent' }),
      tx({ date: '2026-02-27', amount: 80000, type: 'expense', account: 'rent' }),
    ];
    const out = applyAnbun(txs, [fixed30k]);
    expect(out[0].businessAmount).toBe(30000);
    expect(out[1].businessAmount).toBe(30000);
  });

  it('負の固定額は0円として扱う', () => {
    const txs = [tx({ date: '2026-01-27', amount: 80000, type: 'expense', account: 'rent' })];
    const out = applyAnbun(txs, [{ ...fixed30k, value: -5000 }]);
    expect(out[0].businessAmount).toBe(0);
  });
});

describe('applyAnbun: 対象外の取引', () => {
  it('収入・未仕訳・設定のない科目・対象外(プライベート)は全額のまま', () => {
    const txs = [
      tx({ date: '2026-01-25', amount: 320000, type: 'income', account: 'sales' }),
      tx({ date: '2026-01-10', amount: 5000, type: 'expense', account: null }),
      tx({ date: '2026-01-11', amount: 5000, type: 'expense', account: 'supplies' }),
      tx({ date: '2026-01-12', amount: 5000, type: 'expense', account: EXCLUDED_ACCOUNT }),
    ];
    const out = applyAnbun(txs, [percent40, fixed30k]);
    for (const t of out) {
      expect(t.businessAmount).toBe(t.amount);
      expect(t.anbunApplied).toBe(false);
    }
  });

  it('値が変わらない取引は同じオブジェクト参照を返す(不要な再描画防止)', () => {
    const txs = [tx({ date: '2026-01-25', amount: 320000, type: 'income', account: 'sales' })];
    const out = applyAnbun(txs, [percent40]);
    expect(out[0]).toBe(txs[0]);
  });
});
