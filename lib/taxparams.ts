/**
 * 税制パラメータの一覧(年度で変わるものを1箇所に集約)。
 * 毎年の税制改正はこのファイルを更新すれば全機能に反映される。
 * 最終確認: 令和8年度税制改正まで反映(2026年11月時点。令和9年分の源泉徴収税額表・
 * 防衛特別所得税を含む)。
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

/** 合計所得2,350万円超の逓減部分(令和7年分以後共通) */
const BASIC_DEDUCTION_HIGH_INCOME: DeductionStep[] = [
  { limit: 24_000_000, amount: 480_000 },
  { limit: 24_500_000, amount: 320_000 },
  { limit: 25_000_000, amount: 160_000 },
  { limit: Infinity, amount: 0 },
];

/**
 * 基礎控除の表(令和8年度税制改正対応)。
 * - 2024年分まで: 48万円(2,400万円超は逓減)
 * - 2025年分: 本則58万円 + 特例加算(132万以下95万/336万以下88万/489万以下68万/655万以下63万)
 * - 2026・2027年分: 本則62万円 + 特例加算(489万以下104万/655万以下67万)
 * - 2028年分以後: 本則62万円。合計所得132万円以下は99万円(37万円加算)
 * 令和8年度改正で基礎控除は物価に連動して見直す仕組みになったため、
 * 2028年分以後の額は今後の改正で変わりうる(改正のたびにここを更新する)。
 */
export function basicDeductionTableFor(year: number): DeductionStep[] {
  if (year <= 2024) return BASIC_DEDUCTION_HIGH_INCOME;
  if (year === 2025) {
    return [
      { limit: 1_320_000, amount: 950_000 },
      { limit: 3_360_000, amount: 880_000 },
      { limit: 4_890_000, amount: 680_000 },
      { limit: 6_550_000, amount: 630_000 },
      { limit: 23_500_000, amount: 580_000 },
      ...BASIC_DEDUCTION_HIGH_INCOME,
    ];
  }
  if (year <= 2027) {
    return [
      { limit: 4_890_000, amount: 1_040_000 },
      { limit: 6_550_000, amount: 670_000 },
      { limit: 23_500_000, amount: 620_000 },
      ...BASIC_DEDUCTION_HIGH_INCOME,
    ];
  }
  return [
    { limit: 1_320_000, amount: 990_000 },
    { limit: 23_500_000, amount: 620_000 },
    ...BASIC_DEDUCTION_HIGH_INCOME,
  ];
}

/**
 * 給与所得控除の最低保障額(年末調整用)。
 * 2025年分: 65万円(令和7年度改正)/ 2026・2027年分: 74万円(本則69万円 + 特例5万円)/
 * 2028年分以後: 69万円(令和8年度改正)。
 */
export function salaryDeductionMinimumFor(year: number): number {
  if (year <= 2024) return 550_000;
  if (year === 2025) return 650_000;
  if (year <= 2027) return 740_000;
  return 690_000;
}

/**
 * 給与所得の金額の表(所得税法別表第五。収入660万円未満)を求めるための年分ごとの定義。
 * - 収入が exactBelow 未満: 「収入 − 最低保障額」(円単位)
 * - bands: 最低保障との境目に定められた固定額の行(収入 from 以上 to 未満 → income)
 * - それ以上: 収入を4,000円単位に切り捨てて計算(国税庁「給与所得の金額の計算」の方法)
 * estimated: 表が未公表の年分(2028年分以後)。最低保障額だけで推計する
 */
export interface SalaryIncomeTable {
  minimum: number;
  exactBelow: number;
  bands: { from: number; to: number; income: number }[];
  estimated: boolean;
}

export function salaryIncomeTableFor(year: number): SalaryIncomeTable {
  const minimum = salaryDeductionMinimumFor(year);
  // 令和2年分〜令和6年分
  if (year <= 2024) {
    return {
      minimum,
      exactBelow: 1_619_000,
      bands: [
        { from: 1_619_000, to: 1_620_000, income: 1_069_000 },
        { from: 1_620_000, to: 1_622_000, income: 1_070_000 },
        { from: 1_622_000, to: 1_624_000, income: 1_072_000 },
        { from: 1_624_000, to: 1_628_000, income: 1_074_000 },
      ],
      estimated: false,
    };
  }
  // 令和7年分(190万円で最低保障と4,000円刻みの表がちょうどつながる)
  if (year === 2025) return { minimum, exactBelow: 1_900_000, bands: [], estimated: false };
  // 令和8年分・令和9年分(国税庁 No.1410 の(注2)の表)
  if (year <= 2027) {
    return {
      minimum,
      exactBelow: 2_191_000,
      bands: [
        { from: 2_191_000, to: 2_193_000, income: 1_451_000 },
        { from: 2_193_000, to: 2_196_000, income: 1_453_000 },
        { from: 2_196_000, to: 2_200_000, income: 1_456_000 },
      ],
      estimated: false,
    };
  }
  return { minimum, exactBelow: 0, bands: [], estimated: true };
}

