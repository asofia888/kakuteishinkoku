import { isExcluded, isSettlement } from './accounts';
import { transactionsOfYear } from './aggregate';
import { isDeferred } from './assets';
import {
  INVOICE_TRANSITION_AFTER,
  INVOICE_TRANSITION_STEPS,
  smallBusinessSpecialRate,
} from './taxparams';
import { FixedAsset, TaxCategory, TaxSettings, Transaction } from './types';

/**
 * 消費税(インボイス制度)の集計。
 * 帳簿は税込経理方式を前提とし、税込金額から消費税額を割り戻して概算する。
 * 実際の申告書(付表)は国税・地方消費税を分けて端数処理するため、金額は目安。
 */

/** 税区分の表示ラベル */
export const TAX_CATEGORY_LABELS: Record<TaxCategory, string> = {
  taxable10: '課税 10%',
  taxable8: '課税 8%(軽減)',
  exempt: '非課税',
  none: '不課税・対象外',
};

/**
 * 科目ごとの既定税区分(取引ごとに上書き可能)。
 * 迷いやすい既定: 地代家賃は事務所・コワーキング前提で課税10%
 * (住宅の家賃は非課税のため、自宅按分の場合は取引側で「非課税」に変更する)。
 */
const EXPENSE_DEFAULTS: Record<string, TaxCategory> = {
  taxes_dues: 'none', // 租税公課(税金・行政手数料は不課税/非課税)
  insurance: 'exempt', // 損害保険料(非課税)
  salaries: 'none', // 給料賃金(不課税)
  interest: 'exempt', // 利子割引料(非課税)
  depreciation: 'none', // 減価償却費(取得時に課税済みのため対象外)
};

/** 固定資産の取得(振替科目)。損益には出ないが、消費税では取得した年の課税仕入になる */
const ASSET_PURCHASE = 'asset_purchase';
/** 固定資産の売却代金(振替科目)。所得税では譲渡所得だが、消費税では課税売上になる */
const ASSET_SALE = 'asset_sale';

/**
 * 消費税の集計対象になる科目か。未仕訳・対象外・振替(カード引落し等)は対象外だが、
 * 固定資産の取得は購入時に取得価額の全額が課税仕入に、固定資産の売却代金は課税売上になる
 * (減価償却費は課税仕入ではないため、購入時に控除しないと控除漏れになる)。
 */
export function isTaxRelevant(account: string | null): boolean {
  if (account === null || isExcluded(account)) return false;
  return !isSettlement(account) || account === ASSET_PURCHASE || account === ASSET_SALE;
}

export function defaultTaxCategory(t: Pick<Transaction, 'type' | 'account'>): TaxCategory {
  if (t.account === null || !isTaxRelevant(t.account)) return 'none';
  if (t.type === 'income') return 'taxable10';
  return EXPENSE_DEFAULTS[t.account] ?? 'taxable10';
}

/** 取引に適用される税区分(明示設定があればそれを、なければ科目の既定を使う) */
export function effectiveTaxCategory(
  t: Pick<Transaction, 'type' | 'account' | 'taxCategory'>,
): TaxCategory {
  return t.taxCategory ?? defaultTaxCategory(t);
}

/** 税込金額に含まれる消費税額(円未満切り捨て) */
export function taxInclusive(amount: number, rate: 10 | 8): number {
  return Math.floor((amount * rate) / (100 + rate));
}

/** 簡易課税のみなし仕入率(%)。事業区分1〜6 */
export const DEEMED_PURCHASE_RATES: Record<1 | 2 | 3 | 4 | 5 | 6, number> = {
  1: 90,
  2: 80,
  3: 70,
  4: 60,
  5: 50,
  6: 40,
};

export const SIMPLIFIED_TYPES: { value: 1 | 2 | 3 | 4 | 5 | 6; label: string }[] = [
  { value: 1, label: '第1種 卸売業(みなし仕入率90%)' },
  { value: 2, label: '第2種 小売業など(80%)' },
  { value: 3, label: '第3種 製造業・建設業など(70%)' },
  { value: 4, label: '第4種 飲食店業など(60%)' },
  { value: 5, label: '第5種 サービス業・金融業など(50%)' },
  { value: 6, label: '第6種 不動産業(40%)' },
];

