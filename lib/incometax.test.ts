import { describe, expect, it } from 'vitest';
import { basicDeduction, incomeTaxBase, simulateIncomeTax } from './incometax';
import { DeductionEntry, emptyDeduction } from './types';

function ded(over: Partial<DeductionEntry>): DeductionEntry {
  return { ...emptyDeduction(2026), ...over };
}

describe('incomeTaxBase: 速算表', () => {
  it('各税率区分の境界で正しい税額になる', () => {
    expect(incomeTaxBase(1_950_000)).toBe(97_500); // 5%
    expect(incomeTaxBase(3_300_000)).toBe(232_500); // 10% − 97,500
    expect(incomeTaxBase(6_950_000)).toBe(962_500); // 20% − 427,500
    expect(incomeTaxBase(9_000_000)).toBe(1_434_000); // 23% − 636,000
    expect(incomeTaxBase(18_000_000)).toBe(4_404_000); // 33% − 1,536,000
    expect(incomeTaxBase(40_000_000)).toBe(13_204_000); // 40% − 2,796,000
    expect(incomeTaxBase(50_000_000)).toBe(17_704_000); // 45% − 4,796,000
    expect(incomeTaxBase(0)).toBe(0);
  });
});

describe('basicDeduction: 基礎控除(令和7年度改正対応)', () => {
  it('2024年分まで: 48万円(2,400万円超は逓減)', () => {
    expect(basicDeduction(5_000_000, 2024)).toBe(480_000);
    expect(basicDeduction(24_000_000, 2024)).toBe(480_000);
    expect(basicDeduction(24_100_000, 2024)).toBe(320_000);
    expect(basicDeduction(24_600_000, 2024)).toBe(160_000);
    expect(basicDeduction(26_000_000, 2024)).toBe(0);
  });

  it('2025・2026年分: 58万円+時限上乗せ(132万以下95万/336万以下88万/489万以下68万/655万以下63万)', () => {
    expect(basicDeduction(1_000_000, 2026)).toBe(950_000);
    expect(basicDeduction(1_320_000, 2026)).toBe(950_000);
    expect(basicDeduction(2_000_000, 2026)).toBe(880_000);
    expect(basicDeduction(4_000_000, 2026)).toBe(680_000);
    expect(basicDeduction(5_000_000, 2026)).toBe(630_000);
    expect(basicDeduction(8_000_000, 2026)).toBe(580_000);
    expect(basicDeduction(23_500_000, 2026)).toBe(580_000);
    expect(basicDeduction(23_600_000, 2026)).toBe(480_000);
    expect(basicDeduction(26_000_000, 2026)).toBe(0);
  });

  it('2027年分以降: 時限上乗せが終わり、132万円以下95万円と58万円だけになる', () => {
    expect(basicDeduction(1_000_000, 2027)).toBe(950_000);
    expect(basicDeduction(2_000_000, 2027)).toBe(580_000);
    expect(basicDeduction(5_000_000, 2027)).toBe(580_000);
    expect(basicDeduction(23_600_000, 2027)).toBe(480_000);
  });
});

describe('simulateIncomeTax', () => {
  it('青色控除→所得控除→千円未満切捨て→速算表→復興税の順に計算する(2026年分)', () => {
    // 事業所得500万(控除前) − 青色65万 = 435万
    // 控除: 社保80万 + 基礎68万(2026年・合計所得336万超489万以下) = 148万 → 課税所得 287万
    const r = simulateIncomeTax(5_000_000, ded({ socialInsurance: 800_000 }));
    expect(r.blueApplied).toBe(650_000);
    expect(r.totalIncome).toBe(4_350_000);
    expect(r.basic).toBe(680_000);
    expect(r.totalDeductions).toBe(1_480_000);
    expect(r.taxable).toBe(2_870_000);
    expect(r.incomeTax).toBe(2_870_000 * 0.1 - 97_500); // 189,500
    expect(r.reconstructionTax).toBe(Math.floor(189_500 * 0.021)); // 3,979
    expect(r.totalTax).toBe(193_479);
    // 源泉0 → 納付は100円未満切捨て
    expect(r.balanceDue).toBe(193_400);
  });

  it('同じ所得でも年分で基礎控除が変わる(2024年48万 / 2027年58万)', () => {
    const r2024 = simulateIncomeTax(5_000_000, ded({ year: 2024 }));
    const r2027 = simulateIncomeTax(5_000_000, ded({ year: 2027 }));
    expect(r2024.basic).toBe(480_000);
    expect(r2027.basic).toBe(580_000);
  });

  it('青色控除は所得を限度とし、赤字なら税額0', () => {
    const r = simulateIncomeTax(300_000, ded({}));
    expect(r.blueApplied).toBe(300_000);
    expect(r.totalIncome).toBe(0);
    expect(r.taxable).toBe(0);
    expect(r.totalTax).toBe(0);
  });

  it('医療費控除の足切り: min(10万円, 所得の5%)を引く', () => {
    // 所得150万(青色10万選択・160万−10万)→ 5% = 7.5万 < 10万
    const r = simulateIncomeTax(
      1_600_000,
      ded({ blueDeduction: 100000, medicalPaid: 200_000, medicalReimbursed: 30_000 }),
    );
    // 200,000 − 30,000 − 75,000 = 95,000
    expect(r.medicalDeduction).toBe(95_000);
  });

  it('寄附金控除は所得の40%を上限に2,000円を差し引く', () => {
    const r = simulateIncomeTax(5_000_000, ded({ donations: 50_000 }));
    expect(r.donationDeduction).toBe(48_000);
    // 上限: 所得435万 × 40% = 174万
    const r2 = simulateIncomeTax(5_000_000, ded({ donations: 3_000_000 }));
    expect(r2.donationDeduction).toBe(1_740_000 - 2_000);
  });

  it('源泉徴収が税額を上回ると還付(マイナス)になる', () => {
    const r = simulateIncomeTax(3_000_000, ded({ socialInsurance: 500_000, withholding: 300_000 }));
    expect(r.balanceDue).toBeLessThan(0);
  });

  it('生命保険料・地震保険料の上限が自動適用される', () => {
    const r = simulateIncomeTax(
      5_000_000,
      ded({ lifeInsurance: 200_000, earthquakeInsurance: 80_000 }),
    );
    const life = r.breakdown.find((l) => l.label === '生命保険料控除')!;
    const eq = r.breakdown.find((l) => l.label === '地震保険料控除')!;
    expect(life.amount).toBe(120_000);
    expect(eq.amount).toBe(50_000);
  });

  it('復興特別所得税は2037年分まで(2038年分以降は0)', () => {
    const r2037 = simulateIncomeTax(5_000_000, ded({ year: 2037 }));
    const r2038 = simulateIncomeTax(5_000_000, ded({ year: 2038 }));
    expect(r2037.reconstructionTax).toBeGreaterThan(0);
    expect(r2038.reconstructionTax).toBe(0);
  });

  it('個人事業税は青色控除前の所得から事業主控除290万円を引いて5%', () => {
    const r = simulateIncomeTax(5_000_000, ded({}));
    expect(r.businessTaxEst).toBe((5_000_000 - 2_900_000) * 0.05);
    expect(simulateIncomeTax(2_000_000, ded({})).businessTaxEst).toBe(0);
  });
});
