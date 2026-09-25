import { transactionsOfYear } from './aggregate';
import { deriveJournal, JournalEntry, JournalLine, ledgerLineLabel } from './ledger';
import { FundAccount, OpeningBalance, Transaction } from './types';

/**
 * 口座・カードの補助科目。
 * 普通預金・カード未払金を口座ごとに分けて、補助元帳・残高照合・期首残高を管理する。
 * 貸借対照表は従来どおり合計で表示し(様式に口座別の欄はない)、仕訳の行に
 * 口座 ID(sub)を持たせて集計時に振り分ける。口座の指定がない行(既存データ・
 * 口座を1つしか使わない人)は、その資金で最初に登録した口座に属するものとして扱う。
 */

export type SubFund = 'bank' | 'card';
export const SUB_FUNDS: SubFund[] = ['bank', 'card'];

export const SUB_FUND_LABELS: Record<SubFund | 'cash', string> = {
  cash: '現金',
  bank: '普通預金',
  card: 'カード未払金',
};

/** 指定の資金に登録された口座(登録順。先頭が既定の口座) */
export function subAccountsOf(list: FundAccount[], fund: SubFund): FundAccount[] {
  return list.filter((a) => a.fund === fund);
}

/** 同じ資金に口座が2つ以上あり、口座ごとに分けて管理しているか */
export function hasMultiple(list: FundAccount[], fund: string): boolean {
  return (fund === 'bank' || fund === 'card') && subAccountsOf(list, fund).length >= 2;
}

/**
 * 仕訳行・取引の口座を決める。その資金に登録済みの ID ならそれ、
 * 未指定・削除済みなら既定(最初)の口座。口座が1つも登録されていなければ undefined
 */
export function resolveSub(list: FundAccount[], fund: SubFund, sub?: string): string | undefined {
  const subs = subAccountsOf(list, fund);
  if (subs.length === 0) return undefined;
  return sub !== undefined && subs.some((a) => a.id === sub) ? sub : subs[0].id;
}

/** 仕訳の行が指定の口座のものかを判定する関数(補助元帳・残高照合用) */
export function lineMatcher(
  list: FundAccount[],
  fund: SubFund,
  subId: string,
): (l: JournalLine) => boolean {
  return (l) => l.account === fund && resolveSub(list, fund, l.sub) === subId;
}

/**
 * 期首残高のうち指定の口座の分。口座別の登録(subBalances)があればそれを使い、
 * なければ既定の口座に「資金の合計 − 他の口座の登録分」を寄せる(口座を後から足した場合)
 */
export function subOpening(
  ob: OpeningBalance | undefined,
  list: FundAccount[],
  fund: SubFund,
  subId: string,
): number {
  if (!ob) return 0;
  const explicit = ob.subBalances?.[subId];
  if (explicit !== undefined) return explicit;
  const subs = subAccountsOf(list, fund);
  if (subs[0]?.id !== subId) return 0;
  const others = subs.slice(1).reduce((s, a) => s + (ob.subBalances?.[a.id] ?? 0), 0);
  return ob[fund] - others;
}

/** 仕訳の行の表示名(口座を分けている資金は「普通預金(楽天銀行)」のように口座名を付ける) */
export function lineLabel(l: JournalLine, list: FundAccount[]): string {
  const base = ledgerLineLabel(l.account);
  if (!hasMultiple(list, l.account)) return base;
  const id = resolveSub(list, l.account as SubFund, l.sub);
  const name = list.find((a) => a.id === id)?.name;
  return name ? `${base}(${name})` : base;
}

/** 行の集計(資産の現金・預金は借方プラス、負債のカード未払金は貸方プラス) */
function movement(entries: JournalEntry[], fund: 'cash' | SubFund, match: (l: JournalLine) => boolean): number {
  let v = 0;
  for (const e of entries) {
    const dr = e.debits.filter(match).reduce((s, l) => s + l.amount, 0);
    const cr = e.credits.filter(match).reduce((s, l) => s + l.amount, 0);
    v += fund === 'card' ? cr - dr : dr - cr;
  }
  return v;
}

/**
 * 年末時点の口座ごとの残高(翌年の期首残高への繰越用)。
 * 口座を2つ以上に分けている資金だけを返す(1つなら資金の合計がそのまま口座の残高)
 */
export function subClosingBalances(
  transactions: Transaction[],
  year: number,
  opening: OpeningBalance | undefined,
  list: FundAccount[],
): Record<string, number> {
  const entries = deriveJournal(transactionsOfYear(transactions, year));
  const out: Record<string, number> = {};
  for (const fund of SUB_FUNDS) {
    if (!hasMultiple(list, fund)) continue;
    for (const a of subAccountsOf(list, fund)) {
      out[a.id] = subOpening(opening, list, fund, a.id) + movement(entries, fund, lineMatcher(list, fund, a.id));
    }
  }
  return out;
}

