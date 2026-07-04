import { accountLabel, EXPENSE_ACCOUNTS, INCOME_ACCOUNTS, isExcluded, isSettlement } from './accounts';
import { yearDepreciationTotals } from './assets';
import { FixedAsset, InventoryCount, Transaction } from './types';

export interface ExpenseLine {
  account: string;
  label: string;
  /** 按分前の支払合計 */
  gross: number;
  /** 家事按分適用後の経費計上額 */
  business: number;
  /** 事業主貸(gross - business) */
  owner: number;
}

export interface IncomeLine {
  account: string;
  label: string;
  total: number;
}

export interface YearSummary {
  year: number;
  /** 月別売上(収入合計)。index 0 = 1月 */
  monthlySales: number[];
  /** 売上(収入)の年間合計 */
  totalSales: number;
  /** 収入の科目別内訳 */
  incomeLines: IncomeLine[];
  /** 経費の科目別内訳(取引のある科目のみ) */
  expenseLines: ExpenseLine[];
  /** 経費の年間合計(按分後) */
  totalExpense: number;
  /** 経費の按分前合計 */
  totalGross: number;
  /** 事業主貸の合計 */
  totalOwner: number;
  /** 差引金額 = 売上 - 経費(青色申告特別控除前の所得金額) */
  profit: number;
  /** 未仕訳の件数(アラート用) */
  unclassifiedCount: number;
  /** 仕訳済みだが未承認の件数(アラート用) */
  unapprovedCount: number;
  /** 期首商品棚卸高(前年末の棚卸高)。売上原価に加算される */
  inventoryOpening: number;
  /** 期末商品棚卸高。売上原価から控除される */
  inventoryClosing: number;
}

export function transactionsOfYear(transactions: Transaction[], year: number): Transaction[] {
  const prefix = `${year}-`;
  return transactions.filter((t) => t.date.startsWith(prefix));
}

/**
 * 指定年(1/1〜12/31)の青色申告決算書向けサマリーを計算する。
 * 固定資産台帳の減価償却費と、棚卸高による売上原価調整も経費に合算される
 * (帳簿・貸借対照表の所得金額と必ず一致する)。
 */
export function summarizeYear(
  transactions: Transaction[],
  year: number,
  assets: FixedAsset[] = [],
  inventories: InventoryCount[] = [],
): YearSummary {
  const txs = transactionsOfYear(transactions, year);

  const monthlySales = Array.from({ length: 12 }, () => 0);
  const incomeTotals = new Map<string, number>();
  const expenseTotals = new Map<string, { gross: number; business: number }>();
  let unclassifiedCount = 0;
  let unapprovedCount = 0;

  for (const t of txs) {
    // 対象外(プライベート)は集計にもアラートにも含めない
    if (isExcluded(t.account)) continue;
    if (t.account === null) {
      unclassifiedCount++;
      continue;
    }
    if (!t.approved) unapprovedCount++;
    // 決済・振替(売掛金の回収・カード引落し等)は損益ではないため売上・経費に含めない
    if (isSettlement(t.account)) continue;
    if (t.type === 'income') {
      const month = Number(t.date.slice(5, 7)) - 1;
      if (month >= 0 && month < 12) monthlySales[month] += t.amount;
      incomeTotals.set(t.account, (incomeTotals.get(t.account) ?? 0) + t.amount);
    } else {
      const cur = expenseTotals.get(t.account) ?? { gross: 0, business: 0 };
      cur.gross += t.amount;
      cur.business += t.businessAmount;
      expenseTotals.set(t.account, cur);
    }
  }

  // 固定資産台帳の減価償却費を合算(手入力の減価償却費取引があれば加算される)
  const dep = yearDepreciationTotals(assets, year);
  if (dep.total > 0) {
    const cur = expenseTotals.get('depreciation') ?? { gross: 0, business: 0 };
    cur.gross += dep.total;
    cur.business += dep.business;
    expenseTotals.set('depreciation', cur);
  }

  const incomeLines: IncomeLine[] = INCOME_ACCOUNTS.filter((a) => incomeTotals.has(a.id)).map(
    (a) => ({ account: a.id, label: a.label, total: incomeTotals.get(a.id)! }),
  );
  const expenseLines: ExpenseLine[] = EXPENSE_ACCOUNTS.filter((a) => expenseTotals.has(a.id)).map(
    (a) => {
      const { gross, business } = expenseTotals.get(a.id)!;
      return { account: a.id, label: a.label, gross, business, owner: gross - business };
    },
  );

  // 売上原価の棚卸調整: 期首棚卸高を加算・期末棚卸高を控除(期首 = 前年末の棚卸高)
  const inventoryOpening = inventories.find((i) => i.year === year - 1)?.amount ?? 0;
  const inventoryClosing = inventories.find((i) => i.year === year)?.amount ?? 0;

  const totalSales = incomeLines.reduce((s, l) => s + l.total, 0);
  const totalExpense =
    expenseLines.reduce((s, l) => s + l.business, 0) + inventoryOpening - inventoryClosing;
  const totalGross =
    expenseLines.reduce((s, l) => s + l.gross, 0) + inventoryOpening - inventoryClosing;

  return {
    year,
    monthlySales,
    totalSales,
    incomeLines,
    expenseLines,
    totalExpense,
    totalGross,
    totalOwner: totalGross - totalExpense,
    profit: totalSales - totalExpense,
    unclassifiedCount,
    unapprovedCount,
    inventoryOpening,
    inventoryClosing,
  };
}

