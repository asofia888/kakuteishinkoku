import { accountLabel, fundShort, isExcluded, isSettlement } from './accounts';
import { Transaction, TxType } from './types';

/** CSVから読み取った1行分の明細 */
export interface ParsedRow {
  /** YYYY-MM-DD */
  date: string;
  description: string;
  /** 符号付き金額。銀行明細では入金がプラス・出金がマイナスのことが多い */
  amount: number;
}

/**
 * CSV解析の結果。
 * 読み飛ばした行数も返し、取込画面で「◯行スキップ」と表示できるようにする
 * (明細行が静かに欠落したことに気付けないと帳簿が誤るため)。
 */
export interface ParseResult {
  rows: ParsedRow[];
  /** 明細として読み取れなかった行数(前置き行・集計行など。ヘッダー行は含まない) */
  skipped: number;
  /**
   * 列名ヘッダーを認識できず、行ごとのヒューリスティックで推測したか。
   * 推測時は出金列の正値を収入と誤判定しうるため、取込画面で種別の確認を促す。
   */
  guessed: boolean;
}

/** 取込時の収支判定モード */
export type ImportMode = 'auto' | 'expense' | 'income';

export const IMPORT_MODES: { id: ImportMode; label: string; hint: string }[] = [
  {
    id: 'auto',
    label: '自動判定(銀行口座)',
    hint: 'プラスの金額=収入 / マイナスの金額=支出として取り込みます',
  },
  {
    id: 'expense',
    label: 'すべて支出(クレジットカード)',
    hint: '符号に関わらず全行を支出として取り込みます',
  },
  { id: 'income', label: 'すべて収入', hint: '全行を収入として取り込みます' },
];

/**
 * CSV全体をRFC4180準拠でトークナイズする。
 * クォート内の改行・カンマ・「""」エスケープに対応(楽天カード等の明細で必要)。
 */
function tokenizeCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cur += '"'; // 「""」→ エスケープされたダブルクォート
          i++;
        } else quoted = false;
      } else cur += ch;
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(cur.trim());
      cur = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cur.trim());
      cur = '';
      if (row.some((c) => c !== '')) rows.push(row);
      row = [];
    } else cur += ch;
  }
  row.push(cur.trim());
  if (row.some((c) => c !== '')) rows.push(row);
  return rows;
}