/** 所得税額(基準所得税額)に上乗せされる税 */
export interface IncomeSurtax {
  /** 所得税額に対する税率の合計(千分率。21 = 2.1%)。上乗せのない年分は 0 */
  permille: number;
  /** 上乗せ分の名称(画面・様式イメージの表示用) */
  name: string;
  /** 短い呼び名 */
  shortName: string;
  /** 所得税と合わせた税額の名称 */
  totalName: string;
}

/**
 * 指定年分の、所得税額への上乗せ(復興特別所得税・防衛特別所得税)。
 * - 2013〜2026年分: 復興特別所得税 2.1%
 * - 2027〜2047年分: 防衛特別所得税 1% + 復興特別所得税 1.1%(合計は 2.1% のまま)
 * - 2048年分以後: 防衛特別所得税 1%(課税期間は「当分の間」で、終わりの年は決まっていない)
 * 令和8年度改正で、令和9年1月1日以後に生ずる所得から防衛特別所得税が創設され、
 * 復興特別所得税は税率を 2.1% → 1.1% に下げて、課税期間を令和29年(2047年)分まで10年延長した。
 * 2027年分以後の申告書の様式は未公表のため、上乗せ分は源泉徴収と同じく合計税率でまとめて計算する
 * (税目ごとに1円未満を切り捨てる様式になった場合は、1円ずれることがある)。
 * 税率は浮動小数点の誤差を避けるため千分率の整数で持つ
 */
export function incomeSurtaxFor(year: number): IncomeSurtax {
  if (year >= 2048) {
    return { permille: 10, name: '防衛特別所得税', shortName: '防衛税', totalName: '所得税及び防衛特別所得税' };
  }
  if (year >= 2027) {
    return {
      permille: 21,
      name: '防衛特別所得税及び復興特別所得税',
      shortName: '防衛・復興税',
      totalName: '所得税、防衛特別所得税及び復興特別所得税',
    };
  }
  return {
    permille: year >= 2013 ? 21 : 0,
    name: '復興特別所得税',
    shortName: '復興税',
    totalName: '所得税及び復興特別所得税',
  };
}

/** 上乗せ分の税率の表示(「2.1%」など) */
export function incomeSurtaxRateLabel(year: number): string {
  return `${incomeSurtaxFor(year).permille / 10}%`;
}

/**
 * 青色申告特別控除の枠(円)。
 * 令和8年度改正で2027年分(令和9年分)から、正規の簿記で記帳している場合は
 * 「e-Tax提出 + 優良な電子帳簿の保存等」75万円 /「e-Tax提出」65万円 /「書面提出」10万円になる
 * (55万円の枠は廃止。2026年分までは 65万円 / 55万円(書面提出)/ 10万円(簡易簿記))。
 */
export type BlueDeductionAmount = 750_000 | 650_000 | 550_000 | 100_000;

/** 75万円枠の新設・55万円枠の廃止が適用される最初の年分 */
export const BLUE_DEDUCTION_REFORM_YEAR = 2027;

/** その年分で選べる青色申告特別控除の枠(大きい順) */
export function blueDeductionOptionsFor(year: number): BlueDeductionAmount[] {
  return year >= BLUE_DEDUCTION_REFORM_YEAR
    ? [750_000, 650_000, 100_000]
    : [650_000, 550_000, 100_000];
}

/**
 * その年分にない枠を読み替える(改正前に保存した2027年分の入力・壊れた値の読込用)。
 * 55万円(書面提出)は2027年分から10万円、75万円は2026年分以前にはないため65万円にする
 */
export function normalizeBlueDeduction(year: number, value: unknown): BlueDeductionAmount {
  const options = blueDeductionOptionsFor(year);
  if (options.includes(value as BlueDeductionAmount)) return value as BlueDeductionAmount;
  return value === 550_000 ? 100_000 : 650_000;
}

