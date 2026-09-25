import { transactionsOfYear } from './aggregate';
import { normalizeForMatch } from './rules';
import { RentPayee, Transaction } from './types';

/**
 * 青色申告決算書(2ページ)「地代家賃の内訳」。
 * 支払先ごとに、本年中の賃借料(支払った全額)と、そのうち必要経費算入額(家事按分後)を集計する。
 * 自宅兼事務所なら 賃借料 = 家賃の全額、必要経費算入額 = 事業分 になる。
 */

export interface RentBreakdownRow {
  payee: RentPayee;
  /** 本年中の賃借料(按分前の支払額) */
  gross: number;
  /** 左の賃借料のうち必要経費算入額(按分後) */
  business: number;
  count: number;
}

export interface RentBreakdown {
  rows: RentBreakdownRow[];
  /** どの支払先にも振り分けられなかった地代家賃 */
  unassigned: { gross: number; business: number; count: number };
}

/** 決算書の様式の行数(3行目以降は様式に書けないため、e-Tax 出力は2件まで) */
export const RENT_FORM_ROWS = 2;

/**
 * 取引を支払先へ振り分ける。
 * 1) 支払先のキーワードが摘要に含まれればその支払先(登録順で最初に一致したもの)
 * 2) 一致しなければ、キーワードが空の支払先がちょうど1件ならそこへ(「その他の家賃はここ」)
 * 3) 支払先が1件だけなら、キーワードに関係なくその支払先
 */
export function rentPayeeFor(t: Pick<Transaction, 'description'>, payees: RentPayee[]): RentPayee | undefined {
  if (payees.length === 1) return payees[0];
  const text = normalizeForMatch(t.description);
  const hit = payees.find((p) => p.keyword.trim() !== '' && text.includes(normalizeForMatch(p.keyword.trim())));
  if (hit) return hit;
  const catchAll = payees.filter((p) => p.keyword.trim() === '');
  return catchAll.length === 1 ? catchAll[0] : undefined;
}

/** 指定年の地代家賃の内訳(科目「地代家賃」の支出が対象) */
export function rentBreakdown(transactions: Transaction[], year: number, payees: RentPayee[]): RentBreakdown {
  const rows: RentBreakdownRow[] = payees.map((payee) => ({ payee, gross: 0, business: 0, count: 0 }));
  const unassigned = { gross: 0, business: 0, count: 0 };
  for (const t of transactionsOfYear(transactions, year)) {
    if (t.type !== 'expense' || t.account !== 'rent') continue;
    const payee = rentPayeeFor(t, payees);
    const target = payee ? rows.find((r) => r.payee.id === payee.id)! : unassigned;
    target.gross += t.amount;
    target.business += t.businessAmount;
    target.count++;
  }
  return { rows, unassigned };
}
