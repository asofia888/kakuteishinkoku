import {
  basicDeductionTableFor,
  BUSINESS_TAX,
  incomeTaxBracketsFor,
  normalizeBlueDeduction,
  RECONSTRUCTION_TAX,
  RESIDENT_BASIC_DEDUCTION,
  RESIDENT_TAX,
  salaryIncomeTableFor,
} from './taxparams';
import { DeductionEntry } from './types';

/**
 * 所得税のシミュレーション(事業所得 + 給与所得の個人・青色申告を想定した概算)。
 * 課税所得は1,000円未満切り捨て、申告納税額は100円未満切り捨て。
 * 税率・控除額などの年度パラメータは lib/taxparams.ts に集約している。
 */

/** 課税所得(1,000円未満切り捨て済み)に対する所得税額(復興税を含まない) */
export function incomeTaxBase(taxable: number, year = new Date().getFullYear()): number {
  if (taxable <= 0) return 0;
  const b = incomeTaxBracketsFor(year).find((x) => taxable <= x.limit)!;
  return Math.floor(taxable * b.rate - b.deduction);
}

/**
 * 給与所得の金額(給与所得控除後の給与等の金額)。
 * 収入660万円未満は所得税法別表第五と同じ結果になるよう、国税庁「給与所得の金額の計算」の方法で求める
 * (最低保障の範囲は「収入 − 最低保障額」、境目は年分ごとの固定額の行、それ以上は収入を
 *  4,000円単位に切り捨てた額 A で A×60%+10万 / A×70%−8万 / A×80%−44万)。
 * 660万円以上は 収入×90%−110万 / 収入−195万。2028年分以後の表は未公表のため推計
 */
export function salaryIncomeAfterDeduction(gross: number, year: number): number {
  if (gross <= 0) return 0;
  if (gross >= 8_500_000) return gross - 1_950_000;
  if (gross >= 6_600_000) return Math.floor((gross * 9) / 10) - 1_100_000;
  const table = salaryIncomeTableFor(year);
  const byMinimum = gross - table.minimum;
  if (gross < table.exactBelow) return Math.max(0, byMinimum);
  const band = table.bands.find((b) => gross >= b.from && gross < b.to);
  if (band) return band.income;
  // A は4,000円の倍数のため、各割合を掛けても円未満の端数は出ない
  const a = Math.floor(gross / 4_000) * 4_000;
  const byTable =
    a < 1_800_000
      ? (a * 6) / 10 + 100_000
      : a < 3_600_000
        ? (a * 7) / 10 - 80_000
        : (a * 8) / 10 - 440_000;
  // 推計の年分は、最低保障額が効く範囲を表の計算で上回らないよう小さい方を使う
  return Math.max(0, table.estimated ? Math.min(byMinimum, byTable) : byTable);
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
  /** 青色申告特別控除の適用額(事業所得を限度) */
  blueApplied: number;
  /** 事業所得(青色控除後)。赤字はマイナス(決算書の所得金額・申告書の事業所得の欄) */
  businessIncome: number;
  /** 給与所得(給与所得控除後の金額。給与がなければ0) */
  salaryIncome: number;
  /**
   * 合計所得金額(事業所得 + 給与所得。事業の赤字は給与所得から差し引く=損益通算)。
   * 基礎控除・配偶者控除などの判定に使う
   */
  totalIncome: number;
  /** 純損失の繰越控除の適用額(合計所得金額を限度) */
  lossApplied: number;
  /** 総所得金額等(合計所得金額 − 繰越控除)。医療費・寄附金の限度と課税所得の計算に使う */
  incomeAfterLoss: number;
  /** 翌年以後に繰り越せる純損失(損益通算で引ききれない本年の赤字 + 使い切れなかった繰越分。3年の期限は各自で管理) */
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
  /** 源泉徴収税額の合計(報酬の源泉 + 給与の源泉) */
  withholdingTotal: number;
  /** 第3期分の税額 = 申告納税額 − 予定納税額(プラス=納める税金、マイナス=還付される税金) */
  balanceDue: number;
  /** 住民税の概算(所得割10% + 均等割約5,000円。基礎控除は住民税の43万円で計算し、人的控除等のその他の差額は無視した目安) */
  residentTaxEst: number;
  /** 個人事業税の概算(事業主控除290万円・税率5%の業種前提。青色控除前の所得で計算) */
  businessTaxEst: number;
}

/** 事業所得(青色控除前)と控除入力(給与の収入があればそれも)から所得税を試算する */
export function simulateIncomeTax(profit: number, d: DeductionEntry): IncomeTaxResult {
  // 青色申告特別控除は事業所得が限度(給与所得からは引けない)
  const blueApplied = Math.max(0, Math.min(normalizeBlueDeduction(d.year, d.blueDeduction), profit));
  const businessIncome = profit - blueApplied;
  const salaryIncome = salaryIncomeAfterDeduction(Math.max(0, d.salaryGross ?? 0), d.year);
  // 損益通算: 事業所得の赤字は給与所得から差し引き、引ききれない分が純損失になる
  const combined = businessIncome + salaryIncome;
  const totalIncome = Math.max(0, combined);
  // 純損失の繰越控除(青色): 合計所得金額から差し引いて総所得金額等にする。
  // 基礎控除などの判定は繰越控除前の合計所得金額、医療費・寄附金の限度は控除後の総所得金額等で行う
  const carry = Math.max(0, d.lossCarryforward ?? 0);
  const lossApplied = Math.min(carry, totalIncome);
  const incomeAfterLoss = totalIncome - lossApplied;
  const lossToCarry = carry - lossApplied + Math.max(0, -combined);

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
  const withholdingTotal = d.withholding + Math.max(0, d.salaryWithholding ?? 0);
  const rawFiling = totalTax - withholdingTotal;
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
    businessIncome,
    salaryIncome,
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
    withholdingTotal,
    balanceDue,
    residentTaxEst,
    businessTaxEst,
  };
}

/**
 * 帳簿の各年の事業所得から、指定年に使える純損失の繰越額の目安(青色申告・3年間)。
 * 赤字の年の損失(給与所得 otherIncome があれば損益通算した残り)を古いものから、
 * 翌年以後の所得(青色申告特別控除後の事業所得 + 給与所得)で順に使い、
 * 損失の年の翌年から3年を過ぎた残りは消える。
 * 帳簿・入力にない所得は考慮しないため、実際の繰越額は申告書第四表で確認する
 */
export function suggestedLossCarryforward(
  years: { year: number; profit: number; blueDeduction: number; otherIncome?: number }[],
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
    const business = row.profit - Math.min(row.blueDeduction, Math.max(0, row.profit));
    const combined = business + Math.max(0, row.otherIncome ?? 0);
    if (combined < 0) {
      queue.push({ year: y, amount: -combined });
      continue;
    }
    let income = combined;
    for (const q of queue) {
      const use = Math.min(q.amount, income);
      q.amount -= use;
      income -= use;
    }
  }
  return queue.filter((q) => year - q.year <= 3).reduce((s, q) => s + q.amount, 0);
}