export interface MonthlyRow {
  /** 1〜12 */
  month: number;
  sales: number;
  /** 経費(按分後の事業分)。12月には減価償却費・棚卸調整も含まれる */
  expense: number;
  profit: number;
}

/**
 * 月次推移(売上・経費・損益)。
 * 減価償却費と棚卸調整は12月の決算整理として12月分に計上する。
 */
export function monthlyBreakdown(
  transactions: Transaction[],
  year: number,
  assets: FixedAsset[] = [],
  inventories: InventoryCount[] = [],
): MonthlyRow[] {
  const sales = Array.from({ length: 12 }, () => 0);
  const expense = Array.from({ length: 12 }, () => 0);
  for (const t of transactionsOfYear(transactions, year)) {
    if (t.account === null || isExcluded(t.account) || isSettlement(t.account)) continue;
    const m = Number(t.date.slice(5, 7)) - 1;
    if (m < 0 || m > 11) continue;
    if (t.type === 'income') sales[m] += t.amount;
    else expense[m] += t.businessAmount;
  }
  // 決算整理(償却費・棚卸調整)は12月へ
  expense[11] += yearDepreciationTotals(assets, year).business;
  const invOpen = inventories.find((i) => i.year === year - 1)?.amount ?? 0;
  const invClose = inventories.find((i) => i.year === year)?.amount ?? 0;
  expense[11] += invOpen - invClose;

  return sales.map((s, i) => ({
    month: i + 1,
    sales: s,
    expense: expense[i],
    profit: s - expense[i],
  }));
}

/** これ以上の取得価額は原則、減価償却が必要になる金額(10万円) */
export const DEPRECIATION_MIN = 100_000;

/**
 * 10万円以上なのに「消耗品費」に仕訳された取引(減価償却の検討が必要な候補)。
 * 原則は減価償却資産として耐用年数で分割計上。青色申告なら取得価額30万円未満は
 * 少額減価償却資産の特例(年合計300万円まで)で購入年に一括計上できる。
 */
export function depreciationCandidates(transactions: Transaction[]): Transaction[] {
  return transactions.filter(
    (t) => t.type === 'expense' && t.account === 'supplies' && t.amount >= DEPRECIATION_MIN,
  );
}

/**
 * 指定年の翌年1月に入金された売上(期ズレ候補)。
 * 12月までの仕事の対価が翌年1月入金の場合、発生主義では指定年の売上に計上する必要がある。
 */
export function periodSlipCandidates(transactions: Transaction[], year: number): Transaction[] {
  const prefix = `${year + 1}-01-`;
  return transactions.filter(
    (t) =>
      t.type === 'income' &&
      !isExcluded(t.account) &&
      // 「売掛金の回収」として処理済みの入金は発生主義で正しく記帳できている
      !isSettlement(t.account) &&
      t.date.startsWith(prefix),
  );
}

/** 取引データに含まれる年のリスト(降順)。データがなければ今年のみ */
export function availableYears(transactions: Transaction[], currentYear: number): number[] {
  const years = new Set<number>([currentYear]);
  for (const t of transactions) {
    const y = Number(t.date.slice(0, 4));
    if (y >= 2000 && y <= 2100) years.add(y);
  }
  return [...years].sort((a, b) => b - a);
}

/** 決算書サマリーをCSV文字列にする(Excel対応のためBOM付き) */
export function summaryToCsv(summary: YearSummary): string {
  const lines: string[] = [];
  lines.push(`"${summary.year}年分 青色申告決算書用 科目別集計"`);
  lines.push('');
  lines.push('区分,科目,按分前金額,経費計上額(按分後),事業主貸');
  for (const l of summary.incomeLines) {
    lines.push(`収入,${csvCell(l.label)},${l.total},${l.total},0`);
  }
  for (const l of summary.expenseLines) {
    lines.push(`経費,${csvCell(l.label)},${l.gross},${l.business},${l.owner}`);
  }
  if (summary.inventoryOpening > 0 || summary.inventoryClosing > 0) {
    lines.push(`売上原価,期首商品棚卸高(加算),${summary.inventoryOpening},${summary.inventoryOpening},0`);
    lines.push(`売上原価,期末商品棚卸高(控除),-${summary.inventoryClosing},-${summary.inventoryClosing},0`);
  }
  lines.push('');
  lines.push(`合計,売上(収入)金額 合計,${summary.totalSales},${summary.totalSales},0`);
  lines.push(`合計,経費 合計,${summary.totalGross},${summary.totalExpense},${summary.totalOwner}`);
  lines.push(`合計,差引金額(青色申告特別控除前の所得金額),,${summary.profit},`);
  lines.push('');
  lines.push('月,売上金額');
  summary.monthlySales.forEach((v, i) => lines.push(`${i + 1}月,${v}`));
  lines.push(`年間合計,${summary.totalSales}`);
  return '\ufeff' + lines.join('\r\n');
}

function csvCell(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

export { accountLabel };
