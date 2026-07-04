import { EXCLUDED_ACCOUNT } from './accounts';
import { taxInclusive } from './tax';
import { Invoice, InvoiceItem, Transaction } from './types';

/**
 * 請求書の金額計算。
 * インボイス制度(適格請求書)の要件に合わせ、消費税の端数処理は
 * 「1請求書あたり・税率ごとに1回」だけ行う(明細行ごとには丸めない)。
 */

/** 明細1行の金額(数量 × 単価。四捨五入で円に丸める) */
export function itemAmount(item: Pick<InvoiceItem, 'quantity' | 'unitPrice'>): number {
  return Math.round(item.quantity * item.unitPrice);
}

export interface RateTotal {
  rate: 10 | 8 | 0;
  /** 税抜対価の合計 */
  base: number;
  /** 消費税額(税率ごとに1回の端数処理・切り捨て) */
  tax: number;
  /** 税込合計 */
  gross: number;
}

export interface InvoiceTotals {
  /** 税率ごとの内訳(明細のある税率のみ・10%→8%→対象外の順) */
  rates: RateTotal[];
  /** 税抜合計 */
  subtotal: number;
  /** 消費税合計 */
  taxTotal: number;
  /** 税込合計 */
  grossTotal: number;
  /** 源泉徴収税額(設定時のみ。税抜報酬額ベース) */
  withholdingTax: number;
  /** ご請求金額 = 税込合計 − 源泉徴収税額 */
  billedAmount: number;
}

/**
 * 源泉徴収税額(報酬・料金等)。
 * 支払金額(税抜報酬額)が100万円以下は10.21%、超える部分は20.42%。
 * 請求書で本体と消費税を区分しているため、税抜額を対象にできる。
 */
export function withholdingAmount(base: number): number {
  if (base <= 0) return 0;
  if (base <= 1_000_000) return Math.floor(base * 0.1021);
  return Math.floor(1_000_000 * 0.1021 + (base - 1_000_000) * 0.2042);
}

/** 請求書全体の金額を計算する */
export function computeInvoiceTotals(
  inv: Pick<Invoice, 'items' | 'taxIncluded' | 'withholding'>,
): InvoiceTotals {
  const sums = new Map<10 | 8 | 0, number>();
  for (const item of inv.items) {
    const amount = itemAmount(item);
    if (amount === 0) continue;
    sums.set(item.taxRate, (sums.get(item.taxRate) ?? 0) + amount);
  }

  const rates: RateTotal[] = [];
  for (const rate of [10, 8, 0] as const) {
    const sum = sums.get(rate) ?? 0;
    if (sum === 0) continue;
    if (rate === 0) {
      rates.push({ rate, base: sum, tax: 0, gross: sum });
    } else if (inv.taxIncluded) {
      // 税込単価: 合計から税額を割り戻す
      const tax = taxInclusive(sum, rate);
      rates.push({ rate, base: sum - tax, tax, gross: sum });
    } else {
      // 税抜単価: 税率ごとの合計に対して1回だけ課税(切り捨て)
      const tax = Math.floor((sum * rate) / 100);
      rates.push({ rate, base: sum, tax, gross: sum + tax });
    }
  }

  const subtotal = rates.reduce((s, r) => s + r.base, 0);
  const taxTotal = rates.reduce((s, r) => s + r.tax, 0);
  const grossTotal = rates.reduce((s, r) => s + r.gross, 0);
  const withholdingTax = inv.withholding ? withholdingAmount(subtotal) : 0;

  return {
    rates,
    subtotal,
    taxTotal,
    grossTotal,
    withholdingTax,
    billedAmount: grossTotal - withholdingTax,
  };
}

/** 請求書番号の自動採番(発行年ごとの連番: 2026-001, 2026-002, …) */
export function suggestInvoiceNumber(invoices: Invoice[], issueDate: string): string {
  const year = issueDate.slice(0, 4);
  let max = 0;
  for (const inv of invoices) {
    const m = inv.number.match(/^(\d{4})-(\d+)$/);
    if (m && m[1] === year) max = Math.max(max, Number(m[2]));
  }
  return `${year}-${String(max + 1).padStart(3, '0')}`;
}

export type InvoiceTxDraft = Omit<Transaction, 'id' | 'createdAt' | 'businessAmount' | 'anbunApplied'>;

/**
 * 請求書を売掛金として売上計上するための取引を作る(発生主義)。
 * - 税率ごとに1件の売上取引(税込額・決済手段=売掛金)にし、消費税集計を正確に保つ
 * - 源泉徴収は「事業主貸 / 売掛金」(所得税の前払い=プライベートの税金)として
 *   請求時に差し引き、売掛金残高を実際の入金予定額に一致させる
 * 入金時は銀行明細の入金行を「売掛金の回収」にすれば消し込まれる。
 */
export function buildInvoiceTransactions(inv: Invoice): InvoiceTxDraft[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(inv.issueDate)) return [];
  const totals = computeInvoiceTotals(inv);
  const drafts: InvoiceTxDraft[] = [];
  const label = `請求書 ${inv.number} ${inv.client}`.trim();

  for (const r of totals.rates) {
    drafts.push({
      date: inv.issueDate,
      amount: r.gross,
      description: r.rate === 10 ? label : `${label}(${r.rate === 8 ? '軽減8%' : '対象外'}分)`,
      type: 'income',
      account: 'sales',
      approved: true,
      source: 'manual',
      fund: 'receivable',
      taxCategory: r.rate === 10 ? 'taxable10' : r.rate === 8 ? 'taxable8' : 'none',
    });
  }
  if (totals.withholdingTax > 0) {
    drafts.push({
      date: inv.issueDate,
      amount: totals.withholdingTax,
      description: `源泉所得税 ${label}`,
      type: 'expense',
      // 源泉所得税は事業の経費ではなく所得税の前払い → 事業主貸として売掛金から差し引く
      account: EXCLUDED_ACCOUNT,
      approved: true,
      source: 'manual',
      fund: 'receivable',
    });
  }
  return drafts;
}
