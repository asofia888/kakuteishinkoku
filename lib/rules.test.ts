import { describe, expect, it } from 'vitest';
import { accountType, EXCLUDED_ACCOUNT } from './accounts';
import { applyRulesToTransactions, DEFAULT_RULES, matchRule } from './rules';
import { Rule, Transaction } from './types';

const rules: Rule[] = [
  { id: 'r1', keyword: '電気', account: 'utilities' },
  { id: 'r2', keyword: '電気工事', account: 'repairs' }, // r1より後 = 優先度低
  { id: 'r3', keyword: 'amazon', account: 'supplies' },
  { id: 'r4', keyword: '報酬', account: 'sales' },
  { id: 'r5', keyword: 'マルエツ', account: EXCLUDED_ACCOUNT },
];

describe('matchRule', () => {
  it('上にあるルールが優先される', () => {
    // 「電気工事」の摘要でも先頭の「電気」ルールが勝つ
    expect(matchRule('電気工事のお支払い', 'expense', rules)?.id).toBe('r1');
  });

  it('大文字小文字を区別しない', () => {
    expect(matchRule('AMAZON.CO.JP カイモノ', 'expense', rules)?.account).toBe('supplies');
  });

  it('全角英数・半角カナの表記ゆれを吸収する(NFKC正規化)', () => {
    // 全角英数の摘要 × 半角キーワード(実明細で最も多いパターン)
    expect(matchRule('ＡＭＡＺＯＮ.ＣＯ.ＪＰ', 'expense', rules)?.account).toBe('supplies');
    // 半角カナの摘要 × 全角カナのキーワード
    const kanaRules: Rule[] = [{ id: 'k1', keyword: 'ドコモ', account: 'communication' }];
    expect(matchRule('NTT ﾄﾞｺﾓ ﾂｳｼﾝﾘｮｳ', 'expense', kanaRules)?.account).toBe('communication');
    // 半角カナでキーワードを登録しても全角カナの摘要に当たる(逆方向)
    const hankakuRules: Rule[] = [{ id: 'k2', keyword: 'ﾔﾏﾄ', account: 'shipping' }];
    expect(matchRule('ヤマト運輸 発送料', 'expense', hankakuRules)?.account).toBe('shipping');
  });

  it('収入/支出と科目の種別が一致するルールだけが適用される', () => {
    // 「報酬」→売上(収入科目)のルールは支出の取引には当たらない
    expect(matchRule('報酬の返金', 'expense', rules)).toBeNull();
    expect(matchRule('振込 報酬', 'income', rules)?.account).toBe('sales');
  });

  it('「対象外(プライベート)」ルールは収入・支出どちらにも適用される', () => {
    expect(matchRule('マルエツ 食料品', 'expense', rules)?.account).toBe(EXCLUDED_ACCOUNT);
    expect(matchRule('マルエツ 返金', 'income', rules)?.account).toBe(EXCLUDED_ACCOUNT);
  });

  it('空のキーワードは無視される', () => {
    expect(matchRule('なんでも', 'expense', [{ id: 'x', keyword: '  ', account: 'misc' }])).toBeNull();
  });
});

describe('applyRulesToTransactions', () => {
  let seq = 0;
  function tx(over: Partial<Transaction> & Pick<Transaction, 'description' | 'type'>): Transaction {
    seq++;
    return {
      id: `t${seq}`,
      date: '2026-01-15',
      amount: 1000,
      account: null,
      approved: false,
      anbunApplied: false,
      businessAmount: 1000,
      source: 'csv',
      createdAt: seq,
      fund: 'bank',
      ...over,
    };
  }

  it('未仕訳の取引だけにルールを適用し、更新件数を返す', () => {
    const txs = [
      tx({ description: '東京電気料金', type: 'expense' }), // 適用される
      tx({ description: '東京電気料金', type: 'expense', account: 'misc', approved: true }), // 仕訳済み → 触らない
      tx({ description: '不明な支払い', type: 'expense' }), // ルールなし → 未仕訳のまま
    ];
    const { transactions, updated } = applyRulesToTransactions(txs, rules);
    expect(updated).toBe(1);
    expect(transactions[0].account).toBe('utilities');
    expect(transactions[0].approved).toBe(false); // 自動仕訳は要承認
    expect(transactions[1].account).toBe('misc');
    expect(transactions[1].approved).toBe(true);
    expect(transactions[2].account).toBeNull();
  });
});

describe('DEFAULT_RULES(初期ルールの安全性)', () => {
  it('誤仕訳を誘いやすいキーワードを含まない', () => {
    const keywords = DEFAULT_RULES.map((r) => r.keyword);
    // 「振込」は家族間送金・還付金まで売上にしてしまう
    expect(keywords).not.toContain('振込');
    // カフェ・居酒屋等は私的利用と区別できない
    expect(keywords).not.toContain('カフェ');
    expect(keywords).not.toContain('レストラン');
    expect(keywords).not.toContain('居酒屋');
  });

  it('すべてのルールが実在する勘定科目を指す', () => {
    for (const r of DEFAULT_RULES) {
      expect(accountType(r.account), `科目 ${r.account} が存在しない`).not.toBeNull();
    }
  });
});
