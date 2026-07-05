/**
 * 税制パラメータの一覧(年度で変わるものを1箇所に集約)。
 * 毎年の税制改正はこのファイルを更新すれば全機能に反映される。
 * 最終確認: 令和7年度税制改正まで反映(2026年時点)。
 */

// ── 所得税 ──────────────────────────────────────────────

export interface TaxBracket {
  limit: number;
  rate: number;
  deduction: number;
}

/** 所得税の速算表(平成27年分以後、現行) */
const BRACKETS_2015: TaxBracket[] = [
  { limit: 1_950_000, rate: 0.05, deduction: 0 },
  { limit: 3_300_000, rate: 0.1, deduction: 97_500 },
  { limit: 6_950_000, rate: 0.2, deduction: 427_500 },
  { limit: 9_000_000, rate: 0.23, deduction: 636_000 },
  { limit: 18_000_000, rate: 0.33, deduction: 1_536_000 },
  { limit: 40_000_000, rate: 0.4, deduction: 2_796_000 },
  { limit: Infinity, rate: 0.45, deduction: 4_796_000 },
];

/** 指定年分の速算表(改正時はここで年分岐を足す) */
export function incomeTaxBracketsFor(_year: number): TaxBracket[] {
  return BRACKETS_2015;
}

export interface DeductionStep {
  /** 合計所得金額の上限(この金額以下なら amount) */
  limit: number;
  amount: number;
}

/**
 * 基礎控除の表(令和7年度税制改正対応)。
 * - 2024年分まで: 48万円(2,400万円超は逓減)
 * - 2025年分以降: 58万円。合計所得132万円以下は95万円(恒久)
 * - 2025・2026年分のみ: 中間所得層への時限上乗せ(88万/68万/63万円)
 */
export function basicDeductionTableFor(year: number): DeductionStep[] {
  if (year <= 2024) {
    return [
      { limit: 24_000_000, amount: 480_000 },
      { limit: 24_500_000, amount: 320_000 },
      { limit: 25_000_000, amount: 160_000 },
      { limit: Infinity, amount: 0 },
    ];
  }
  const base: DeductionStep[] = [
    { limit: 1_320_000, amount: 950_000 },
    ...(year <= 2026
      ? [
          { limit: 3_360_000, amount: 880_000 },
          { limit: 4_890_000, amount: 680_000 },
          { limit: 6_550_000, amount: 630_000 },
        ]
      : []),
    { limit: 23_500_000, amount: 580_000 },
    { limit: 24_000_000, amount: 480_000 },
    { limit: 24_500_000, amount: 320_000 },
    { limit: 25_000_000, amount: 160_000 },
    { limit: Infinity, amount: 0 },
  ];
  return base;
}

/** 復興特別所得税(所得税額に対する上乗せ)。2013〜2037年分 */
export const RECONSTRUCTION_TAX = { rate: 0.021, fromYear: 2013, toYear: 2037 };

/** 青色申告特別控除の選択肢 */
export const BLUE_DEDUCTION_OPTIONS = [650_000, 550_000, 100_000] as const;

// ── 住民税・事業税(概算用) ──────────────────────────────

/** 住民税の概算(所得割 + 均等割。森林環境税を含むおおよその値) */
export const RESIDENT_TAX = { rate: 0.1, perCapita: 5_000 };

/**
 * 住民税の基礎控除(概算用)。令和7年度改正の基礎控除引き上げは所得税のみで、
 * 住民税は43万円のまま(2,400万円超は逓減)。所得税の基礎控除で代用すると
 * 2025年分以降は住民税を大きく過小に見積もるため、基礎控除だけ引き直して計算する。
 */
export const RESIDENT_BASIC_DEDUCTION: DeductionStep[] = [
  { limit: 24_000_000, amount: 430_000 },
  { limit: 24_500_000, amount: 290_000 },
  { limit: 25_000_000, amount: 150_000 },
  { limit: Infinity, amount: 0 },
];

/** 個人事業税(第1種事業などの標準的な場合) */
export const BUSINESS_TAX = { ownerDeduction: 2_900_000, rate: 0.05 };

// ── 消費税(インボイス) ──────────────────────────────────

export const CONSUMPTION_TAX = { standardRate: 10, reducedRate: 8 } as const;

/**
 * 適格請求書(インボイス)なしの課税仕入の控除割合(経過措置)。
 * 日付順に評価し、最初に一致した割合を使う。
 */
export const INVOICE_TRANSITION_STEPS: { before: string; rate: number }[] = [
  { before: '2023-10-01', rate: 100 }, // 制度開始前(区分記載請求書で全額控除)
  { before: '2026-10-01', rate: 80 },
  { before: '2029-10-01', rate: 50 },
];
export const INVOICE_TRANSITION_AFTER = 0;

// ── 源泉徴収 ─────────────────────────────────────────────

/** 報酬・料金等の源泉徴収(原稿料・デザイン料など) */
export const REWARD_WITHHOLDING = {
  rate: 0.1021,
  rateOver: 0.2042,
  threshold: 1_000_000,
};

/**
 * 給与の源泉徴収の簡易判定ライン(支払年分の源泉徴収税額表より)。
 * 判定はいずれも「その月(日)の社会保険料等控除後の給与等の金額」で行う。
 * - 甲欄(扶養控除等申告書あり): 月額 monthlyZeroUnder 円未満は0円
 * - 乙欄(申告書なし・他に主たる給与あり): 月額 monthlyZeroUnder 円未満は 3.063%
 * - 丙欄(日雇い・継続2ヶ月以内): 日額 dailyZeroUnder 円未満は0円
 * これらのライン以上は税額表の参照が必要(自動計算しない)。
 * 令和8年分(2026年1月1日以後に支払う給与)から、基礎控除の見直しに伴い
 * 各ラインが引き上げ(令和7年4月30日財務省告示第122号)。
 */
export function salaryWithholdingFor(year: number): {
  monthlyZeroUnder: number;
  otsuRate: number;
  dailyZeroUnder: number;
} {
  return year >= 2026
    ? { monthlyZeroUnder: 105_000, otsuRate: 0.03063, dailyZeroUnder: 9_800 }
    : { monthlyZeroUnder: 88_000, otsuRate: 0.03063, dailyZeroUnder: 9_300 };
}

/**
 * 消費税の2割特例(インボイス登録を機に課税事業者になった小規模事業者の負担軽減)。
 * 令和5年10月1日〜令和8年9月30日の属する課税期間まで
 * = 個人事業者は 2023年分(10〜12月)〜2026年分の申告が対象。
 */
export const SPECIAL20 = { firstYear: 2023, lastYear: 2026 };

// ── 減価償却・少額資産 ──────────────────────────────────

export const SMALL_ASSET = {
  /** これ以上は原則、減価償却資産(消耗品費にできない) */
  depreciationMin: 100_000,
  /** 一括償却資産(3年均等)を選べる上限(未満) */
  lumpMax: 200_000,
  /** 少額減価償却資産の特例の上限(未満・青色申告) */
  immediateMax: 300_000,
  /** 少額特例の年間合計の上限 */
  immediateYearCap: 3_000_000,
  /** 償却資産税(固定資産税)の免税点(課税標準) */
  shokyakuShisanExemption: 1_500_000,
};