/**
 * 適格請求書(インボイス)なしの課税仕入に対する控除割合(経過措置)。
 * 2023/10〜2026/9: 80% → 2026/10〜2028/9: 70% → 2028/10〜2030/9: 50%
 * → 2030/10〜2031/9: 30% → 以降: 0%(令和8年度改正後。表は lib/taxparams.ts)
 */
export function nonQualifiedDeductionRate(date: string): number {
  for (const step of INVOICE_TRANSITION_STEPS) {
    if (date < step.before) return step.rate;
  }
  return INVOICE_TRANSITION_AFTER;
}

function businessRatioOf(a: FixedAsset): number {
  return Math.min(100, Math.max(1, Math.round(a.businessRatio)));
}

/**
 * 「固定資産の取得」取引ごとの課税仕入の対象額(税込・事業分)。
 * 家事共用資産(車両など)の仕入税額控除は事業分だけなので、固定資産台帳の事業専用割合を掛ける。
 * 取引と台帳は「同じ年に取得した同じ金額の資産」で1対1に対応づけ、対応がつかない取引
 * (複数資産の一括払い等)には、その年の残りの取得資産の取得価額による加重平均割合を使う。
 * 台帳に該当年の資産がなければ全額を事業分とする。
 * 繰延資産(開業費)は計上仕訳が自動起票され取得取引を使わないため対象外。
 */
export function assetPurchaseBusinessAmounts(
  transactions: Transaction[],
  assets: FixedAsset[],
  year: number,
): Map<string, number> {
  const result = new Map<string, number>();
  const pool = assets.filter((a) => !isDeferred(a) && a.acquiredDate.startsWith(`${year}-`));
  const matched = new Set<string>();
  const unmatched: Transaction[] = [];
  const purchases = transactionsOfYear(transactions, year)
    .filter((t) => t.account === ASSET_PURCHASE && t.type === 'expense')
    .sort((a, b) => a.date.localeCompare(b.date) || a.createdAt - b.createdAt);
  for (const t of purchases) {
    const asset = pool.find((a) => !matched.has(a.id) && a.cost === t.amount);
    if (!asset) {
      unmatched.push(t);
      continue;
    }
    matched.add(asset.id);
    result.set(t.id, Math.floor((t.amount * businessRatioOf(asset)) / 100));
  }
  const rest = pool.filter((a) => !matched.has(a.id));
  const restCost = rest.reduce((s, a) => s + a.cost, 0);
  const restWeighted = rest.reduce((s, a) => s + a.cost * businessRatioOf(a), 0);
  for (const t of unmatched) {
    // 金額 × 加重合計 は大きな資産で 2^53 を超えうるため BigInt で切り捨て計算する
    result.set(
      t.id,
      restCost > 0
        ? Number((BigInt(t.amount) * BigInt(restWeighted)) / (BigInt(restCost) * BigInt(100)))
        : t.amount,
    );
  }
  return result;
}

export interface TaxSummary {
  year: number;
  /** 課税売上(税込) */
  sales10: number;
  sales8: number;
  /** 売上に係る消費税(割り戻し概算) */
  salesTax: number;
  /** 非課税・不課税の収入(参考) */
  salesOther: number;
  /** 課税仕入(税込・家事按分後の事業分のみ。固定資産の取得を含む) */
  purchase10: number;
  purchase8: number;
  /** 課税仕入のうち固定資産の取得(税込・事業専用割合を反映した事業分) */
  purchaseAssets: number;
  /** 課税仕入に係る消費税の全額 */
  purchaseTax: number;
  /** 控除可能な仕入税額(適格分 + 適格なし分×経過措置) */
  deductibleTax: number;
  /** 適格請求書なしの課税仕入の件数と、経過措置で控除できない税額 */
  nonQualifiedCount: number;
  nonQualifiedLostTax: number;
  /** 納付見込額(マイナスは還付見込) */
  payGeneral: number;
  paySimplified: number;
  /** 2割特例・3割特例の納付見込額(その年分に特例がなければ 0) */
  paySpecial: number;
  /** その年分の特例の納付割合(2026年分まで20%・個人の2027〜2028年分は30%。なし = null) */
  specialRate: 20 | 30 | null;
  /** 設定された方式での納付見込額(特例のない年分を特例で設定していれば本則課税で計算) */
  paySelected: number;
}

/**
 * 指定年の消費税集計(税込経理・概算)。
 * assets(固定資産台帳)は「固定資産の取得」の事業専用割合を課税仕入に反映するために使う。
 */