// ── 住民税・事業税(概算用) ──────────────────────────────

/** 住民税の概算(所得割 + 均等割。森林環境税を含むおおよその値) */
export const RESIDENT_TAX = { rate: 0.1, perCapita: 5_000 };

/**
 * 住民税の基礎控除(概算用)。令和7・8年度改正の基礎控除引き上げは所得税のみで、
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
 * 令和8年度改正で 2026/10〜70% → 2028/10〜50% → 2030/10〜30% → 2031/10〜0% に緩和
 * (改正前は 2026/10〜50% → 2029/10〜0%)。
 */
export const INVOICE_TRANSITION_STEPS: { before: string; rate: number }[] = [
  { before: '2023-10-01', rate: 100 }, // 制度開始前(区分記載請求書で全額控除)
  { before: '2026-10-01', rate: 80 },
  { before: '2028-10-01', rate: 70 },
  { before: '2030-10-01', rate: 50 },
  { before: '2031-10-01', rate: 30 },
];
export const INVOICE_TRANSITION_AFTER = 0;

// ── 源泉徴収 ─────────────────────────────────────────────

/**
 * 報酬・料金等の源泉徴収(原稿料・デザイン料など)。
 * 税率は所得税率 × 102.1%(2026年まで: 復興特別所得税 2.1% / 2027年から: 防衛特別所得税 1% +
 * 復興特別所得税 1.1%)。合計税率は変わらないため、2027年以後もこのまま使う
 */
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
 * 基礎控除の見直しに伴い、ラインは年分ごとに引き上げられている:
 * - 令和7年分(2025年)まで: 月額 88,000円 / 日額 9,300円
 * - 令和8年分(2026年1月1日以後に支払う給与): 月額 105,000円 / 日額 9,800円
 *   (令和7年4月30日財務省告示第122号)
 * - 令和9年分(2027年1月1日以後に支払う給与)から: 月額 111,000円 / 日額 10,000円
 *   (令和8年4月30日財務省告示第127号。税額には防衛特別所得税 1% と復興特別所得税 1.1% を含む。
 *    合計 2.1% は変わらないため、乙欄の 3.063% もそのまま)
 * 翌年分の税額表が告示されたら、ここに年分岐を足す(告示前の年分は直近の表で判定する)
 */
export function salaryWithholdingFor(year: number): {
  monthlyZeroUnder: number;
  otsuRate: number;
  dailyZeroUnder: number;
} {
  if (year >= 2027) return { monthlyZeroUnder: 111_000, otsuRate: 0.03063, dailyZeroUnder: 10_000 };
  if (year === 2026) return { monthlyZeroUnder: 105_000, otsuRate: 0.03063, dailyZeroUnder: 9_800 };
  return { monthlyZeroUnder: 88_000, otsuRate: 0.03063, dailyZeroUnder: 9_300 };
}

/**
 * 消費税の2割特例(インボイス登録を機に課税事業者になった小規模事業者の負担軽減)。
 * 令和5年10月1日〜令和8年9月30日の属する課税期間まで
 * = 個人事業者は 2023年分(10〜12月)〜2026年分の申告が対象。
 */
export const SPECIAL20 = { firstYear: 2023, lastYear: 2026 };

/**
 * 3割特例(令和8年度改正で創設。個人事業者のみ)。2割特例の終了後、
 * 令和9年分・令和10年分(2027・2028年分)は売上の消費税の3割を納付する。
 * 対象は2割特例と同じく、インボイス登録がなければ免税事業者だった小規模事業者
 * (基準期間の課税売上高1,000万円以下など)。
 */
export const SPECIAL30 = { firstYear: 2027, lastYear: 2028 };

/**
 * 小規模事業者の特例(2割特例・3割特例)で、売上の消費税のうち納付する割合(%)。
 * その年分に特例がなければ null
 */
export function smallBusinessSpecialRate(year: number): 20 | 30 | null {
  if (year >= SPECIAL20.firstYear && year <= SPECIAL20.lastYear) return 20;
  if (year >= SPECIAL30.firstYear && year <= SPECIAL30.lastYear) return 30;
  return null;
}

// ── 減価償却(200%定率法) ────────────────────────────────

