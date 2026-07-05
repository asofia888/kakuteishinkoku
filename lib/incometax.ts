import {
  basicDeductionTableFor,
  BUSINESS_TAX,
  incomeTaxBracketsFor,
  RECONSTRUCTION_TAX,
  RESIDENT_TAX,
} from './taxparams';
import { DeductionEntry } from './types';

/**
 * 所得税のシミュレーション(事業所得のみの個人・青色申告を想定した概算)。
 * 課税所得は1,000円未満切り捨て、申告納税額は100円未満切り捨て。
 * 税率・控除額などの年度パラメータは lib/taxparams.ts に集約している。
 */

/** 課税所得(1,000円未満切り捨て済み)に対する所得税額(復興税を含まない) */
export function incomeTaxBase(taxable: number, year = new Date().getFullYear()): number {
  if (taxable <= 0) return 0;
  const b = incomeTaxBracketsFor(year).find((x) => taxable <= x.limit)!;
  return Math.floor(taxable * b.rate - b.deduction);
}

/** 基礎控除(合計所得金額と年分による。テーブルは lib/taxparams.ts) */
export function basicDeduction(totalIncome: number, year: number): number {
  return basicDeductionTableFor(year).find((s) => totalIncome <= s.limit)!.amount;
}

export interface DeductionBreakdownLine {
  label: string;
  amount: number;
}

export interface IncomeTaxResult {
  /** 青色申告特別控除の適用額(所得を限度) */
  blueApplied: number;
  /** 事業所得(青色控除後)= 合計所得金額 */
  totalIncome: number;
  /** 医療費控除(足切り後) */
  medicalDeduction: number;
  /** 寄附金控除(2,000円足切り・40%上限後) */
  donationDeduction: number;
  /** 基礎控除 */
  basic: number;
  /** 所得控除の内訳(0円の項目は含まない) */
  breakdown: DeductionBreakdownLine[];
  /** 所得控除の合計 */
  totalDeductions: number;
  /** 課税所得(1,000円未満切り捨て) */
  taxable: number;
  /** 所得税(復興税前) */
  incomeTax: number;
  /** 復興特別所得税(2.1%) */
  reconstructionTax: number;
  /** 所得税及び復興特別所得税の額 */
  totalTax: number;
  /** 申告納税額 = 税額 − 源泉徴収税額(プラス=納付・100円未満切り捨て、マイナス=還付) */
  balanceDue: number;
  /** 住民税の概算(所得割10% + 均等割約5,000円。控除額の違いは無視した目安) */
  residentTaxEst: number;
  /** 個人事業税の概算(事業主控除290万円・税率5%の業種前提。青色控除前の所得で計算) */
  businessTaxEst: number;
}

/** 事業所得(青色控除前)と控除入力から所得税を試算する */
export function simulateIncomeTax(profit: number, d: DeductionEntry): IncomeTaxResult {
  const blueApplied = Math.max(0, Math.min(d.blueDeduction, profit));
  const totalIncome = Math.max(0, profit - blueApplied);

  // 医療費控除: 支払額 − 補填 − min(10万円, 合計所得の5%)。上限200万円
  const medicalDeduction = Math.min(
    2_000_000,
    Math.max(
      0,
      d.medicalPaid - d.medicalReimbursed - Math.min(100_000, Math.floor(totalIncome * 0.05)),
    ),
  );
  // 寄附金控除(ふるさと納税含む): min(支払額, 合計所得の40%) − 2,000円
  const donationDeduction = Math.max(
    0,
    Math.min(d.donations, Math.floor(totalIncome * 0.4)) - 2_000,
  );
  const basic = basicDeduction(totalIncome, d.year);
  const life = Math.min(120_000, d.lifeInsurance);
  const earthquake = Math.min(50_000, d.earthquakeInsurance);

  const breakdown: DeductionBreakdownLine[] = [
    { label: '社会保険料控除(国民年金・国保など)', amount: d.socialInsurance },
    { label: '小規模企業共済等掛金控除(iDeCo・共済)', amount: d.mutualAid },
    { label: '生命保険料控除', amount: life },
    { label: '地震保険料控除', amount: earthquake },
    { label: '医療費控除', amount: medicalDeduction },
    { label: '寄附金控除(ふるさと納税など)', amount: donationDeduction },
    { label: '配偶者(特別)控除', amount: d.spouse },
    { label: '扶養控除', amount: d.dependents },
    { label: 'その他の控除', amount: d.others },
    { label: '基礎控除', amount: basic },
  ].filter((l) => l.amount > 0);

  const totalDeductions = breakdown.reduce((s, l) => s + l.amount, 0);
  const taxable = Math.floor(Math.max(0, totalIncome - totalDeductions) / 1000) * 1000;
  const incomeTax = incomeTaxBase(taxable, d.year);
  const reconstructionTax =
    d.year >= RECONSTRUCTION_TAX.fromYear && d.year <= RECONSTRUCTION_TAX.toYear
      ? Math.floor(incomeTax * RECONSTRUCTION_TAX.rate)
      : 0;
  const totalTax = incomeTax + reconstructionTax;

  const rawBalance = totalTax - d.withholding;
  const balanceDue = rawBalance > 0 ? Math.floor(rawBalance / 100) * 100 : rawBalance;

  const residentTaxEst =
    taxable > 0 ? Math.floor(taxable * RESIDENT_TAX.rate) + RESIDENT_TAX.perCapita : 0;
  const businessTaxEst = Math.floor(
    Math.max(0, profit - BUSINESS_TAX.ownerDeduction) * BUSINESS_TAX.rate,
  );

  return {
    blueApplied,
    totalIncome,
    medicalDeduction,
    donationDeduction,
    basic,
    breakdown,
    totalDeductions,
    taxable,
    incomeTax,
    reconstructionTax,
    totalTax,
    balanceDue,
    residentTaxEst,
    businessTaxEst,
  };
}