export function summarizeTax(
  transactions: Transaction[],
  year: number,
  settings: TaxSettings,
  assets: FixedAsset[] = [],
): TaxSummary {
  let sales10 = 0;
  let sales8 = 0;
  let salesTax = 0;
  let salesOther = 0;
  let purchase10 = 0;
  let purchase8 = 0;
  let purchaseAssets = 0;
  let purchaseTax = 0;
  let deductibleTax = 0;
  let nonQualifiedCount = 0;
  let nonQualifiedLostTax = 0;
  const assetBase = assetPurchaseBusinessAmounts(transactions, assets, year);

  for (const t of transactionsOfYear(transactions, year)) {
    if (!isTaxRelevant(t.account)) continue;
    const cat = effectiveTaxCategory(t);

    if (t.type === 'income') {
      if (cat === 'taxable10') {
        sales10 += t.amount;
        salesTax += taxInclusive(t.amount, 10);
      } else if (cat === 'taxable8') {
        sales8 += t.amount;
        salesTax += taxInclusive(t.amount, 8);
      } else {
        salesOther += t.amount;
      }
      continue;
    }

    // 経費: 家事按分後の事業分だけが仕入税額控除の対象になる(固定資産は事業専用割合)
    const base = assetBase.get(t.id) ?? t.businessAmount;
    if (base <= 0 || (cat !== 'taxable10' && cat !== 'taxable8')) continue;
    const rate = cat === 'taxable10' ? 10 : 8;
    if (rate === 10) purchase10 += base;
    else purchase8 += base;
    if (assetBase.has(t.id)) purchaseAssets += base;
    const tax = taxInclusive(base, rate);
    purchaseTax += tax;
    if (t.qualifiedInvoice === false) {
      nonQualifiedCount++;
      const deductible = Math.floor((tax * nonQualifiedDeductionRate(t.date)) / 100);
      deductibleTax += deductible;
      nonQualifiedLostTax += tax - deductible;
    } else {
      deductibleTax += tax;
    }
  }

  const payGeneral = salesTax - deductibleTax;
  const paySimplified =
    salesTax - Math.floor((salesTax * DEEMED_PURCHASE_RATES[settings.simplifiedType]) / 100);
  const specialRate = smallBusinessSpecialRate(year);
  const paySpecial = specialRate !== null ? Math.floor((salesTax * specialRate) / 100) : 0;
  const paySelected =
    settings.method === 'general'
      ? payGeneral
      : settings.method === 'simplified'
        ? paySimplified
        : // 2割・3割特例は期限のある措置。期限外の年分は本則課税(誤った少額表示を防ぐ)
          specialRate !== null
          ? paySpecial
          : payGeneral;

  return {
    year,
    sales10,
    sales8,
    salesTax,
    salesOther,
    purchase10,
    purchase8,
    purchaseAssets,
    purchaseTax,
    deductibleTax,
    nonQualifiedCount,
    nonQualifiedLostTax,
    payGeneral,
    paySimplified,
    paySpecial,
    specialRate,
    paySelected,
  };
}

// ── 申告書ベースの計算(国税・地方の分離と法定の端数処理) ──

/**
 * 消費税申告書(一般用・割戻し計算)の様式に沿った計算結果。
 * summarizeTax の「税込10%で割り戻す概算」と違い、
 * 国税(7.8%/6.24%)と地方消費税(22/78)を分離し、法定の端数処理を行う:
 * - 課税標準額: 税率区分ごとに税込×100/110(108)→ 千円未満切捨
 * - 差引税額: 百円未満切捨(控除不足=還付は円単位)
 * - 地方消費税(譲渡割): 差引税額 × 22/78 → 百円未満切捨
 */
export interface TaxReturnCalc {
  year: number;
  /** 実際に適用した方式(2割・3割特例の期限外は本則に読み替え) */
  applied: 'general' | 'simplified' | 'special20';
  /** 課税標準額(千円未満切捨・税率区分ごと) */
  base10: number;
  base8: number;
  baseTotal: number;
  /** 課税標準額に対する消費税額(国税: 7.8% / 6.24%) */
  tax10: number;
  tax8: number;
  salesTaxNational: number;
  /** 控除対象仕入税額(国税)。簡易=みなし仕入率、2割特例=特別控除80%・3割特例=70% */
  deductibleNational: number;
  /** 差引税額(百円未満切捨)。マイナス = 控除不足還付税額(円単位) */
  netNational: number;
  /** 地方消費税の譲渡割額(納付は百円未満切捨。還付は円単位の目安) */
  localTax: number;
  /** 納付(マイナスは還付)する消費税及び地方消費税の合計 */
  totalDue: number;
}

