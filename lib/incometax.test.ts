import { describe, expect, it } from 'vitest';
import { basicDeduction, incomeTaxBase, simulateIncomeTax, suggestedLossCarryforward } from './incometax';
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

describe('basicDeduction: 基礎控除(令和8年度改正対応)', () => {
  it('2024年分まで: 48万円(2,400万円超は逓減)', () => {
    expect(basicDeduction(5_000_000, 2024)).toBe(480_000);
    expect(basicDeduction(24_000_000, 2024)).toBe(480_000);
    expect(basicDeduction(24_100_000, 2024)).toBe(320_000);
    expect(basicDeduction(24_600_000, 2024)).toBe(160_000);
    expect(basicDeduction(26_000_000, 2024)).toBe(0);
  });

  it('2025年分: 58万円+上乗せ(132万以下95万/336万以下88万/489万以下68万/655万以下63万)', () => {
    expect(basicDeduction(1_000_000, 2025)).toBe(950_000);
    expect(basicDeduction(1_320_000, 2025)).toBe(950_000);
    expect(basicDeduction(2_000_000, 2025)).toBe(880_000);
    expect(basicDeduction(4_000_000, 2025)).toBe(680_000);
    expect(basicDeduction(5_000_000, 2025)).toBe(630_000);
    expect(basicDeduction(8_000_000, 2025)).toBe(580_000);
    expect(basicDeduction(23_500_000, 2025)).toBe(580_000);
    expect(basicDeduction(23_600_000, 2025)).toBe(480_000);
    expect(basicDeduction(26_000_000, 2025)).toBe(0);
  });

  it('2026・2027年分: 本則62万円+特例(489万以下104万/655万以下67万)', () => {
    for (const year of [2026, 2027]) {
      expect(basicDeduction(1_000_000, year)).toBe(1_040_000);
      expect(basicDeduction(4_890_000, year)).toBe(1_040_000);
      expect(basicDeduction(4_890_001, year)).toBe(670_000);
      expect(basicDeduction(6_550_000, year)).toBe(670_000);
      expect(basicDeduction(6_550_001, year)).toBe(620_000);
      expect(basicDeduction(23_500_000, year)).toBe(620_000);
      expect(basicDeduction(23_600_000, year)).toBe(480_000);
      expect(basicDeduction(24_100_000, year)).toBe(320_000);
      expect(basicDeduction(24_600_000, year)).toBe(160_000);
      expect(basicDeduction(26_000_000, year)).toBe(0);
    }
  });

  it('2028年分以後: 本則62万円。合計所得132万円以下のみ99万円', () => {
    expect(basicDeduction(1_320_000, 2028)).toBe(990_000);
    expect(basicDeduction(1_320_001, 2028)).toBe(620_000);
    expect(basicDeduction(5_000_000, 2028)).toBe(620_000);
    expect(basicDeduction(23_600_000, 2028)).toBe(480_000);
    expect(basicDeduction(26_000_000, 2028)).toBe(0);
  });
});