// ── 残高照合 ──

/** 照合できる資金(現金・口座ごとの普通預金・カードごとの未払金) */
export interface ReconTarget {
  /** Reconciliation.target に保存する値('cash' / 'bank' / 'card' / 口座 ID) */
  id: string;
  fund: 'cash' | SubFund;
  label: string;
}

export function reconTargets(list: FundAccount[]): ReconTarget[] {
  const out: ReconTarget[] = [{ id: 'cash', fund: 'cash', label: '現金' }];
  for (const fund of SUB_FUNDS) {
    const subs = subAccountsOf(list, fund);
    if (subs.length === 0) out.push({ id: fund, fund, label: SUB_FUND_LABELS[fund] });
    for (const a of subs) out.push({ id: a.id, fund, label: `${SUB_FUND_LABELS[fund]}(${a.name})` });
  }
  return out;
}

/** 照合の対象を解決する(口座が削除されていれば null) */
export function resolveReconTarget(list: FundAccount[], target: string): ReconTarget | null {
  if (target === 'cash' || target === 'bank' || target === 'card') {
    return { id: target, fund: target, label: SUB_FUND_LABELS[target] };
  }
  const a = list.find((x) => x.id === target);
  return a ? { id: a.id, fund: a.fund, label: `${SUB_FUND_LABELS[a.fund]}(${a.name})` } : null;
}

/**
 * 指定日(その日の取引まで含む)時点の帳簿残高。
 * その年の期首残高 + 1/1〜指定日の仕訳の増減。カードは未払残高(貸方プラス)。
 * 口座が削除されている場合は null
 */
export function bookBalanceAt(
  transactions: Transaction[],
  openingBalances: OpeningBalance[],
  list: FundAccount[],
  target: string,
  date: string,
): { balance: number; hasOpening: boolean } | null {
  const t = resolveReconTarget(list, target);
  if (!t) return null;
  const year = Number(date.slice(0, 4));
  const ob = openingBalances.find((o) => o.year === year);
  const entries = deriveJournal(transactionsOfYear(transactions, year)).filter((e) => e.date <= date);
  const wholeFund = t.id === t.fund;
  const match =
    wholeFund || t.fund === 'cash'
      ? (l: JournalLine) => l.account === t.fund
      : lineMatcher(list, t.fund, t.id);
  const opening = !ob
    ? 0
    : wholeFund || t.fund === 'cash'
      ? ob[t.fund]
      : subOpening(ob, list, t.fund, t.id);
  return { balance: opening + movement(entries, t.fund, match), hasOpening: !!ob };
}

// ── 残高のマイナス検出 ──

export interface NegativeBalance {
  /** 'cash' / 'bank' / 口座 ID */
  target: string;
  label: string;
  /** 初めて日末残高がマイナスになった日 */
  firstDate: string;
  /** 年間で最も低い日末残高 */
  lowest: number;
  lowestDate: string;
}

/**
 * 現金・普通預金(口座ごと)の日末残高がマイナスになる日を探す。
 * 現金のマイナスは帳簿上ありえず、記帳漏れ(私費での立替え=事業主借の計上漏れ、
 * 売上の現金入金の漏れ、日付の誤り)の典型として税務調査でも指摘されやすい
 */
export function negativeBalances(
  transactions: Transaction[],
  year: number,
  opening: OpeningBalance | undefined,
  list: FundAccount[],
): NegativeBalance[] {
  const entries = deriveJournal(transactionsOfYear(transactions, year));
  const targets: { target: string; label: string; open: number; match: (l: JournalLine) => boolean }[] = [
    { target: 'cash', label: '現金', open: opening?.cash ?? 0, match: (l) => l.account === 'cash' },
  ];
  if (hasMultiple(list, 'bank')) {
    for (const a of subAccountsOf(list, 'bank')) {
      targets.push({
        target: a.id,
        label: `普通預金(${a.name})`,
        open: subOpening(opening, list, 'bank', a.id),
        match: lineMatcher(list, 'bank', a.id),
      });
    }
  } else {
    targets.push({ target: 'bank', label: '普通預金', open: opening?.bank ?? 0, match: (l) => l.account === 'bank' });
  }

  const out: NegativeBalance[] = [];
  for (const t of targets) {
    let balance = t.open;
    let found: NegativeBalance | null = null;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      balance += movement([e], 'cash', t.match);
      // 同じ日の取引をすべて反映した日末の残高で判定する(日中の順序の違いで誤検出しない)
      if (entries[i + 1]?.date === e.date) continue;
      if (balance < 0) {
        if (!found) found = { target: t.target, label: t.label, firstDate: e.date, lowest: balance, lowestDate: e.date };
        else if (balance < found.lowest) {
          found.lowest = balance;
          found.lowestDate = e.date;
        }
      }
    }
    if (found) out.push(found);
  }
  return out;
}
