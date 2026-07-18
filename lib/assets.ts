import { escapeFormulaCell } from './csv';
import { declining200For } from './taxparams';
import { FixedAsset } from './types';

/**
 * 減価償却の計算(個人・平成19年4月1日以後取得の資産)。
 * - 定額法: 償却費 = 取得価額 × 償却率 × 使用月数/12(円未満切り捨て)。
 *   帳簿価額が1円(備忘価額)になるまで償却する。
 * - 定率法(200%定率法・平成24年4月1日以後取得): 期首帳簿価額 × 償却率。
 *   調整前償却額が償却保証額(取得価額×保証率)を下回った年からは
 *   改定取得価額 × 改定償却率の均等償却に切り替え、1円まで償却する。
 *   ※個人は定額法が法定償却方法のため、定率法は税務署への届出が必要。
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

  if (asset.method === 'deferred') {
    // 繰延資産(開業費など)の任意償却: 指定された年・金額で、残額を限度に償却する
    const deps = [...(asset.deferredDep ?? [])]
      .filter((d) => d.amount > 0 && d.year >= acq.y)
      .sort((a, b) => a.year - b.year);
    const rows: DepreciationRow[] = [];
    let book = asset.cost;
    for (const d of deps) {
      const dep = Math.min(Math.round(d.amount), book);
      if (dep <= 0) continue;
      rows.push({ year: d.year, months: 12, opening: book, dep, closing: book - dep });
      book -= dep;
      if (book <= 0) break;
    }
    return rows;
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

  if (asset.method === 'declining') {
    // 200%定率法: 調整前償却額(期首簿価×償却率)が償却保証額を下回った年から
    // 改定取得価額(その年の期首簿価)× 改定償却率で均等償却する
    const { rate1000, revised1000, guarantee100000 } = declining200For(asset.usefulLife);
    const guarantee = Math.floor((asset.cost * guarantee100000) / 100_000);
    const rows: DepreciationRow[] = [];
    let book = asset.cost;
    let revisedBase: number | null = null;
    for (let y = acq.y; y <= acq.y + 120; y++) {
      if (disp && y > disp.y) break;
      const startMonth = y === acq.y ? acq.m : 1;
      const endMonth = disp && y === disp.y ? disp.m : 12;
      const months = endMonth - startMonth + 1;
      if (months <= 0) break;
      if (revisedBase === null && Math.floor((book * rate1000) / 1000) < guarantee) {
        revisedBase = book;
      }
      // 改定償却額(均等)は円未満を切り上げる。切り捨てると端数が累積して
      // 耐用年数を1年はみ出し、切り上げなら残りの年数でちょうど1円まで償却が終わる
      const annual =
        revisedBase === null
          ? Math.floor((book * rate1000) / 1000)
          : Math.ceil((revisedBase * revised1000) / 1000);
      let dep = Math.floor((annual * months) / 12);
      // 備忘価額1円を残す
      if (book - dep < 1) dep = book - 1;
      if (dep <= 0) break;
      rows.push({ year: y, months, opening: book, dep, closing: book - dep });
      book -= dep;
      if (book <= 1) break;
    }
    return rows;
  }

  // 定額法
  // 償却率は千分率の整数(例: 7年 → 143)で持ち、浮動小数点誤差を避ける。
  // cost × 0.143 × months / 12 は2進数で誤差が出て1円ズレることがある
  // (例: 12,000円・1ヶ月 → 142円になってしまう。正しくは143円)
  const rateM = Math.ceil(1000 / Math.max(2, asset.usefulLife));
  const rows: DepreciationRow[] = [];
  let book = asset.cost;
  for (let y = acq.y; y <= acq.y + 120; y++) {
    if (disp && y > disp.y) break;
    const startMonth = y === acq.y ? acq.m : 1;
    const endMonth = disp && y === disp.y ? disp.m : 12;
    const months = endMonth - startMonth + 1;
    if (months <= 0) break;
    let dep = Math.floor((asset.cost * rateM * months) / 12_000);
    // 備忘価額1円を残す
    if (book - dep < 1) dep = book - 1;
    if (dep <= 0) break;
    rows.push({ year: y, months, opening: book, dep, closing: book - dep });
    book -= dep;
    if (book <= 1) break;
  }
  return rows;
}

/** 除却時に残存簿価を事業主貸へ振り替える方式(償却が除却月で止まり簿価が残る方式) */
function residualOnDisposal(method: FixedAsset['method']): boolean {
  return method === 'straight' || method === 'declining';
}