describe('simulateIncomeTax', () => {
  it('青色控除→所得控除→千円未満切捨て→速算表→復興税の順に計算する(2026年分)', () => {
    // 事業所得500万(控除前) − 青色65万 = 435万
    // 控除: 社保80万 + 基礎104万(2026年・合計所得489万以下) = 184万 → 課税所得 251万
    const r = simulateIncomeTax(5_000_000, ded({ socialInsurance: 800_000 }));
    expect(r.blueApplied).toBe(650_000);
    expect(r.totalIncome).toBe(4_350_000);
    expect(r.basic).toBe(1_040_000);
    expect(r.totalDeductions).toBe(1_840_000);
    expect(r.taxable).toBe(2_510_000);
    expect(r.incomeTax).toBe(153_500); // 2,510,000×10% − 97,500
    expect(r.reconstructionTax).toBe(3_223); // 153,500×2.1% = 3,223.5 → 切捨て
    expect(r.totalTax).toBe(156_723);
    // 源泉0 → 納付は100円未満切捨て
    expect(r.balanceDue).toBe(156_700);
  });

  it('同じ所得(合計所得435万円)でも年分で基礎控除が変わる', () => {
    const basicOf = (year: number) => simulateIncomeTax(5_000_000, ded({ year })).basic;
    expect(basicOf(2024)).toBe(480_000);
    expect(basicOf(2025)).toBe(680_000);
    expect(basicOf(2026)).toBe(1_040_000);
    expect(basicOf(2027)).toBe(1_040_000);
    expect(basicOf(2028)).toBe(620_000);
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

  it('住民税の概算は基礎控除を43万円(住民税の額)に置き換えて計算する', () => {
    // 事業所得500万 − 青色65万 = 所得435万。社保80万。
    // 所得税: 基礎104万(2026年) → 課税所得251万 / 住民税: 基礎43万 → 課税標準312万
    const r = simulateIncomeTax(5_000_000, ded({ socialInsurance: 800_000 }));
    expect(r.taxable).toBe(2_510_000);
    expect(r.residentTaxEst).toBe(3_120_000 * 0.1 + 5_000);
    // 改正のない2024年分は差が5万円(48万−43万)だけ
    const r2024 = simulateIncomeTax(5_000_000, ded({ year: 2024, socialInsurance: 800_000 }));
    expect(r2024.residentTaxEst).toBe((r2024.taxable + 50_000) * 0.1 + 5_000);
  });
});

describe('予定納税・純損失の繰越控除', () => {
  it('予定納税額は申告納税額(源泉差引後・100円未満切捨て)から引き、第3期分にする', () => {
    // 税額 156,723 − 源泉 0 → 申告納税額 156,700 − 予定納税 100,000 = 56,700
    const r = simulateIncomeTax(5_000_000, ded({ socialInsurance: 800_000, prepaidTax: 100_000 }));
    expect(r.filingTax).toBe(156_700);
    expect(r.balanceDue).toBe(56_700);
    // 予定納税が多すぎれば還付
    expect(simulateIncomeTax(5_000_000, ded({ socialInsurance: 800_000, prepaidTax: 200_000 })).balanceDue).toBe(-43_300);
  });

  it('繰越損失は合計所得金額から引く。基礎控除は繰越前の合計所得金額、医療費の足切りは控除後で判定する', () => {
    // 事業所得 500万 − 青色65万 = 合計所得435万 → 繰越損失300万 → 総所得金額等135万
    const r = simulateIncomeTax(
      5_000_000,
      ded({ lossCarryforward: 3_000_000, medicalPaid: 150_000 }),
    );
    expect(r.totalIncome).toBe(4_350_000);
    expect(r.lossApplied).toBe(3_000_000);
    expect(r.incomeAfterLoss).toBe(1_350_000);
    expect(r.basic).toBe(1_040_000); // 合計所得435万(489万以下)で判定
    expect(r.medicalDeduction).toBe(150_000 - 67_500); // 足切りは総所得金額等135万の5%
    expect(r.taxable).toBe(Math.floor((1_350_000 - 1_040_000 - 82_500) / 1000) * 1000);
    expect(r.lossToCarry).toBe(0);
  });

  it('所得を超える繰越損失は使い切れず、赤字の年はその赤字も翌年へ繰り越せる', () => {
    const r = simulateIncomeTax(1_000_000, ded({ lossCarryforward: 800_000 }));
    // 合計所得 100万 − 65万 = 35万 → 繰越35万を使い、残り45万を翌年へ
    expect(r.lossApplied).toBe(350_000);
    expect(r.lossToCarry).toBe(450_000);
    const loss = simulateIncomeTax(-600_000, ded({ lossCarryforward: 100_000 }));
    expect(loss.lossToCarry).toBe(700_000);
    expect(loss.totalTax).toBe(0);
  });

  it('帳簿からの繰越額の目安: 古い損失から使い、3年を過ぎた残りは消える', () => {
    const y = (year: number, profit: number) => ({ year, profit, blueDeduction: 650_000 });
    // 2022年 −300万、2023年 黒字(青色後100万)、2024・2025年 −50万・0
    const years = [y(2022, -3_000_000), y(2023, 1_650_000), y(2024, -500_000), y(2025, 650_000)];
    // 2026年: 2022年分は 300万−100万 = 200万 が残るが、2022+3 = 2025年までで期限切れ → 2024年の50万だけ
    expect(suggestedLossCarryforward(years, 2025)).toBe(2_500_000);
    expect(suggestedLossCarryforward(years, 2026)).toBe(500_000);
    expect(suggestedLossCarryforward([y(2026, -100_000)], 2026)).toBe(0); // その年の赤字は含めない
  });
});
