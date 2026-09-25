import {
  basicDeductionTableFor,
  BUSINESS_TAX,
  incomeTaxBracketsFor,
  RECONSTRUCTION_TAX,
  RESIDENT_BASIC_DEDUCTION,
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
  /** 事業所得(青色控除後)= 合計所得金額(基礎控除・配偶者控除などの判定に使う) */
  totalIncome: number;
  /** 純損失の繰越控除の適用額(合計所得金額を限度) */
  lossApplied: number;
  /** 総所得金額等(合計所得金額 − 繰越控除)。医療費・寄附金の限度と課税所得の計算に使う */
  incomeAfterLoss: number;
  /** 翌年以後に繰り越せる純損失(本年の赤字 + 使い切れなかった繰越分。3年の期限は各自で管理) */
  lossToCarry: number;
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
  filingTax: number;
  /** 第3期分の税額 = 申告納税額 − 予定納税額(プラス=納める税金、マイナス=還付される税金) */
  balanceDue: number;
  /** 住民税の概算(所得割10% + 均等割約5,000円。基礎控除は住民税の43万円で計算し、人的控除等のその他の差額は無視した目安) */
  residentTaxEst: number;
  /** 個人事業税の概算(事業主控除290万円・税率5%の業種前提。青色控除前の所得で計算) */
  businessTaxEst: number;
}

/** 事業所得(青色控除前)と控除入力から所得税を試算する */
export function simulateIncomeTax(profit: number, d: DeductionEntry): IncomeTaxResult {
  const blueApplied = Math.max(0, Math.min(d.blueDeduction, profit));
  const totalIncome = Math.max(0, profit - blueApplied);
  // 純損失の繰越控除(青色): 合計所得金額から差し引いて総所得金額等にする。
  // 基礎控除などの判定は繰越控除前の合計所得金額、医療費・寄附金の限度は控除後の総所得金額等で行う
  const carry = Math.max(0, d.lossCarryforward ?? 0);
  const lossApplied = Math.min(carry, totalIncome);
  const incomeAfterLoss = totalIncome - lossApplied;
  const lossToCarry = carry - lossApplied + Math.max(0, -profit);

  // 医療費控除: 支払額 − 補填 − min(10万円, 総所得金額等の5%)。上限200万円
  const medicalDeduction = Math.min(
    2_000_000,
    Math.max(
      0,
      d.medicalPaid - d.medicalReimbursed - Math.min(100_000, Math.floor(incomeAfterLoss * 0.05)),
    ),
  );
  // 寄附金控除(ふるさと納税含む): min(支払額, 総所得金額等の40%) − 2,000円
  const donationDeduction = Math.max(
    0,
    Math.min(d.donations, Math.floor(incomeAfterLoss * 0.4)) - 2_000,
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
  const taxable = Math.floor(Math.max(0, incomeAfterLoss - totalDeductions) / 1000) * 1000;
  const incomeTax = incomeTaxBase(taxable, d.year);
  const reconstructionTax =
    d.year >= RECONSTRUCTION_TAX.fromYear && d.year <= RECONSTRUCTION_TAX.toYear
      ? Math.floor(incomeTax * RECONSTRUCTION_TAX.rate)
      : 0;
  const totalTax = incomeTax + reconstructionTax;

  // 申告納税額(源泉徴収税額を引いた額。納付は100円未満切捨て)から予定納税額を引いて第3期分にする
  const rawFiling = totalTax - d.withholding;
  const filingTax = rawFiling > 0 ? Math.floor(rawFiling / 100) * 100 : rawFiling;
  const balanceDue = filingTax - Math.max(0, d.prepaidTax ?? 0);

  // 住民税: 基礎控除は所得税(2025年分〜引き上げ・特例加算あり)と異なり43万円のままのため、
  // 基礎控除だけ住民税の額に置き換えた課税標準で概算する(扶養控除等のその他の差は未反映)
  const residentBasic = RESIDENT_BASIC_DEDUCTION.find((s) => totalIncome <= s.limit)!.amount;
  const residentTaxable =
    Math.floor(Math.max(0, incomeAfterLoss - (totalDeductions - basic + residentBasic)) / 1000) * 1000;
  const residentTaxEst =
    residentTaxable > 0
      ? Math.floor(residentTaxable * RESIDENT_TAX.rate) + RESIDENT_TAX.perCapita
      : 0;
  // 事業税も青色なら損失を3年繰り越せる(事業の所得から差し引く概算)
  const businessTaxEst = Math.floor(
    Math.max(0, profit - carry - BUSINESS_TAX.ownerDeduction) * BUSINESS_TAX.rate,
  );

  return {
    blueApplied,
    totalIncome,
    lossApplied,
    incomeAfterLoss,
    lossToCarry,
    medicalDeduction,
    donationDeduction,
    basic,
    breakdown,
    totalDeductions,
    taxable,
    incomeTax,
    reconstructionTax,
    totalTax,
    filingTax,
    balanceDue,
    residentTaxEst,
    businessTaxEst,
  };
}

/**
 * 帳簿の各年の事業所得から、指定年に使える純損失の繰越額の目安(青色申告・3年間)。
 * 赤字の年の損失を古いものから、翌年以後の黒字(青色申告特別控除後)で順に使い、
 * 損失の年の翌年から3年を過ぎた残りは消える。
 * 帳簿にない所得(給与など)は考慮しないため、実際の繰越額は申告書第四表で確認する
 */
export function suggestedLossCarryforward(
  years: { year: number; profit: number; blueDeduction: number }[],
  year: number,
): number {
  const byYear = new Map(years.map((y) => [y.year, y]));
  const past = years.map((y) => y.year).filter((y) => y < year);
  if (past.length === 0) return 0;
  let queue: { year: number; amount: number }[] = [];
  for (let y = Math.min(...past); y < year; y++) {
    queue = queue.filter((q) => y - q.year <= 3 && q.amount > 0);
    const row = byYear.get(y);
    if (!row) continue;
    if (row.profit < 0) {
      queue.push({ year: y, amount: -row.profit });
      continue;
    }
    let income = Math.max(0, row.profit - Math.min(row.blueDeduction, row.profit));
    for (const q of queue) {
      const use = Math.min(q.amount, income);
      q.amount -= use;
      income -= use;
    }
  }
  return queue.filter((q) => year - q.year <= 3).reduce((s, q) => s + q.amount, 0);
}
