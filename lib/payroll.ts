import { escapeFormulaCell } from './csv';
import { basicDeduction, incomeTaxBase } from './incometax';
import { salaryWithholdingFor } from './taxparams';
import { PayrollEntry, Transaction, YearEndAdjustment } from './types';

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

// ── 年末調整(源泉徴収簿) ──────────────────────────────

/**
 * 給与所得控除後の給与等の金額(速算式による概算)。
 * 令和7年分(2025年)以降は最低保障が65万円(令和7年度改正)。
 * 実際の年末調整では収入660万円未満は所得税法別表第五(4,000円刻みの表)を
 * 使うため、数百円ずれることがある。
 */
export function salaryIncomeAfterDeduction(gross: number, year: number): number {
  if (gross <= 0) return 0;
  const floor = year >= 2025 ? 650_000 : 550_000;
  let deduction: number;
  if (gross <= 1_800_000) deduction = Math.floor(gross * 0.4) - 100_000;
  else if (gross <= 3_600_000) deduction = Math.floor(gross * 0.3) + 80_000;
  else if (gross <= 6_600_000) deduction = Math.floor(gross * 0.2) + 440_000;
  else if (gross <= 8_500_000) deduction = Math.floor(gross * 0.1) + 1_100_000;
  else deduction = 1_950_000;
  return Math.max(0, gross - Math.max(floor, deduction));
}

/** 年末調整の計算結果(源泉徴収簿の右側の欄) */
export interface YearEndResult {
  year: number;
  employee: string;
  /** 年間の総支給額 */
  gross: number;
  /** 給与から天引きした社会保険料等の合計 */
  withheldSocial: number;
  /** 源泉徴収税額の合計 */
  withheldTax: number;
  /** 給与所得控除後の給与等の金額 */
  salaryIncome: number;
  /** 社会保険料等の控除計(天引き + 本人申告分) */
  socialTotal: number;
  /** 基礎控除(合計所得と年分で判定) */
  basic: number;
  /** 所得控除の合計 */
  totalDeductions: number;
  /** 課税給与所得金額(1,000円未満切捨て) */
  taxable: number;
  /** 算出所得税額(速算表) */
  incomeTax: number;
  /** 年調年税額(算出税額 × 102.1% → 100円未満切捨て) */
  annualTax: number;
  /** 過不足額(年調年税額 − 源泉徴収税額計。マイナス = 従業員へ還付) */
  balance: number;
}

/** 指定年・従業員の年末調整を計算する(給与所得のみの前提) */
export function calcYearEndAdjustment(
  payrolls: PayrollEntry[],
  adj: Pick<
    YearEndAdjustment,
    'personalDeductions' | 'insuranceDeductions' | 'declaredSocialInsurance'
  >,
  employee: string,
  year: number,
): YearEndResult {
  const rows = payrolls.filter((p) => p.employee === employee && p.date.startsWith(`${year}-`));
  const gross = rows.reduce((s, p) => s + p.gross, 0);
  const withheldSocial = rows.reduce((s, p) => s + (p.socialInsurance ?? 0), 0);
  const withheldTax = rows.reduce((s, p) => s + p.withholding, 0);
  const salaryIncome = salaryIncomeAfterDeduction(gross, year);
  const socialTotal = withheldSocial + adj.declaredSocialInsurance;
  // 合計所得金額 = 給与所得のみの前提(他の所得は本人の確定申告で精算)
  const basic = basicDeduction(salaryIncome, year);
  const totalDeductions =
    socialTotal + adj.insuranceDeductions + adj.personalDeductions + basic;
  const taxable = Math.floor(Math.max(0, salaryIncome - totalDeductions) / 1000) * 1000;
  const incomeTax = incomeTaxBase(taxable, year);
  // 年調年税額 = 算出所得税額 × 102.1%(復興特別所得税込み)→ 100円未満切捨て
  const annualTax = Math.floor((incomeTax * 1021) / 100_000) * 100;
  return {
    year,
    employee,
    gross,
    withheldSocial,
    withheldTax,
    salaryIncome,
    socialTotal,
    basic,
    totalDeductions,
    taxable,
    incomeTax,
    annualTax,
    balance: annualTax - withheldTax,
  };
}

function csvCell(s: string): string {
  return `"${escapeFormulaCell(s).replace(/"/g, '""')}"`;
}

/** 源泉徴収簿CSV(従業員別の月別内訳 + 年末調整欄) */
export function withholdingLedgerCsv(
  payrolls: PayrollEntry[],
  adjustments: YearEndAdjustment[],
  year: number,
): string {
  const lines: string[] = [];
  lines.push(`"${year}年分 給与所得に対する源泉徴収簿(申告スナップ)"`);
  lines.push(
    '※速算式による計算のため、別表第五(660万円未満の所得金額の表)とは数百円ずれることがあります',
  );
  const inYear = payrolls
    .filter((p) => p.date.startsWith(`${year}-`))
    .sort((a, b) => a.date.localeCompare(b.date));
  const employees = [...new Set(inYear.map((p) => p.employee))];
  for (const emp of employees) {
    const adj = adjustments.find((a) => a.year === year && a.employee === emp) ?? {
      personalDeductions: 0,
      insuranceDeductions: 0,
      declaredSocialInsurance: 0,
    };
    const r = calcYearEndAdjustment(payrolls, adj, emp, year);
    lines.push('');
    lines.push(`従業員,${csvCell(emp)}`);
    lines.push('支払日,総支給額,社会保険料等,社保控除後,算出税額(源泉),税額区分');
    for (const p of inYear.filter((x) => x.employee === emp)) {
      const si = p.socialInsurance ?? 0;
      lines.push(
        [p.date, p.gross, si, p.gross - si, p.withholding, SALARY_TABLE_LABELS[p.table]].join(','),
      );
    }
    lines.push(`年間合計,${r.gross},${r.withheldSocial},${r.gross - r.withheldSocial},${r.withheldTax},`);
    lines.push('── 年末調整 ──');
    lines.push(`給与所得控除後の給与等の金額,${r.salaryIncome}`);
    lines.push(`社会保険料等控除額(天引き+申告分),${r.socialTotal}`);
    lines.push(`生命保険料・地震保険料等の控除額,${adj.insuranceDeductions}`);
    lines.push(`配偶者・扶養・障害者等の控除額,${adj.personalDeductions}`);
    lines.push(`基礎控除額,${r.basic}`);
    lines.push(`課税給与所得金額(1000円未満切捨),${r.taxable}`);
    lines.push(`算出所得税額,${r.incomeTax}`);
    lines.push(`年調年税額(×102.1%・100円未満切捨),${r.annualTax}`);
    lines.push(`源泉徴収税額の合計,${r.withheldTax}`);
    lines.push(
      r.balance >= 0 ? `不足額(徴収する額),${r.balance}` : `超過額(還付する額),${-r.balance}`,
    );
  }
  return '﻿' + lines.join('\r\n');
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
