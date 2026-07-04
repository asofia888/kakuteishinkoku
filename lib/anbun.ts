import { AnbunSetting, Transaction } from './types';

/**
 * 家事按分を全取引へ一括適用し、businessAmount(事業計上額)と
 * anbunApplied(按分適用済みフラグ)を再計算した新しい配列を返す。
 *
 * - percent: 各取引ごとに 金額 × 事業割合(%) を経費計上。端数は四捨五入。
 * - fixed:   同じ勘定科目の「同一月」の取引を日付順に見て、月あたりの
 *            固定額(value円)に達するまで経費計上する。超えた分は事業主貸。
 *            (例: 家賃80,000円/月・固定30,000円 → 経費30,000円 + 事業主貸50,000円)
 *
 * 経費計上されない残額(amount - businessAmount)が「事業主貸」となる。
 * 収入・未仕訳・按分設定のない科目は全額(businessAmount = amount)のまま。
 */
export function applyAnbun(
  transactions: Transaction[],
  settings: AnbunSetting[],
): Transaction[] {
  const settingByAccount = new Map<string, AnbunSetting>();
  for (const s of settings) settingByAccount.set(s.account, s);

  // fixed(月次固定額)は同一月内での累計が必要なため、
  // 「科目|YYYY-MM」ごとに日付順で充当していく。
  const fixedUsed = new Map<string, number>(); // key: account|YYYY-MM → 充当済み額

  // 元の並びを保ったまま返すため、処理順(日付昇順)を別配列で作る
  const order = [...transactions].sort(
    (a, b) => a.date.localeCompare(b.date) || a.createdAt - b.createdAt || a.id.localeCompare(b.id),
  );

  const resultById = new Map<string, Transaction>();
  for (const t of order) {
    // 収入・未仕訳は按分対象外
    if (t.type !== 'expense' || t.account === null) {
      resultById.set(t.id, withAnbun(t, t.amount, false));
      continue;
    }
    const setting = settingByAccount.get(t.account);
    if (!setting) {
      resultById.set(t.id, withAnbun(t, t.amount, false));
      continue;
    }
    if (setting.type === 'percent') {
      const ratio = clamp(setting.value, 0, 100);
      resultById.set(t.id, withAnbun(t, Math.round((t.amount * ratio) / 100), true));
    } else {
      // fixed: 月あたり value 円まで経費計上
      const monthKey = `${t.account}|${t.date.slice(0, 7)}`;
      const used = fixedUsed.get(monthKey) ?? 0;
      const budget = Math.max(0, setting.value);
      const business = clamp(budget - used, 0, t.amount);
      fixedUsed.set(monthKey, used + business);
      resultById.set(t.id, withAnbun(t, business, true));
    }
  }

  return transactions.map((t) => resultById.get(t.id) ?? t);
}

/** businessAmount が変わらない場合は同じオブジェクトを返す(不要な再描画を防ぐ) */
function withAnbun(t: Transaction, businessAmount: number, anbunApplied: boolean): Transaction {
  if (t.businessAmount === businessAmount && t.anbunApplied === anbunApplied) return t;
  return { ...t, businessAmount, anbunApplied };
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}
