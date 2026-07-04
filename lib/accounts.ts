import { FundId, TxType } from './types';

export interface Account {
  id: string;
  label: string;
  type: TxType;
}

/** 決済手段(資金・債権債務)のマスタ。複式仕訳の相手勘定になる */
export const FUNDS: { id: FundId; label: string; short: string }[] = [
  { id: 'bank', label: '普通預金(銀行口座)', short: '預金' },
  { id: 'cash', label: '現金', short: '現金' },
  { id: 'card', label: 'クレジットカード(未払金)', short: 'カード' },
  { id: 'receivable', label: '売掛金(請求時の発生記録)', short: '売掛' },
  { id: 'payable', label: '買掛金・未払金(発生記録)', short: '買掛' },
  { id: 'owner', label: '事業主のプライベート資金', short: '私費' },
];

const fundById = new Map(FUNDS.map((f) => [f.id, f]));

export function fundLabel(id: FundId): string {
  return fundById.get(id)?.label ?? id;
}

export function fundShort(id: FundId): string {
  return fundById.get(id)?.short ?? id;
}

/** 収支種別ごとに選べる決済手段(収入をカード・買掛金で受け取ることはない) */
export function fundsOf(type: TxType): { id: FundId; label: string; short: string }[] {
  const ids: FundId[] =
    type === 'income'
      ? ['bank', 'cash', 'receivable', 'owner']
      : ['bank', 'cash', 'card', 'payable', 'owner'];
  return ids.map((id) => fundById.get(id)!);
}

/** 青色申告決算書(一般用)の科目に合わせた勘定科目マスタ */
export const ACCOUNTS: Account[] = [
  // ── 収入 ──
  { id: 'sales', label: '売上(収入)金額', type: 'income' },
  { id: 'misc_income', label: '雑収入', type: 'income' },

  // ── 経費 ──
  { id: 'purchases', label: '仕入高', type: 'expense' },
  { id: 'taxes_dues', label: '租税公課', type: 'expense' },
  { id: 'shipping', label: '荷造運賃', type: 'expense' },
  { id: 'utilities', label: '水道光熱費', type: 'expense' },
  { id: 'travel', label: '旅費交通費', type: 'expense' },
  { id: 'communication', label: '通信費', type: 'expense' },
  { id: 'advertising', label: '広告宣伝費', type: 'expense' },
  { id: 'entertainment', label: '接待交際費', type: 'expense' },
  { id: 'insurance', label: '損害保険料', type: 'expense' },
  { id: 'repairs', label: '修繕費', type: 'expense' },
  { id: 'supplies', label: '消耗品費', type: 'expense' },
  { id: 'depreciation', label: '減価償却費', type: 'expense' },
  { id: 'welfare', label: '福利厚生費', type: 'expense' },
  { id: 'salaries', label: '給料賃金', type: 'expense' },
  { id: 'outsourcing', label: '外注工賃', type: 'expense' },
  { id: 'interest', label: '利子割引料', type: 'expense' },
  { id: 'rent', label: '地代家賃', type: 'expense' },
  { id: 'fees', label: '支払手数料', type: 'expense' },
  { id: 'books', label: '新聞図書費', type: 'expense' },
  { id: 'misc', label: '雑費', type: 'expense' },
];

const byId = new Map(ACCOUNTS.map((a) => [a.id, a]));

/**
 * 決済・振替用の特別科目。損益(売上・経費)には影響せず、
 * 資産・負債の間の資金移動として複式仕訳される。
 * 例: 売掛金を計上した請求の入金、カード利用額の口座引落し。
 */
export const SETTLEMENT_ACCOUNTS: Account[] = [
  { id: 'ar_collect', label: '売掛金の回収(振替)', type: 'income' },
  { id: 'card_payment', label: 'カード代金の引落し(振替)', type: 'expense' },
  { id: 'ap_payment', label: '買掛金・未払金の支払い(振替)', type: 'expense' },
  // 10万円以上の備品等の購入。経費ではなく資産計上し、固定資産台帳の償却で経費化する
  { id: 'asset_purchase', label: '固定資産の取得(振替)', type: 'expense' },
];

const settlementById = new Map(SETTLEMENT_ACCOUNTS.map((a) => [a.id, a]));

export function isSettlement(account: string | null): boolean {
  return account !== null && settlementById.has(account);
}

export function settlementsOf(type: TxType): Account[] {
  return SETTLEMENT_ACCOUNTS.filter((a) => a.type === type);
}

/**
 * 事業と無関係な取引(私的な買い物・家族間送金など)に付ける特別な区分ID。
 * 勘定科目マスタには含めず、集計・未仕訳/未承認アラートの対象から除外される。
 */
export const EXCLUDED_ACCOUNT = 'excluded';
export const EXCLUDED_LABEL = '対象外(プライベート)';

export function isExcluded(account: string | null): boolean {
  return account === EXCLUDED_ACCOUNT;
}

export function accountLabel(id: string | null): string {
  if (id === null) return '未仕訳';
  if (id === EXCLUDED_ACCOUNT) return EXCLUDED_LABEL;
  return byId.get(id)?.label ?? settlementById.get(id)?.label ?? id;
}

export function accountType(id: string): TxType | null {
  return byId.get(id)?.type ?? settlementById.get(id)?.type ?? null;
}

export function accountsOf(type: TxType): Account[] {
  return ACCOUNTS.filter((a) => a.type === type);
}

export const INCOME_ACCOUNTS = accountsOf('income');
export const EXPENSE_ACCOUNTS = accountsOf('expense');