/**
 * 定率法(200%定率法・平成24年4月1日以後取得)の償却率・改定償却率・保証率。
 * 耐用年数省令 別表第十より。浮動小数点を避けるため
 * 償却率・改定償却率は千分率、保証率は十万分率の整数で持つ。
 * [rate1000, revised1000, guarantee100000]
 * 耐用年数2年は償却率1.000(改定償却率・保証率の定めなし)。
 * 51年以上は原典未収載のためアプリでは対応しない(定率法を選べる資産は実務上ほぼ22年以下)。
 */
export const DECLINING_200_MAX_LIFE = 50;
const DECLINING_200: Record<number, [number, number, number]> = {
  2: [1000, 1000, 0],
  3: [667, 1000, 11089],
  4: [500, 1000, 12499],
  5: [400, 500, 10800],
  6: [333, 334, 9911],
  7: [286, 334, 8680],
  8: [250, 334, 7909],
  9: [222, 250, 7126],
  10: [200, 250, 6552],
  11: [182, 200, 5992],
  12: [167, 200, 5566],
  13: [154, 167, 5180],
  14: [143, 167, 4854],
  15: [133, 143, 4565],
  16: [125, 143, 4294],
  17: [118, 125, 4038],
  18: [111, 112, 3884],
  19: [105, 112, 3693],
  20: [100, 112, 3486],
  21: [95, 100, 3335],
  22: [91, 100, 3182],
  23: [87, 91, 3052],
  24: [83, 84, 2969],
  25: [80, 84, 2841],
  26: [77, 84, 2716],
  27: [74, 77, 2624],
  28: [71, 72, 2568],
  29: [69, 72, 2463],
  30: [67, 72, 2366],
  31: [65, 67, 2286],
  32: [63, 67, 2216],
  33: [61, 63, 2161],
  34: [59, 63, 2097],
  35: [57, 59, 2051],
  36: [56, 59, 1974],
  37: [54, 56, 1950],
  38: [53, 56, 1882],
  39: [51, 53, 1860],
  40: [50, 53, 1791],
  41: [49, 50, 1741],
  42: [48, 50, 1694],
  43: [47, 48, 1664],
  44: [45, 46, 1664],
  45: [44, 46, 1634],
  46: [43, 44, 1601],
  47: [43, 44, 1532],
  48: [42, 44, 1499],
  49: [41, 42, 1475],
  50: [40, 42, 1440],
};

/** 定率法の係数(耐用年数は2〜50年に丸める) */
export function declining200For(usefulLife: number): {
  rate1000: number;
  revised1000: number;
  guarantee100000: number;
} {
  const n = Math.max(2, Math.min(DECLINING_200_MAX_LIFE, Math.round(usefulLife)));
  const [rate1000, revised1000, guarantee100000] = DECLINING_200[n];
  return { rate1000, revised1000, guarantee100000 };
}

// ── 減価償却・少額資産 ──────────────────────────────────

export const SMALL_ASSET = {
  /** これ以上は原則、減価償却資産(消耗品費にできない) */
  depreciationMin: 100_000,
  /** 一括償却資産(3年均等)を選べる上限(未満) */
  lumpMax: 200_000,
  /** 少額特例の年間合計の上限 */
  immediateYearCap: 3_000_000,
  /** 償却資産税(固定資産税)の免税点(課税標準) */
  shokyakuShisanExemption: 1_500_000,
};

/**
 * 少額減価償却資産の特例(青色申告・措法28の2)の取得価額の上限(未満)。取得日で判定する。
 * 令和8年度改正で 2026/4/1 以後の取得は40万円未満に引き上げ、適用期限は 2029/3/31 まで延長。
 */
export const SMALL_ASSET_IMMEDIATE = {
  /** 40万円未満になる取得日(以後) */
  raisedFrom: '2026-04-01',
  /** 適用期限(この日までの取得が対象) */
  until: '2029-03-31',
  maxBefore: 300_000,
  maxAfter: 400_000,
} as const;

/** 取得日時点の少額特例の上限(未満)。適用期限後の取得は null(特例なし) */
export function immediateMaxFor(acquiredDate: string): number | null {
  if (acquiredDate > SMALL_ASSET_IMMEDIATE.until) return null;
  return acquiredDate >= SMALL_ASSET_IMMEDIATE.raisedFrom
    ? SMALL_ASSET_IMMEDIATE.maxAfter
    : SMALL_ASSET_IMMEDIATE.maxBefore;
}
