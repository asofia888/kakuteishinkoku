import { repaymentInterest } from './accounts';
import { periodSlipCandidates, summarizeYear, transactionsOfYear } from './aggregate';
import { acquisitionsInYear, isDeferred } from './assets';
import { negativeBalances } from './fundAccounts';
import { buildBalanceSheet } from './ledger';
import { rentBreakdown } from './rent';
import { AppData } from './types';

/**
 * 年分の決算・申告チェックリスト。
 * 帳簿のデータから各手順の状態を自動判定し、決算から申告・ロックまでの流れを1か所で示す
 * (どの画面で何をすればよいかが機能ごとのページに分かれていて見えにくいため)。
 */

export type CheckStatus = 'done' | 'todo' | 'warn' | 'na';

export interface CheckItem {
  id: string;
  label: string;
  status: CheckStatus;
  /** 状態の説明(件数・金額など) */
  detail: string;
  /** 対応する画面 */
  href: string;
}

export function yearEndChecklist(
  data: AppData,
  year: number,
  opts: { lastBackupDays: number | null },
): CheckItem[] {
  const txs = transactionsOfYear(data.transactions, year);
  const summary = summarizeYear(data.transactions, year, data.assets, data.inventories);
  const opening = data.openingBalances.find((o) => o.year === year);
  const bs = buildBalanceSheet(data.transactions, year, opening, data.assets, data.inventories);
  const items: CheckItem[] = [];
  const add = (id: string, label: string, status: CheckStatus, detail: string, href: string) =>
    items.push({ id, label, status, detail, href });

  add(
    'opening',
    '期首残高を登録する',
    opening ? 'done' : 'todo',
    opening ? '登録済み' : '1月1日時点の現金・預金・借入金などを登録(前年分があれば自動繰越)',
    '/books',
  );

  add(
    'classify',
    'すべての取引を仕訳・承認する',
    summary.unclassifiedCount > 0 || summary.unapprovedCount > 0 ? 'todo' : txs.length > 0 ? 'done' : 'na',
    summary.unclassifiedCount > 0 || summary.unapprovedCount > 0
      ? `未仕訳 ${summary.unclassifiedCount}件・未承認 ${summary.unapprovedCount}件`
      : txs.length > 0
        ? 'すべて仕訳・承認済み'
        : 'この年の取引はまだありません',
    '/transactions',
  );

  const slip = periodSlipCandidates(data.transactions, year);
  add(
    'slip',
    '12月分の売上を発生主義で計上する(期ズレ)',
    slip.length > 0 ? 'warn' : 'done',
    slip.length > 0
      ? `翌年1月に入金された売上が${slip.length}件。${year}年の仕事の対価なら請求書から「売掛計上」し、入金は「売掛金の回収」に`
      : '翌年1月の入金に期ズレ候補はありません',
    '/transactions',
  );

  const purchaseTx = txs.filter((t) => t.account === 'asset_purchase').reduce((s, t) => s + t.amount, 0);
  const registered = acquisitionsInYear(data.assets, year)
    .filter((a) => !isDeferred(a))
    .reduce((s, a) => s + a.cost, 0);
  add(
    'assets',
    '固定資産を台帳に登録する',
    purchaseTx === 0 && registered === 0 ? 'na' : purchaseTx === registered ? 'done' : 'warn',
    purchaseTx === 0 && registered === 0
      ? 'この年の取得はありません'
      : purchaseTx === registered
        ? '台帳と「固定資産の取得」の取引が一致'
        : `台帳の取得価額 ${registered.toLocaleString()}円 と取引 ${purchaseTx.toLocaleString()}円 が不一致`,
    '/assets',
  );

  const hasPurchases = summary.expenseLines.some((l) => l.account === 'purchases');
  const inventory = data.inventories.some((i) => i.year === year);
  add(
    'inventory',
    '年末の棚卸高を入力する',
    !hasPurchases ? 'na' : inventory ? 'done' : 'todo',
    !hasPurchases ? '仕入のない事業は不要' : inventory ? '入力済み' : '仕入がある事業は12/31の在庫を数えて入力',
    '/books',
  );

  const repayments = txs.filter((t) => t.account === 'loan_repayment');
  const noInterest = repayments.filter((t) => repaymentInterest(t) === 0).length;
  add(
    'loan',
    '借入金の返済の利息を入力する',
    repayments.length === 0 ? 'na' : noInterest > 0 ? 'todo' : 'done',
    repayments.length === 0
      ? '返済はありません'
      : noInterest > 0
        ? `利息が未入力の返済が${noInterest}件(返済予定表を見て入力)`
        : 'すべて入力済み',
    '/transactions',
  );

  const rent = rentBreakdown(data.transactions, year, data.rentPayees);
  const rentTotal = rent.rows.reduce((s, r) => s + r.gross, 0) + rent.unassigned.gross;
  add(
    'rent',
    '地代家賃の支払先を登録する(決算書の内訳)',
    rentTotal === 0 ? 'na' : data.rentPayees.length > 0 && rent.unassigned.count === 0 ? 'done' : 'todo',
    rentTotal === 0
      ? '地代家賃はありません'
      : data.rentPayees.length === 0
        ? '支払先の住所・氏名・物件が未登録'
        : rent.unassigned.count > 0
          ? `支払先に振り分けられない家賃が${rent.unassigned.count}件`
          : '登録済み',
    '/filing',
  );

  const negatives = negativeBalances(data.transactions, year, opening, data.fundAccounts);
  add(
    'negative',
    '現金・預金の残高がマイナスになっていない',
    negatives.length > 0 ? 'warn' : txs.length > 0 ? 'done' : 'na',
    negatives.length > 0
      ? negatives.map((n) => `${n.label}が${n.firstDate.slice(5).replace('-', '/')}にマイナス`).join('・') +
          '(記帳漏れの可能性)'
      : '問題なし',
    '/books',
  );

  const yearEndRecon = data.reconciliations.some((r) => r.date === `${year}-12-31`);
  add(
    'recon',
    '12月31日の残高を通帳・明細と照合する',
    yearEndRecon ? 'done' : 'todo',
    yearEndRecon ? '年末の照合を記録済み' : '帳簿・決算書ページの「残高照合」で12/31の残高を突き合わせる',
    '/books',
  );

  add(
    'balanced',
    '貸借対照表の貸借が一致している',
    bs.balanced ? 'done' : 'warn',
    bs.balanced ? '一致' : '不一致(固定資産の取得取引・期首残高を確認)',
    '/books',
  );

  const locked = data.lockedYears.includes(year);
  add(
    'lock',
    '申告後、帳簿を申告済みとしてロックする',
    locked ? 'done' : 'todo',
    locked ? 'ロック済み' : 'e-Tax で申告が済んだら、帳簿・決算書ページでロック',
    '/books',
  );

  add(
    'backup',
    'バックアップを保存する',
    opts.lastBackupDays !== null && opts.lastBackupDays < 30 ? 'done' : 'todo',
    opts.lastBackupDays === null
      ? 'まだ一度もありません'
      : opts.lastBackupDays === 0
        ? '今日保存済み'
        : `最後のバックアップは${opts.lastBackupDays}日前`,
    '/',
  );

  return items;
}
