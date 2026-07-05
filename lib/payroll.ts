import { escapeFormulaCell } from './csv';
import { salaryWithholdingFor } from './taxparams';
import { PayrollEntry, Transaction } from './types';

/**
 * 給与(バイト代など)の記帳支援。
 * 仕訳: (借)給料賃金 総支給額 / (貸)普通預金 手取り +(貸)預り金 源泉徴収税額・社会保険料等
 * を「手取りの支払い」「源泉の預り」「社会保険料等の預り」の取引で表現する。
 * 預り金は納付時に科目「預り金の納付(源泉所得税・社会保険料)」で消し込む。
 */

export const SALARY_TABLE_LABELS: Record<PayrollEntry['table'], string> = {
  kou: '甲欄(扶養控除等申告書あり)',
  otsu: '乙欄(申告書なし・他に主たる給与)',
  hei: '丙欄(日雇い・継続2ヶ月以内)',
  manual: '手入力',
};

/**
 * 源泉徴収税額の簡易計算(源泉徴収税額表の0円ライン・乙欄の定率のみ)。
 * 判定は「社会保険料等控除後の給与等の金額」(taxable)と支払年分の税額表で行う。
 * 自動計算できない(税額表の参照が必要な)場合は null を返す。
 * - 甲欄: 月額ライン未満 → 0円。以上は税額表参照
 * - 乙欄: 月額ライン未満 → 3.063%。以上は税額表参照
 * - 丙欄: 日額ライン未満 → 0円。以上は税額表参照
 * (ラインは2025年分まで 88,000円/9,300円、2026年分から 105,000円/9,800円)
 */
export function salaryWithholding(
  taxable: number,
  table: 'kou' | 'otsu' | 'hei',
  year: number,
): number | null {
  if (taxable <= 0) return 0;
  const { monthlyZeroUnder, dailyZeroUnder, otsuRate } = salaryWithholdingFor(year);
  if (table === 'kou') return taxable < monthlyZeroUnder ? 0 : null;
  if (table === 'hei') return taxable < dailyZeroUnder ? 0 : null;
  return taxable < monthlyZeroUnder ? Math.floor(taxable * otsuRate) : null;
}

export type PayrollTxDraft = Omit<Transaction, 'id' | 'createdAt' | 'businessAmount' | 'anbunApplied'>;

/** 給与1件から取引(手取りの支払い + 源泉・社会保険料等の預り)を作る */
export function buildPayrollTransactions(
  e: Pick<PayrollEntry, 'employee' | 'date' | 'gross' | 'withholding' | 'socialInsurance' | 'note'>,
): PayrollTxDraft[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date) || e.gross <= 0) return [];
  const withholding = Math.min(Math.max(0, e.withholding), e.gross);
  const socialInsurance = Math.min(Math.max(0, e.socialInsurance ?? 0), e.gross - withholding);
  const net = e.gross - withholding - socialInsurance;
  const label = `給与 ${e.employee}${e.note ? `(${e.note})` : ''}`;
  const drafts: PayrollTxDraft[] = [];
  if (net > 0) {
    drafts.push({
      date: e.date,
      amount: net,
      description: `${label} 差引支給額`,
      type: 'expense',
      account: 'salaries',
      approved: true,
      source: 'manual',
      fund: 'bank',
    });
  }
  if (socialInsurance > 0) {
    drafts.push({
      date: e.date,
      amount: socialInsurance,
      description: `${label} 社会保険料等(預り)`,
      type: 'expense',
      account: 'salaries',
      approved: true,
      source: 'manual',
      fund: 'deposit', // (借)給料賃金 / (貸)預り金
    });
  }
  if (withholding > 0) {
    drafts.push({
      date: e.date,
      amount: withholding,
      description: `${label} 源泉所得税(預り)`,
      type: 'expense',
      account: 'salaries',
      approved: true,
      source: 'manual',
      fund: 'deposit', // (借)給料賃金 / (貸)預り金
    });
  }
  return drafts;
}

function csvCell(s: string): string {
  return `"${escapeFormulaCell(s).replace(/"/g, '""')}"`;
}

/** 賃金台帳CSV(従業員別・支払日順)。労働日数・時間は別途記録が必要 */
export function payrollLedgerCsv(payrolls: PayrollEntry[], year: number): string {
  const lines: string[] = [];
  lines.push(`"${year}年分 賃金台帳(申告スナップ)"`);
  lines.push('※労働基準法上の賃金台帳には労働日数・労働時間の記載も必要です(別途記録してください)');
  const inYear = payrolls
    .filter((p) => p.date.startsWith(`${year}-`))
    .sort((a, b) => a.date.localeCompare(b.date));
  const employees = [...new Set(inYear.map((p) => p.employee))];
  for (const emp of employees) {
    const rows = inYear.filter((p) => p.employee === emp);
    lines.push('');
    lines.push(`従業員,${csvCell(emp)}`);
    lines.push('支払日,税額区分,総支給額,社会保険料等,源泉徴収税額,差引支給額,備考');
    let g = 0;
    let s = 0;
    let w = 0;
    for (const p of rows) {
      const si = p.socialInsurance ?? 0;
      g += p.gross;
      s += si;
      w += p.withholding;
      lines.push(
        [
          p.date,
          SALARY_TABLE_LABELS[p.table],
          p.gross,
          si,
          p.withholding,
          p.gross - si - p.withholding,
          csvCell(p.note ?? ''),
        ].join(','),
      );
    }
    lines.push(`年間合計,,${g},${s},${w},${g - s - w},`);
  }
  return '\ufeff' + lines.join('\r\n');
}
