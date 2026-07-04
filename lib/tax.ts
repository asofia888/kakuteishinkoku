import { isExcluded, isSettlement } from './accounts';
import { transactionsOfYear } from './aggregate';
import { TaxCategory, TaxSettings, Transaction } from './types';

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

export function defaultTaxCategory(t: Pick<Transaction, 'type' | 'account'>): TaxCategory {
  if (t.account === null || isExcluded(t.account) || isSettlement(t.account)) return 'none';
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
 * 2023/10〜2026/9: 80% → 2026/10〜2029/9: 50% → 以降: 0%
 */
export function nonQualifiedDeductionRate(date: string): number {
  if (date < '2023-10-01') return 100; // 制度開始前(区分記載請求書で全額控除)
  if (date < '2026-10-01') return 80;
  if (date < '2029-10-01') return 50;
  return 0;
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
  /** 課税仕入(税込・家事按分後の事業分のみ) */
  purchase10: number;
  purchase8: number;
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
  paySpecial20: number;
  /** 設定された方式での納付見込額 */
  paySelected: number;
}

/** 指定年の消費税集計(税込経理・概算) */
export function summarizeTax(
  transactions: Transaction[],
  year: number,
  settings: TaxSettings,
): TaxSummary {
  let sales10 = 0;
  let sales8 = 0;
  let salesTax = 0;
  let salesOther = 0;
  let purchase10 = 0;
  let purchase8 = 0;
  let purchaseTax = 0;
  let deductibleTax = 0;
  let nonQualifiedCount = 0;
  let nonQualifiedLostTax = 0;

  for (const t of transactionsOfYear(transactions, year)) {
    if (t.account === null || isExcluded(t.account) || isSettlement(t.account)) continue;
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

    // 経費: 家事按分後の事業分だけが仕入税額控除の対象になる
    const base = t.businessAmount;
    if (base <= 0 || (cat !== 'taxable10' && cat !== 'taxable8')) continue;
    const rate = cat === 'taxable10' ? 10 : 8;
    if (rate === 10) purchase10 += base;
    else purchase8 += base;
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
  const paySpecial20 = Math.floor((salesTax * 20) / 100);
  const paySelected =
    settings.method === 'general'
      ? payGeneral
      : settings.method === 'simplified'
        ? paySimplified
        : paySpecial20;

  return {
    year,
    sales10,
    sales8,
    salesTax,
    salesOther,
    purchase10,
    purchase8,
    purchaseTax,
    deductibleTax,
    nonQualifiedCount,
    nonQualifiedLostTax,
    payGeneral,
    paySimplified,
    paySpecial20,
    paySelected,
  };
}

/** 課税事業者になる目安(基準期間の課税売上高1,000万円) */
export const TAXABLE_THRESHOLD = 10_000_000;
