import { escapeFormulaCell } from './csv';
import { FixedAsset } from './types';

/**
 * 減価償却の計算(個人・平成19年4月1日以後取得の資産)。
 * - 定額法: 償却費 = 取得価額 × 償却率 × 使用月数/12(円未満切り捨て)。
 *   帳簿価額が1円(備忘価額)になるまで償却する。
 * - 一括償却資産(3年均等): 取得価額 × 1/3 ずつ。月割りなし・備忘価額なし。
 *   除却しても3年間の均等償却を続ける(税法上の扱い)。
 * - 少額減価償却資産の特例: 取得年に全額を必要経費に算入する。
 */

/** 定額法の償却率(1/耐用年数を小数第3位で切り上げ。国税庁の償却率表と一致する) */
export function straightLineRate(usefulLife: number): number {
  return Math.ceil(1000 / usefulLife) / 1000;
}

export interface DepreciationRow {
  year: number;
  /** 本年中の償却期間(月数) */
  months: number;
  /** 期首帳簿価額 */
  opening: number;
  /** 本年分の普通償却費(全額) */
  dep: number;
  /** 期末帳簿価額(未償却残高) */
  closing: number;
}

function ymOf(date: string): { y: number; m: number } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  return { y: Number(date.slice(0, 4)), m: Number(date.slice(5, 7)) };
}

/** 資産の償却予定表(取得年から償却終了まで。除却した年で止まる) */
export function depreciationSchedule(asset: FixedAsset): DepreciationRow[] {
  const acq = ymOf(asset.acquiredDate);
  if (!acq || asset.cost <= 0) return [];
  const disp = asset.disposedDate ? ymOf(asset.disposedDate) : null;

  if (asset.method === 'immediate') {
    // 少額減価償却資産の特例: 取得年に全額計上
    return [
      {
        year: acq.y,
        months: 12 - acq.m + 1,
        opening: asset.cost,
        dep: asset.cost,
        closing: 0,
      },
    ];
  }

  if (asset.method === 'lump3') {
    // 一括償却資産: 3年均等(月割りなし)。除却しても続ける
    const third = Math.floor(asset.cost / 3);
    return [
      { year: acq.y, months: 12, opening: asset.cost, dep: third, closing: asset.cost - third },
      {
        year: acq.y + 1,
        months: 12,
        opening: asset.cost - third,
        dep: third,
        closing: asset.cost - third * 2,
      },
      {
        year: acq.y + 2,
        months: 12,
        opening: asset.cost - third * 2,
        dep: asset.cost - third * 2,
        closing: 0,
      },
    ];
  }

  // 定額法
  const rate = straightLineRate(Math.max(2, asset.usefulLife));
  const rows: DepreciationRow[] = [];
  let book = asset.cost;
  for (let y = acq.y; y <= acq.y + 120; y++) {
    if (disp && y > disp.y) break;
    const startMonth = y === acq.y ? acq.m : 1;
    const endMonth = disp && y === disp.y ? disp.m : 12;
    const months = endMonth - startMonth + 1;
    if (months <= 0) break;
    let dep = Math.floor((asset.cost * rate * months) / 12);
    // 備忘価額1円を残す
    if (book - dep < 1) dep = book - 1;
    if (dep <= 0) break;
    rows.push({ year: y, months, opening: book, dep, closing: book - dep });
    book -= dep;
    if (book <= 1) break;
  }
  return rows;
}

/** 指定年の償却費(全額・事業分・家事分)。事業分は事業専用割合を掛けて切り捨て */
export function depreciationForYear(
  asset: FixedAsset,
  year: number,
): { total: number; business: number; ownerPart: number; months: number } {
  const row = depreciationSchedule(asset).find((r) => r.year === year);
  if (!row) return { total: 0, business: 0, ownerPart: 0, months: 0 };
  const ratio = Math.min(100, Math.max(1, asset.businessRatio));
  const business = Math.floor((row.dep * ratio) / 100);
  return { total: row.dep, business, ownerPart: row.dep - business, months: row.months };
}

