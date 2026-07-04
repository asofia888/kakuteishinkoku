import { accountType, EXCLUDED_ACCOUNT } from './accounts';
import { Rule, Transaction, TxType, uid } from './types';

/**
 * 照合用の正規化。実際の銀行・カード明細は半角カナ(ﾃﾞﾝｷ)や全角英数(ＡＭＡＺＯＮ)が
 * 主流のため、NFKC(半角カナ→全角カナ・全角英数→半角英数)+ 小文字化で
 * 表記ゆれを吸収してからキーワードを照合する。
 */
function normalizeForMatch(s: string): string {
  return s.normalize('NFKC').toLowerCase();
}

/**
 * 摘要にキーワードが含まれる最初のルールを返す(配列の並び順 = 優先順位)。
 * 大文字小文字・全角半角(NFKC)は区別しない。
 * 取引の収入/支出と勘定科目の種別が一致するルールのみ対象。
 * 「対象外(プライベート)」ルールは収入/支出のどちらにも適用できる。
 */
export function matchRule(description: string, type: TxType, rules: Rule[]): Rule | null {
  const text = normalizeForMatch(description);
  for (const rule of rules) {
    const keyword = normalizeForMatch(rule.keyword.trim());
    if (!keyword) continue;
    if (rule.account !== EXCLUDED_ACCOUNT && accountType(rule.account) !== type) continue;
    if (text.includes(keyword)) return rule;
  }
  return null;
}

/** ルールで勘定科目を推定する(該当なしは null = 未仕訳のまま) */
export function suggestAccount(description: string, type: TxType, rules: Rule[]): string | null {
  return matchRule(description, type, rules)?.account ?? null;
}

/** 未仕訳の取引にルールを一括適用し、更新された取引数を返す */
export function applyRulesToTransactions(
  transactions: Transaction[],
  rules: Rule[],
): { transactions: Transaction[]; updated: number } {
  let updated = 0;
  const next = transactions.map((t) => {
    if (t.account !== null) return t;
    const account = suggestAccount(t.description, t.type, rules);
    if (!account) return t;
    updated++;
    return { ...t, account, approved: false };
  });
  return { transactions: next, updated };
}

/**
 * 初回起動時に登録されるおすすめルール。
 * 誤仕訳は申告額を直接ゆがめるため、既定は「事業利用がほぼ確実な語」だけに絞る。
 * - 「振込」→売上 は入れない(家族間送金・還付金・事業主借まで売上にしてしまうため)
 * - 接待交際費(カフェ・居酒屋等)も入れない(私的な飲食と区別できないため。
 *   打ち合わせで使う店があれば店名で個別に追加を推奨)
 */
export const DEFAULT_RULES: Omit<Rule, 'id'>[] = [
  // 収入
  { keyword: '報酬', account: 'sales' },
  { keyword: '売上', account: 'sales' },
  // 水道光熱費
  { keyword: '電力', account: 'utilities' },
  { keyword: '電気', account: 'utilities' },
  { keyword: 'でんき', account: 'utilities' },
  { keyword: 'ガス', account: 'utilities' },
  { keyword: '水道', account: 'utilities' },
  // 通信費
  { keyword: 'docomo', account: 'communication' },
  { keyword: 'ソフトバンク', account: 'communication' },
  { keyword: 'kddi', account: 'communication' },
  { keyword: '楽天モバイル', account: 'communication' },
  { keyword: 'nuro', account: 'communication' },
  { keyword: 'ocn', account: 'communication' },
  { keyword: 'aws', account: 'communication' },
  { keyword: 'サーバ', account: 'communication' },
  { keyword: 'ドメイン', account: 'communication' },
  // 地代家賃
  { keyword: '家賃', account: 'rent' },
  { keyword: '賃料', account: 'rent' },
  { keyword: 'コワーキング', account: 'rent' },
  // 消耗品費
  { keyword: 'amazon', account: 'supplies' },
  { keyword: 'アマゾン', account: 'supplies' },
  { keyword: 'ヨドバシ', account: 'supplies' },
  { keyword: 'ビックカメラ', account: 'supplies' },
  { keyword: 'ダイソー', account: 'supplies' },
  // 旅費交通費
  { keyword: 'jr', account: 'travel' },
  { keyword: 'メトロ', account: 'travel' },
  { keyword: 'タクシー', account: 'travel' },
  { keyword: 'suica', account: 'travel' },
  { keyword: 'pasmo', account: 'travel' },
  { keyword: 'etc', account: 'travel' },
  { keyword: 'eneos', account: 'travel' },
  { keyword: '航空', account: 'travel' },
  { keyword: 'ホテル', account: 'travel' },
  // 新聞図書費
  { keyword: 'kindle', account: 'books' },
  { keyword: '書店', account: 'books' },
  { keyword: 'ブックス', account: 'books' },
  // 荷造運賃
  { keyword: 'ヤマト', account: 'shipping' },
  { keyword: '佐川', account: 'shipping' },
  { keyword: 'ゆうパック', account: 'shipping' },
  // 支払手数料
  { keyword: '手数料', account: 'fees' },
  { keyword: 'stripe', account: 'fees' },
  { keyword: 'paypal', account: 'fees' },
  // 広告宣伝費
  { keyword: '広告', account: 'advertising' },
  { keyword: 'ads', account: 'advertising' },
  // 外注工賃
  { keyword: '外注', account: 'outsourcing' },
  { keyword: 'ランサーズ', account: 'outsourcing' },
  { keyword: 'クラウドワークス', account: 'outsourcing' },
];

export function buildDefaultRules(): Rule[] {
  return DEFAULT_RULES.map((r) => ({ ...r, id: uid() }));
}
