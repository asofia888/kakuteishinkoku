import { buildBalanceSheet, journalForYear } from './ledger';
import { AppData } from './types';

/**
 * 申告済みの年のロック。
 * ロック中の年は「帳簿の数字(仕訳帳と貸借対照表)が変わる変更」を受け付けない。
 * 取引・固定資産・棚卸・期首残高・按分設定など、どの画面からの変更でも
 * 変更前後の帳簿を比べて判定するため、機能ごとの個別チェックが要らない。
 * 数字に影響しない変更(承認の付け外し・証憑の添付・請求書のメモなど)はロック中でもできる。
 */

type BookSource = Pick<AppData, 'transactions' | 'assets' | 'inventories' | 'openingBalances'>;

// 同じデータ(オブジェクト)の指紋は使い回す。変更のたびに変更前の年を計算し直さないため
const cache = new WeakMap<object, Map<number, string>>();

/** 指定年の帳簿の指紋。仕訳(日付・摘要・借方・貸方)と貸借対照表の全行から作る */
export function yearFingerprint(d: BookSource, year: number): string {
  let byYear = cache.get(d);
  const hit = byYear?.get(year);
  if (hit !== undefined) return hit;
  const opening = d.openingBalances.find((ob) => ob.year === year);
  const journal = journalForYear(d.transactions, year, d.assets, d.inventories).map((e) => [
    e.date,
    e.description,
    e.debits,
    e.credits,
  ]);
  const bs = buildBalanceSheet(d.transactions, year, opening, d.assets, d.inventories);
  const fp = JSON.stringify([journal, bs.assets, bs.liabilities, bs.equity]);
  if (!byYear) {
    byYear = new Map();
    cache.set(d, byYear);
  }
  byYear.set(year, fp);
  return fp;
}

/** 変更前(prev)にロックされていた年のうち、変更後(next)で帳簿の数字が変わる年 */
export function changedLockedYears(prev: AppData, next: AppData): number[] {
  return prev.lockedYears.filter((y) => yearFingerprint(prev, y) !== yearFingerprint(next, y));
}

/** 取引日(YYYY-MM-DD)がロック中の年か */
export function isLockedDate(lockedYears: number[], date: string): boolean {
  return lockedYears.includes(Number(date.slice(0, 4)));
}