/**
 * 除却した資産のうち、その年に帳簿から外す残存簿価(事業主貸への振替額)。
 * - 定額法・定率法のみ対象(償却は除却月で止まり、残った簿価が帳簿に残り続けるため)。
 * - 一括償却資産は除却後も3年均等償却を続ける(税法上の扱い)ため対象外。
 * - 少額特例は取得年に全額償却済み(残高0)、繰延資産は任意償却の余地を残すため対象外。
 * 除却損(廃棄)か譲渡所得(売却)かはアプリでは判定できないため、損益には計上しない。
 */
export function disposalResidual(asset: FixedAsset, year: number): number {
  if (!residualOnDisposal(asset.method) || !asset.disposedDate) return 0;
  const acq = ymOf(asset.acquiredDate);
  const disp = ymOf(asset.disposedDate);
  if (!acq || !disp || disp.y !== year || disp.y < acq.y) return 0;
  const depreciated = depreciationSchedule(asset)
    .filter((r) => r.year <= year)
    .reduce((s, r) => s + r.dep, 0);
  return Math.max(0, asset.cost - depreciated);
}

/** 除却によりB/Sから外れている(残存簿価を事業主貸へ振替済み)資産か */
function disposedOut(asset: FixedAsset, year: number): boolean {
  if (!residualOnDisposal(asset.method) || !asset.disposedDate) return false;
  const acq = ymOf(asset.acquiredDate);
  const disp = ymOf(asset.disposedDate);
  return !!acq && !!disp && disp.y <= year && disp.y >= acq.y;
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

/** 年初(1/1)時点の帳簿価額。取得前は0、償却終了後は残存簿価(定額法は1円)。
 *  除却済み(定額法)は残存簿価を事業主貸へ振替済みのため、翌年以降は0 */
export function bookValueAtStart(asset: FixedAsset, year: number): number {
  const acq = ymOf(asset.acquiredDate);
  if (!acq || acq.y >= year) return 0;
  if (disposedOut(asset, year - 1)) return 0;
  const depreciated = depreciationSchedule(asset)
    .filter((r) => r.year < year)
    .reduce((s, r) => s + r.dep, 0);
  return Math.max(0, asset.cost - depreciated);
}

/** 年末(12/31)時点の帳簿価額(未償却残高)。
 *  除却済み(定額法)は除却年の12/31付で残存簿価を事業主貸へ振り替えるため0 */
export function bookValueAtEnd(asset: FixedAsset, year: number): number {
  const acq = ymOf(asset.acquiredDate);
  if (!acq || acq.y > year) return 0;
  if (disposedOut(asset, year)) return 0;
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
  declining: '定率法(200%)',
  lump3: '一括償却(3年均等)',
  immediate: '少額特例(全額)',
  deferred: '任意償却(開業費等)',
};

/** 繰延資産(開業費など。任意償却・B/Sでは「繰延資産」区分)か */
export function isDeferred(asset: Pick<FixedAsset, 'method'>): boolean {
  return asset.method === 'deferred';
}

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

/**
 * 決算書「減価償却費の計算」欄の1行分。
 * CSV出力・e-Tax(帳票KOA210)出力・画面表示はこの行データを共用する
 * (方法ラベル・償却率・保証額・摘要の決定ロジックを1箇所にまとめる)。
 */
export interface DepreciationYearRow {
  methodId: FixedAsset['method'];
  name: string;
  /** 取得年月 YYYY-MM */
  acquired: string;
  cost: number;
  /** 償却保証額(定率法のみ) */
  guarantee: number | null;
  /** 償却の基礎になる金額(定率法は期首帳簿価額) */
  base: number;
  /** 償却方法の表示名 */
  method: string;
  usefulLife: number | null;
  /** 償却率の表示(0.250 など)。一括償却・少額特例・任意償却は null */
  rate: string | null;
  /** 本年中の償却期間(月) */
  months: number;
  /** 本年分の普通償却費(全額) */
  dep: number;
  businessRatio: number;
  /** 本年分の必要経費算入額 */
  business: number;
  /** 未償却残高(期末) */
  closing: number;
  /** 摘要(措法28の2・除却など) */
  note: string;
  /** 除却年に事業主貸へ振り替えた残存簿価(表示用) */
  residual: number;
}

/** 指定年に償却費のある資産を、決算書3ページ目の様式の列に展開する */
export function depreciationRowsForYear(assets: FixedAsset[], year: number): DepreciationYearRow[] {
  const rows: DepreciationYearRow[] = [];
  for (const a of assets) {
    const d = depreciationForYear(a, year);
    if (d.total === 0) continue;
    rows.push({
      methodId: a.method,
      name: a.name,
      acquired: a.acquiredDate.slice(0, 7),
      cost: a.cost,
      guarantee:
        a.method === 'declining'
          ? Math.floor((a.cost * declining200For(a.usefulLife).guarantee100000) / 100_000)
          : null,
      base: a.method === 'declining' ? bookValueAtStart(a, year) : a.cost,
      method: METHOD_LABELS[a.method],
      usefulLife:
        a.method === 'straight' || a.method === 'declining'
          ? a.usefulLife
          : a.method === 'lump3'
            ? 3
            : null,
      rate:
        a.method === 'straight'
          ? straightLineRate(a.usefulLife).toFixed(3)
          : a.method === 'declining'
            ? (declining200For(a.usefulLife).rate1000 / 1000).toFixed(3)
            : null,
      months: d.months || 12,
      dep: d.total,
      businessRatio: a.businessRatio,
      business: d.business,
      closing: bookValueAtEnd(a, year),
      note:
        a.method === 'immediate'
          ? '措法28の2(少額)'
          : a.method === 'lump3'
            ? '一括償却(3年)'
            : a.method === 'deferred'
              ? '繰延資産・任意償却'
              : a.disposedDate && a.disposedDate.slice(0, 4) === String(year)
                ? `除却 ${a.disposedDate}`
                : '',
      residual: disposalResidual(a, year),
    });
  }
  return rows;
}

/** 青色申告決算書「減価償却費の計算」欄に転記できるCSV(指定年に償却がある資産のみ) */
export function depreciationTableCsv(assets: FixedAsset[], year: number): string {
  const lines: string[] = [];
  lines.push(`"${year}年分 減価償却費の計算(青色申告決算書3ページ用)"`);
  lines.push(
    '減価償却資産の名称等,取得年月,取得価額,償却方法,耐用年数,償却率,本年中の償却期間(月),本年分の普通償却費,事業専用割合(%),本年分の必要経費算入額,未償却残高(期末),摘要',
  );
  const rows = depreciationRowsForYear(assets, year);
  for (const r of rows) {
    lines.push(
      [
        csvCell(r.name),
        r.acquired,
        r.cost,
        r.method,
        r.usefulLife ?? '',
        r.rate ?? '',
        r.methodId === 'straight' || r.methodId === 'declining' ? r.months : '',
        r.dep,
        r.businessRatio,
        r.business,
        r.closing,
        csvCell(r.residual > 0 ? `${r.note}(残存簿価${r.residual}円は事業主貸へ振替)` : r.note),
      ].join(','),
    );
  }
  const totalDep = rows.reduce((s, r) => s + r.dep, 0);
  const totalBusiness = rows.reduce((s, r) => s + r.business, 0);
  lines.push(`合計,,,,,,,${totalDep},,${totalBusiness},,`);
  return '\ufeff' + lines.join('\r\n');
}