/** 年初(1/1)時点の帳簿価額。取得前は0、償却終了後は残存簿価(定額法は1円) */
export function bookValueAtStart(asset: FixedAsset, year: number): number {
  const acq = ymOf(asset.acquiredDate);
  if (!acq || acq.y >= year) return 0;
  const depreciated = depreciationSchedule(asset)
    .filter((r) => r.year < year)
    .reduce((s, r) => s + r.dep, 0);
  return Math.max(0, asset.cost - depreciated);
}

/** 年末(12/31)時点の帳簿価額(未償却残高) */
export function bookValueAtEnd(asset: FixedAsset, year: number): number {
  const acq = ymOf(asset.acquiredDate);
  if (!acq || acq.y > year) return 0;
  const depreciated = depreciationSchedule(asset)
    .filter((r) => r.year <= year)
    .reduce((s, r) => s + r.dep, 0);
  return Math.max(0, asset.cost - depreciated);
}

/** 指定年の全資産の償却費合計(全額と必要経費算入額) */
export function yearDepreciationTotals(
  assets: FixedAsset[],
  year: number,
): { total: number; business: number } {
  let total = 0;
  let business = 0;
  for (const a of assets) {
    const d = depreciationForYear(a, year);
    total += d.total;
    business += d.business;
  }
  return { total, business };
}

/** 指定年に取得した資産の取得価額合計(「固定資産の取得」取引との照合用) */
export function acquisitionsInYear(assets: FixedAsset[], year: number): FixedAsset[] {
  return assets.filter((a) => ymOf(a.acquiredDate)?.y === year);
}

export const METHOD_LABELS: Record<FixedAsset['method'], string> = {
  straight: '定額法',
  lump3: '一括償却(3年均等)',
  immediate: '少額特例(全額)',
};

/** よく使う耐用年数の例(国税庁「主な減価償却資産の耐用年数表」より) */
export const USEFUL_LIFE_PRESETS: { label: string; years: number }[] = [
  { label: 'パソコン', years: 4 },
  { label: 'カメラ・映像機器', years: 5 },
  { label: '事務机・椅子・キャビネット(金属製)', years: 15 },
  { label: '同(その他・木製)', years: 8 },
  { label: 'エアコン', years: 6 },
  { label: '普通自動車(新車)', years: 6 },
  { label: '軽自動車(新車)', years: 4 },
  { label: 'ソフトウェア(自社利用)', years: 5 },
  { label: '看板(金属製)', years: 10 },
];

function csvCell(s: string): string {
  return `"${escapeFormulaCell(s).replace(/"/g, '""')}"`;
}

/** 青色申告決算書「減価償却費の計算」欄に転記できるCSV(指定年に償却がある資産のみ) */
export function depreciationTableCsv(assets: FixedAsset[], year: number): string {
  const lines: string[] = [];
  lines.push(`"${year}年分 減価償却費の計算(青色申告決算書3ページ用)"`);
  lines.push(
    '減価償却資産の名称等,取得年月,取得価額,償却方法,耐用年数,償却率,本年中の償却期間(月),本年分の普通償却費,事業専用割合(%),本年分の必要経費算入額,未償却残高(期末),摘要',
  );
  let totalDep = 0;
  let totalBusiness = 0;
  for (const a of assets) {
    const d = depreciationForYear(a, year);
    if (d.total === 0) continue;
    totalDep += d.total;
    totalBusiness += d.business;
    const note =
      a.method === 'immediate'
        ? '措法28の2(少額)'
        : a.method === 'lump3'
          ? '一括償却(3年)'
          : a.disposedDate && a.disposedDate.slice(0, 4) === String(year)
            ? `除却 ${a.disposedDate}`
            : '';
    lines.push(
      [
        csvCell(a.name),
        a.acquiredDate.slice(0, 7),
        a.cost,
        METHOD_LABELS[a.method],
        a.method === 'straight' ? a.usefulLife : a.method === 'lump3' ? 3 : '',
        a.method === 'straight' ? straightLineRate(a.usefulLife).toFixed(3) : '',
        a.method === 'straight' ? d.months : '',
        d.total,
        a.businessRatio,
        d.business,
        bookValueAtEnd(a, year),
        csvCell(note),
      ].join(','),
    );
  }
  lines.push(`合計,,,,,,,${totalDep},,${totalBusiness},,`);
  return '\ufeff' + lines.join('\r\n');
}