/** 指定年の消費税を申告書の様式(割戻し計算・国税/地方分離)で計算する */
export function calcTaxReturn(
  transactions: Transaction[],
  year: number,
  settings: TaxSettings,
  assets: FixedAsset[] = [],
): TaxReturnCalc {
  // 税込の課税売上と課税仕入(仕入は適格/経過措置の区分ごと)を集計する
  let salesIncl10 = 0;
  let salesIncl8 = 0;
  // 仕入バケツ: 控除割合(100/80/50/0)ごとの税込合計
  const purchase10 = new Map<number, number>();
  const purchase8 = new Map<number, number>();
  const assetBase = assetPurchaseBusinessAmounts(transactions, assets, year);

  for (const t of transactionsOfYear(transactions, year)) {
    if (!isTaxRelevant(t.account)) continue;
    const cat = effectiveTaxCategory(t);
    if (cat !== 'taxable10' && cat !== 'taxable8') continue;
    if (t.type === 'income') {
      if (cat === 'taxable10') salesIncl10 += t.amount;
      else salesIncl8 += t.amount;
      continue;
    }
    const base = assetBase.get(t.id) ?? t.businessAmount;
    if (base <= 0) continue;
    const ratio = t.qualifiedInvoice === false ? nonQualifiedDeductionRate(t.date) : 100;
    const bucket = cat === 'taxable10' ? purchase10 : purchase8;
    bucket.set(ratio, (bucket.get(ratio) ?? 0) + base);
  }

  // 課税標準額(税率区分ごとに税抜へ割り戻し → 千円未満切捨)
  const base10 = Math.floor(Math.floor((salesIncl10 * 100) / 110) / 1000) * 1000;
  const base8 = Math.floor(Math.floor((salesIncl8 * 100) / 108) / 1000) * 1000;
  // 国税分: 7.8% / 6.24%(課税標準が千円単位なので 10% は端数なし、8% は円未満切捨)
  const tax10 = (base10 / 1000) * 78;
  const tax8 = Math.floor((base8 * 624) / 10_000);
  const salesTaxNational = tax10 + tax8;

  // 本則の控除対象仕入税額(国税): 税込×7.8/110(6.24/108)→ 経過措置は税額の80%/70%/50%/30%
  let generalDeductible = 0;
  for (const [ratio, incl] of purchase10) {
    const full = Math.floor((incl * 78) / 1100);
    generalDeductible += Math.floor((full * ratio) / 100);
  }
  for (const [ratio, incl] of purchase8) {
    const full = Math.floor((incl * 624) / 10_800);
    generalDeductible += Math.floor((full * ratio) / 100);
  }

  const specialRate = smallBusinessSpecialRate(year);
  const applied: TaxReturnCalc['applied'] =
    settings.method === 'special20' && specialRate === null ? 'general' : settings.method;

  const deductibleNational =
    applied === 'general'
      ? generalDeductible
      : applied === 'simplified'
        ? Math.floor((salesTaxNational * DEEMED_PURCHASE_RATES[settings.simplifiedType]) / 100)
        : // 2割特例は特別控除80%・3割特例は70%(納付は売上の消費税の2割・3割)
          Math.floor((salesTaxNational * (100 - (specialRate ?? 20))) / 100);

  const rawNet = salesTaxNational - deductibleNational;
  // 納付は百円未満切捨。控除不足(還付)は円単位のまま返す
  const netNational = rawNet >= 0 ? Math.floor(rawNet / 100) * 100 : rawNet;
  const localTax =
    netNational >= 0
      ? Math.floor(Math.floor((netNational * 22) / 78) / 100) * 100
      : -Math.floor((-netNational * 22) / 78);

  return {
    year,
    applied,
    base10,
    base8,
    baseTotal: base10 + base8,
    tax10,
    tax8,
    salesTaxNational,
    deductibleNational,
    netNational,
    localTax,
    totalDue: netNational + localTax,
  };
}

/** 課税事業者になる目安(基準期間の課税売上高1,000万円) */
export const TAXABLE_THRESHOLD = 10_000_000;