function validDate(y: number, mo: number, d: number): string | null {
  // 2/30 や 4/31 など存在しない日付を弾く
  const dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** 日付セルを YYYY-MM-DD に正規化する(テストからも使うためexport) */
export function parseDateCell(cell: string): string | null {
  const c = cell.trim();
  // 西暦 + 区切りあり(2026/1/5, 2026-01-05, 2026年1月5日, 2026.1.5)
  let m = c.match(/(20\d{2})[/\-.年](\d{1,2})[/\-.月](\d{1,2})/);
  if (m) return validDate(Number(m[1]), Number(m[2]), Number(m[3]));
  // 区切りなし8桁(楽天銀行などの 20260105 形式)
  m = c.match(/^(20\d{2})(\d{2})(\d{2})$/);
  if (m) return validDate(Number(m[1]), Number(m[2]), Number(m[3]));
  // 和暦(令和7年1月5日, R7.1.5, H31.4.30 など。ゆうちょ等の明細で使われる)
  m = c.match(/(令和|平成|R|Ｒ|H|Ｈ)\s*(\d{1,2}|元)\s*[年/\-.](\d{1,2})[月/\-.](\d{1,2})/);
  if (m) {
    const base = m[1] === '平成' || m[1] === 'H' || m[1] === 'Ｈ' ? 1988 : 2018;
    const n = m[2] === '元' ? 1 : Number(m[2]);
    return validDate(base + n, Number(m[3]), Number(m[4]));
  }
  return null;
}

/** 金額セルを符号付き整数(円)にする(テストからも使うためexport) */
export function parseAmountCell(cell: string): number | null {
  // 全角数字を半角へ(「１,０００」等の明細対応)
  let s = cell.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  s = s.replace(/[¥￥,，\s"円]/g, '');
  let negative = false;
  if (/^[▲△]/.test(s)) {
    // ▲1,000 / △1,000 = 国内明細の負数表記
    negative = true;
    s = s.slice(1);
  }
  if (/^[-−－]/.test(s)) {
    // 半角/全角/数学記号のマイナス
    negative = true;
    s = s.slice(1);
  }
  if (/^\d/.test(s) && s.endsWith('-')) {
    // 後置マイナス(「1,000-」形式)
    negative = true;
    s = s.slice(0, -1);
  }
  if (s === '' || !/^\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n === 0) return null;
  return negative ? -Math.round(n) : Math.round(n);
}

/** ヘッダー行から認識した列の割り当て */
interface ColumnMap {
  date: number;
  withdrawal: number | null;
  deposit: number | null;
  amount: number | null;
  /** 「入金/出金」のような区分列(イオン銀行などが使う)。金額列の符号判定に使う */
  direction: number | null;
  desc: number | null;
}

const DATE_HEADERS = ['日付', '取引日', '利用日', '年月日', 'ご利用日', 'お取引日', '操作日', '取扱日'];
const WITHDRAWAL_HEADERS = ['出金', '支払', '引落', '引出', '引き出し', 'お引き落とし', '払出'];
const DEPOSIT_HEADERS = ['入金', '預入', '預り', '預かり', '受取', '受入'];
const AMOUNT_HEADERS = ['金額', '利用金額', 'ご利用金額', '取引金額'];
/** 入金と出金が±の符号で1列にまとまっているCSV(楽天銀行など)の列名 */
const SIGNED_AMOUNT_HEADERS = ['入出金'];
/** 「入金/出金」の区分が金額と別列になっているCSV(イオン銀行など)の列名 */
const DIRECTION_HEADERS = ['入払区分', '入出金区分', '入出区分', '取引区分'];
const DESC_HEADERS = ['摘要', '内容', '取引内容', '利用店名', 'ご利用先', '備考', '店名'];

/**
 * ヘッダー行なら列マップを返す。
 * 「出金額」「入金額」のように別列で正の値を持つ銀行CSVでは、
 * 列名から出金/入金を判別しないと符号(収支)を誤るため、まず列名で認識する。
 */
function findHeaderMap(cells: string[]): ColumnMap | null {
  const norm = cells.map((c) => c.replace(/["\s]/g, ''));
  const matches = (c: string, keys: string[]) => keys.some((k) => c.includes(k));
  const findIdx = (keys: string[], skip?: (c: string) => boolean) =>
    norm.findIndex((c) => (!skip || !skip(c)) && matches(c, keys));
  const nn = (i: number) => (i < 0 ? null : i);

  const date = findIdx(DATE_HEADERS);
  if (date < 0) return null;

  // 「入出金(円)」のような±1列は「出金」に部分一致して出金列と誤認されやすいので、
  // 先に符号付き金額列として確保する(「入出金内容」のような摘要列は除く)
  const isSignedLike = (c: string) => matches(c, SIGNED_AMOUNT_HEADERS);
  const signed = findIdx(SIGNED_AMOUNT_HEADERS, (c) => matches(c, DESC_HEADERS));
  const withdrawal = findIdx(WITHDRAWAL_HEADERS, isSignedLike);
  const deposit = findIdx(DEPOSIT_HEADERS, isSignedLike);
  // 「出金額」などは AMOUNT_HEADERS の「金額」にも一致するため、出金/入金と同じ列は除外
  let amount = signed >= 0 ? signed : findIdx(AMOUNT_HEADERS);
  if (amount === withdrawal || amount === deposit) amount = -1;
  const direction = findIdx(DIRECTION_HEADERS);
  const desc = findIdx(DESC_HEADERS);
  if (withdrawal < 0 && deposit < 0 && amount < 0) return null;
  return {
    date,
    withdrawal: nn(withdrawal),
    deposit: nn(deposit),
    amount: nn(amount),
    direction: nn(direction),
    desc: nn(desc),
  };
}

function parseRowWithMap(cells: string[], map: ColumnMap): ParsedRow | null {
  const date = parseDateCell(cells[map.date] ?? '');
  if (!date) return null;
  const w = map.withdrawal !== null ? parseAmountCell(cells[map.withdrawal] ?? '') : null;
  const d = map.deposit !== null ? parseAmountCell(cells[map.deposit] ?? '') : null;
  let amount: number | null;
  if (w !== null && d !== null) amount = Math.abs(d) - Math.abs(w);
  else if (w !== null) amount = -Math.abs(w); // 出金列 → 支出(マイナス)
  else if (d !== null) amount = Math.abs(d); // 入金列 → 収入(プラス)
  else {
    amount = map.amount !== null ? parseAmountCell(cells[map.amount] ?? '') : null;
    // 区分列(入金/出金)があるCSVは金額が常に正で入ることが多いため、区分で符号を決める
    if (amount !== null && map.direction !== null) {
      const dir = (cells[map.direction] ?? '').trim();
      if (/出|払|引落/.test(dir)) amount = -Math.abs(amount);
      else if (/入|預/.test(dir)) amount = Math.abs(amount);
    }
  }
  if (amount === null || amount === 0) return null;

  let desc = map.desc !== null ? (cells[map.desc] ?? '').trim() : '';
  if (!desc)
    desc = longestText(
      cells,
      new Set([
        map.date,
        map.withdrawal ?? -1,
        map.deposit ?? -1,
        map.amount ?? -1,
        map.direction ?? -1,
      ]),
    );
  return { date, description: desc || '取引', amount };
}

function longestText(cells: string[], used: Set<number>): string {
  let desc = '';
  cells.forEach((c, i) => {
    if (used.has(i)) return;
    const t = c.trim();
    if (!t) return;
    if (/^-?[\d,.\s¥￥円]+$/.test(t)) return; // 残高などの数値列は摘要にしない
    if (t.length > desc.length) desc = t;
  });
  return desc;
}

/** ヘッダーなしCSV用: 日付らしいセル → 金額らしいセル → 最長テキスト(摘要)を拾う */
function parseRowHeuristic(cells: string[]): ParsedRow | null {
  const used = new Set<number>();
  let date: string | null = null;
  let amount: number | null = null;

  cells.forEach((c, i) => {
    if (date === null) {
      const d = parseDateCell(c);
      if (d) {
        date = d;
        used.add(i);
      }
    }
  });
  cells.forEach((c, i) => {
    if (amount === null && !used.has(i)) {
      const a = parseAmountCell(c);
      if (a !== null) {
        amount = a;
        used.add(i);
      }
    }
  });
  if (!date || amount === null) return null;
  return { date, description: longestText(cells, used) || '取引', amount };
}

/**
 * 銀行・カード明細などのCSVから「日付・金額・摘要」を取り込む。
 * 1. 先頭付近(最大20行)からヘッダー行を探し、列名(取引日/出金額/入金額/摘要など)で
 *    列を認識する(口座情報などの前置き行が付くCSVにも対応)
 * 2. ヘッダーがない・列名を認識できない場合は行ごとのヒューリスティックで推測する
 */
export function parseCsv(text: string): ParseResult {
  const lines = tokenizeCsv(text);
  if (lines.length === 0) return { rows: [], skipped: 0, guessed: false };

  let headerIdx = -1;
  let headerMap: ColumnMap | null = null;
  for (let i = 0; i < Math.min(lines.length, 20); i++) {
    const m = findHeaderMap(lines[i]);
    if (m) {
      headerIdx = i;
      headerMap = m;
      break;
    }
  }
  if (headerMap) {
    const map = headerMap;
    const rows = lines
      .slice(headerIdx + 1)
      .map((cells) => parseRowWithMap(cells, map))
      .filter((r): r is ParsedRow => r !== null);
    // skipped = ヘッダー以外で読み取れなかった行(前置き行・集計行など)
    if (rows.length > 0) return { rows, skipped: lines.length - 1 - rows.length, guessed: false };
    // 列認識で1件も読めなければヒューリスティックにフォールバック
  }
  const rows = lines
    .map((cells) => parseRowHeuristic(cells))
    .filter((r): r is ParsedRow => r !== null);
  return { rows, skipped: lines.length - rows.length, guessed: rows.length > 0 };
}

/** UTF-8 → 失敗したら Shift_JIS で読む(国内銀行・カード明細CSV対応) */
export async function readFileText(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('shift_jis').decode(buf);
  }
}

/** 取込モードに従って収入/支出と金額(絶対値)を決める */
export function resolveTypeAndAmount(row: ParsedRow, mode: ImportMode): { type: TxType; amount: number } {
  const abs = Math.abs(row.amount);
  if (mode === 'expense') return { type: 'expense', amount: abs };
  if (mode === 'income') return { type: 'income', amount: abs };
  return { type: row.amount >= 0 ? 'income' : 'expense', amount: abs };
}

/**
 * Excel等で開いたとき数式として実行されないようにする(CSVインジェクション対策)。
 * 明細の摘要は外部由来のため、= + - @ タブ CR で始まるセルは ' を前置して無害化する。
 */
export function escapeFormulaCell(s: string): string {
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

/** 取引一覧をCSV文字列にする(Excel対応のためBOM付き) */
export function transactionsToCsv(transactions: Transaction[]): string {
  const header = [
    '日付',
    '種別',
    '摘要',
    '金額',
    '決済',
    '勘定科目',
    '経費計上額(按分後)',
    '事業主貸',
    '按分適用',
    '承認',
  ];
  const lines = transactions.map((t) => {
    // 経費計上額・事業主貸は経費のみの概念。収入行・対象外・決済(振替)行は空欄にする
    const biz = t.type === 'expense' && !isExcluded(t.account) && !isSettlement(t.account);
    return [
      t.date,
      t.type === 'income' ? '収入' : '支出',
      `"${escapeFormulaCell(t.description).replace(/"/g, '""')}"`,
      t.amount,
      fundShort(t.fund),
      `"${accountLabel(t.account).replace(/"/g, '""')}"`,
      biz ? t.businessAmount : '',
      biz ? t.amount - t.businessAmount : '',
      t.anbunApplied ? '済' : '',
      t.approved ? '済' : '未',
    ].join(',');
  });
  return '\ufeff' + [header.join(','), ...lines].join('\r\n');
}

/** テキストをファイルとしてダウンロードさせる */
export function downloadText(filename: string, text: string, mime = 'text/csv'): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
