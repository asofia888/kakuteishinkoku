import { accountLabel } from './accounts';

/**
 * 青色申告決算書(一般用)・損益計算書の経費欄の定義。
 * 転記ガイドの表示・様式イメージ(印刷)・e-Tax(帳票KOA210)出力の3箇所は
 * すべてこの表から導出する。様式改定(丸数字や科目の変更)時はここだけを直す。
 */
export interface KessanshoExpenseDef {
  /** 様式の欄番号(丸数字) */
  no: string;
  /** 様式の科目名 */
  label: string;
  /** 対応する帳簿の勘定科目ID(様式にあるが帳簿にない欄は null) */
  account: string | null;
  /** e-Tax(帳票KOA210 v11.0)の項目タグ */
  xtxTag: string;
}

/** 固定欄の科目(⑧〜㉔と㉛雑費)。様式の並び順 */
export const KESSANSHO_EXPENSES: KessanshoExpenseDef[] = [
  { no: '⑧', label: '租税公課', account: 'taxes_dues', xtxTag: 'AMF00190' },
  { no: '⑨', label: '荷造運賃', account: 'shipping', xtxTag: 'AMF00200' },
  { no: '⑩', label: '水道光熱費', account: 'utilities', xtxTag: 'AMF00210' },
  { no: '⑪', label: '旅費交通費', account: 'travel', xtxTag: 'AMF00220' },
  { no: '⑫', label: '通信費', account: 'communication', xtxTag: 'AMF00230' },
  { no: '⑬', label: '広告宣伝費', account: 'advertising', xtxTag: 'AMF00240' },
  { no: '⑭', label: '接待交際費', account: 'entertainment', xtxTag: 'AMF00250' },
  { no: '⑮', label: '損害保険料', account: 'insurance', xtxTag: 'AMF00260' },
  { no: '⑯', label: '修繕費', account: 'repairs', xtxTag: 'AMF00270' },
  { no: '⑰', label: '消耗品費', account: 'supplies', xtxTag: 'AMF00280' },
  { no: '⑱', label: '減価償却費', account: 'depreciation', xtxTag: 'AMF00290' },
  { no: '⑲', label: '福利厚生費', account: 'welfare', xtxTag: 'AMF00300' },
  { no: '⑳', label: '給料賃金', account: 'salaries', xtxTag: 'AMF00310' },
  { no: '㉑', label: '外注工賃', account: 'outsourcing', xtxTag: 'AMF00320' },
  { no: '㉒', label: '利子割引料', account: 'interest', xtxTag: 'AMF00330' },
  { no: '㉓', label: '地代家賃', account: 'rent', xtxTag: 'AMF00340' },
  { no: '㉔', label: '貸倒金', account: null, xtxTag: 'AMF00350' },
  { no: '㉛', label: '雑費', account: 'misc', xtxTag: 'AMF00370' },
];

/** 空欄科目(㉕〜㉚)の欄番号。帳簿の固定欄以外の経費科目をここへ書く */
export const KESSANSHO_BLANK_NOS = ['㉕', '㉖', '㉗', '㉘', '㉙', '㉚'] as const;

/** 固定欄に対応する勘定科目(これ以外の経費は空欄科目へ)。仕入は売上原価欄なので除外 */
const FIXED_ACCOUNTS = new Set<string>([
  ...KESSANSHO_EXPENSES.flatMap((e) => (e.account ? [e.account] : [])),
  'purchases',
]);

export interface KessanshoExpenseValues {
  /** 固定欄(⑧〜㉔・㉛)と金額(帳簿に無い欄・計上なしは null = 様式の空欄) */
  fixed: (KessanshoExpenseDef & { amount: number | null })[];
  /** 空欄科目(㉕〜㉚)に書く科目と金額(計上があるものだけ) */
  extras: { label: string; amount: number }[];
}

/** 年間集計(expenseLines)から決算書の経費欄の値を組み立てる */
export function kessanshoExpenseValues(
  expenseLines: { account: string; business: number }[],
): KessanshoExpenseValues {
  const byAccount = new Map(expenseLines.map((l) => [l.account, l.business]));
  return {
    fixed: KESSANSHO_EXPENSES.map((e) => ({
      ...e,
      amount: e.account !== null && (byAccount.get(e.account) ?? 0) > 0 ? byAccount.get(e.account)! : null,
    })),
    extras: expenseLines
      .filter((l) => !FIXED_ACCOUNTS.has(l.account) && l.business > 0)
      .map((l) => ({ label: accountLabel(l.account), amount: l.business })),
  };
}
