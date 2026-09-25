import { MAX_FILE_SIZE, PortableFile } from './files';
import {
  AnbunSetting,
  AppData,
  DEFAULT_ISSUER,
  DEFAULT_TAX_SETTINGS,
  DeductionEntry,
  FixedAsset,
  FundAccount,
  FundId,
  Invoice,
  InvoiceItem,
  InventoryCount,
  IssuerProfile,
  OpeningBalance,
  Partner,
  PayrollEntry,
  Reconciliation,
  RentPayee,
  Rule,
  TaxCategory,
  TaxSettings,
  Transaction,
  uid,
  YearEndAdjustment,
} from './types';

/**
 * バックアップ(JSONエクスポート/インポート)と、外部から来たデータの検証。
 * localStorage の読込にも同じ検証を通し、壊れたデータでアプリが落ちないようにする。
 */

const APP_TAG = 'shinkoku-snap';
// v7: 証憑(files: PortableFile[])をエンベロープに同梱できるようになった
const BACKUP_VERSION = 7;

const FUND_IDS: FundId[] = [
  'bank',
  'cash',
  'card',
  'receivable',
  'payable',
  'loan',
  'deposit',
  'owner',
];
const TAX_CATEGORIES: TaxCategory[] = ['taxable10', 'taxable8', 'exempt', 'none'];

/** 全データをバックアップ用JSON文字列にする(files を渡すと証憑も同梱する) */
export function buildBackupJson(data: AppData, files?: PortableFile[]): string {
  return JSON.stringify(
    {
      app: APP_TAG,
      version: BACKUP_VERSION,
      exportedAt: new Date().toISOString(),
      data,
      // キーの有無で「証憑を含むバックアップか」を判別する(旧版は undefined)
      ...(files ? { files } : {}),
    },
    null,
    2,
  );
}

/**
 * バックアップJSON(または localStorage の AppData 形式)を検証して読み込む。
 * データとして解釈できなければ null を返す。
 */
export function parseBackupJson(text: string): AppData | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && 'data' in parsed) {
      return sanitizeAppData((parsed as { data: unknown }).data);
    }
    return sanitizeAppData(parsed);
  } catch {
    return null;
  }
}

/**
 * バックアップJSONに同梱された証憑(files)を検証して取り出す。
 * 証憑キー自体がない(v6以前・生データ)場合は null を返し、
 * 呼び出し側は IndexedDB に触らない(既存の証憑を保つ)。
 * キーがあれば壊れた要素を捨てた配列を返し、呼び出し側は全置き換えする。
 */
export function parseBackupFilesJson(text: string): PortableFile[] | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || !('files' in parsed)) return null;
    const raw = (parsed as { files: unknown }).files;
    if (!Array.isArray(raw)) return null;
    const seen = new Set<string>();
    const out: PortableFile[] = [];
    for (const item of raw) {
      const f = sanitizePortableFile(item);
      if (!f || seen.has(f.id)) continue;
      seen.add(f.id);
      out.push(f);
    }
    return out;
  } catch {
    return null;
  }
}

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

function sanitizePortableFile(raw: unknown): PortableFile | null {
  if (!raw || typeof raw !== 'object') return null;
  const f = raw as Partial<PortableFile>;
  if (typeof f.txId !== 'string' || f.txId === '') return null;
  if (typeof f.data !== 'string' || f.data === '' || !BASE64_RE.test(f.data)) return null;
  // base64はバイナリの約4/3倍。上限超のファイルは保存時と同様に受け入れない
  if (f.data.length > (MAX_FILE_SIZE * 4) / 3 + 4) return null;
  return {
    id: typeof f.id === 'string' && f.id !== '' ? f.id : uid(),
    txId: f.txId,
    name: typeof f.name === 'string' && f.name !== '' ? f.name : '証憑',
    type: typeof f.type === 'string' ? f.type : 'application/octet-stream',
    size: typeof f.size === 'number' && Number.isFinite(f.size) ? Math.round(f.size) : 0,
    createdAt:
      typeof f.createdAt === 'number' && Number.isFinite(f.createdAt) ? f.createdAt : Date.now(),
    data: f.data,
  };
}

/**
 * バックアップがこのアプリより新しい版で作られたものかを調べる。
 * 新しい版でも読み込み自体は行う(既知の項目だけ取り込む)が、
 * このアプリが知らない項目は失われるため、復元前の警告に使う。
 */
export function isNewerBackup(text: string): boolean {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object') return false;
    const p = parsed as { app?: unknown; version?: unknown };
    return p.app === APP_TAG && typeof p.version === 'number' && p.version > BACKUP_VERSION;
  } catch {
    return false;
  }
}

/**
 * 未知のデータを AppData として検証・補正する。
 * 壊れた要素は捨て、全く形が違う場合は null を返す。
 */
export function sanitizeAppData(raw: unknown): AppData | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (
    !Array.isArray(obj.transactions) &&
    !Array.isArray(obj.rules) &&
    !Array.isArray(obj.anbunSettings)
  ) {
    return null;
  }
  const seenIds = new Set<string>();
  const transactions = (Array.isArray(obj.transactions) ? obj.transactions : [])
    .map((t) => sanitizeTransaction(t, seenIds))
    .filter((t): t is Transaction => t !== null);
  const rules = (Array.isArray(obj.rules) ? obj.rules : [])
    .map(sanitizeRule)
    .filter((r): r is Rule => r !== null);
  // 按分設定は 科目 × 適用開始年 ごとに1件(重複していたら後の設定を優先)
  const anbunByKey = new Map<string, AnbunSetting>();
  for (const item of Array.isArray(obj.anbunSettings) ? obj.anbunSettings : []) {
    const s = sanitizeAnbunSetting(item);
    if (s) anbunByKey.set(`${s.account}|${s.fromYear ?? ''}`, s);
  }
  // 期首残高は年ごとに1件(重複していたら後の設定を優先)
  const obByYear = new Map<number, OpeningBalance>();
  for (const item of Array.isArray(obj.openingBalances) ? obj.openingBalances : []) {
    const ob = sanitizeOpeningBalance(item);
    if (ob) obByYear.set(ob.year, ob);
  }
  const invoiceIds = new Set<string>();
  const invoices = (Array.isArray(obj.invoices) ? obj.invoices : [])
    .map((i) => sanitizeInvoice(i, invoiceIds))
    .filter((i): i is Invoice => i !== null);
  const assetIds = new Set<string>();
  const assets = (Array.isArray(obj.assets) ? obj.assets : [])
    .map((a) => sanitizeFixedAsset(a, assetIds))
    .filter((a): a is FixedAsset => a !== null);
  // 棚卸高は年ごとに1件(重複していたら後の値を優先)
  const invByYear = new Map<number, InventoryCount>();
  for (const item of Array.isArray(obj.inventories) ? obj.inventories : []) {
    const inv = sanitizeInventory(item);
    if (inv) invByYear.set(inv.year, inv);
  }
  // 所得控除も年ごとに1件
  const dedByYear = new Map<number, DeductionEntry>();
  for (const item of Array.isArray(obj.deductions) ? obj.deductions : []) {
    const ded = sanitizeDeduction(item);
    if (ded) dedByYear.set(ded.year, ded);
  }
  const payrollIds = new Set<string>();
  const payrolls = (Array.isArray(obj.payrolls) ? obj.payrolls : [])
    .map((x) => sanitizePayroll(x, payrollIds))
    .filter((x): x is PayrollEntry => x !== null);
  // 年末調整は 年×従業員 ごとに1件(重複していたら後の値を優先)
  const yeaByKey = new Map<string, YearEndAdjustment>();
  for (const item of Array.isArray(obj.yearEndAdjustments) ? obj.yearEndAdjustments : []) {
    const a = sanitizeYearEndAdjustment(item);
    if (a) yeaByKey.set(`${a.year}\u0000${a.employee}`, a);
  }
  // 取引先は名前で重複排除(後勝ち)
  const partnerByName = new Map<string, Partner>();
  for (const item of Array.isArray(obj.partners) ? obj.partners : []) {
    const p = sanitizePartner(item);
    if (p) partnerByName.set(p.name, p);
  }
  return {
    transactions,
    rules,
    anbunSettings: [...anbunByKey.values()],
    openingBalances: [...obByYear.values()].sort((a, b) => a.year - b.year),
    taxSettings: sanitizeTaxSettings(obj.taxSettings),
    invoices,
    issuer: sanitizeIssuer(obj.issuer),
    assets,
    inventories: [...invByYear.values()].sort((a, b) => a.year - b.year),
    deductions: [...dedByYear.values()].sort((a, b) => a.year - b.year),
    partners: [...partnerByName.values()].sort((a, b) => a.createdAt - b.createdAt),
    payrolls,
    yearEndAdjustments: [...yeaByKey.values()].sort(
      (a, b) => a.year - b.year || a.employee.localeCompare(b.employee),
    ),
    // 申告済みロックの年(v3.9.0 以前のデータにはない = ロックなし)
    lockedYears: [
      ...new Set((Array.isArray(obj.lockedYears) ? obj.lockedYears : []).filter(isYear)),
    ].sort((a, b) => a - b),
    fundAccounts: sanitizeList(obj.fundAccounts, sanitizeFundAccount),
    reconciliations: sanitizeList(obj.reconciliations, sanitizeReconciliation),
    rentPayees: sanitizeList(obj.rentPayees, sanitizeRentPayee),
  };
}

function sanitizeRentPayee(raw: unknown): RentPayee | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Partial<RentPayee>;
  const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const name = text(p.name, 60);
  if (!name) return null;
  return {
    id: typeof p.id === 'string' && p.id !== '' ? p.id : uid(),
    name,
    address: text(p.address, 120),
    property: text(p.property, 14),
    keyword: text(p.keyword, 30),
    createdAt: typeof p.createdAt === 'number' && Number.isFinite(p.createdAt) ? p.createdAt : Date.now(),
  };
}

/** ID 付き要素の配列を検証する(壊れた要素は捨て、ID の重複は最初の1件だけ残す) */
function sanitizeList<T extends { id: string }>(raw: unknown, fn: (x: unknown) => T | null): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    const v = fn(item);
    if (!v || seen.has(v.id)) continue;
    seen.add(v.id);
    out.push(v);
  }
  return out;
}

function sanitizeFundAccount(raw: unknown): FundAccount | null {
  if (!raw || typeof raw !== 'object') return null;
  const a = raw as Partial<FundAccount>;
  if (a.fund !== 'bank' && a.fund !== 'card') return null;
  const name = typeof a.name === 'string' ? a.name.trim().slice(0, 30) : '';
  if (!name) return null;
  return {
    id: typeof a.id === 'string' && a.id !== '' ? a.id : uid(),
    fund: a.fund,
    name,
    createdAt: typeof a.createdAt === 'number' && Number.isFinite(a.createdAt) ? a.createdAt : Date.now(),
  };
}

function sanitizeReconciliation(raw: unknown): Reconciliation | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<Reconciliation>;
  if (typeof r.target !== 'string' || r.target === '') return null;
  if (typeof r.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(r.date)) return null;
  if (typeof r.balance !== 'number' || !Number.isFinite(r.balance)) return null;
  return {
    id: typeof r.id === 'string' && r.id !== '' ? r.id : uid(),
    target: r.target,
    date: r.date,
    balance: Math.round(r.balance),
    createdAt: typeof r.createdAt === 'number' && Number.isFinite(r.createdAt) ? r.createdAt : Date.now(),
  };
}

/** 口座別の期首残高(数値の要素だけ残す。空なら省略) */
function subBalancesOf(raw: unknown): { subBalances?: Record<string, number> } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k !== '' && typeof v === 'number' && Number.isFinite(v)) out[k] = Math.round(v);
  }
  return Object.keys(out).length > 0 ? { subBalances: out } : {};
}

function isYear(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 2000 && v <= 2100;
}

function sanitizeYearEndAdjustment(raw: unknown): YearEndAdjustment | null {
  if (!raw || typeof raw !== 'object') return null;
  const a = raw as Partial<YearEndAdjustment>;
  if (typeof a.year !== 'number' || !Number.isInteger(a.year) || a.year < 2000 || a.year > 2100) {
    return null;
  }
  if (typeof a.employee !== 'string' || a.employee.trim() === '') return null;
  const amount = (v: unknown) =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0;
  return {
    year: a.year,
    employee: a.employee.trim(),
    personalDeductions: amount(a.personalDeductions),
    insuranceDeductions: amount(a.insuranceDeductions),
    declaredSocialInsurance: amount(a.declaredSocialInsurance),
  };
}

function sanitizeTransaction(raw: unknown, seenIds: Set<string>): Transaction | null {
  if (!raw || typeof raw !== 'object') return null;
  const t = raw as Partial<Transaction>;
  if (typeof t.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(t.date)) return null;
  if (typeof t.amount !== 'number' || !Number.isFinite(t.amount) || t.amount <= 0) return null;
  if (t.type !== 'income' && t.type !== 'expense') return null;
  let id = typeof t.id === 'string' && t.id !== '' ? t.id : uid();
  if (seenIds.has(id)) id = uid();
  seenIds.add(id);
  return {
    id,
    date: t.date,
    amount: Math.round(t.amount),
    description: typeof t.description === 'string' ? t.description : '',
    type: t.type,
    account: typeof t.account === 'string' && t.account !== '' ? t.account : null,
    approved: t.approved === true,
    // businessAmount / anbunApplied は読込後に applyAnbun で必ず再計算される
    anbunApplied: t.anbunApplied === true,
    businessAmount:
      typeof t.businessAmount === 'number' && Number.isFinite(t.businessAmount)
        ? Math.round(t.businessAmount)
        : Math.round(t.amount),
    source: t.source === 'manual' || t.source === 'demo' ? t.source : 'csv',
    createdAt:
      typeof t.createdAt === 'number' && Number.isFinite(t.createdAt) ? t.createdAt : Date.now(),
    // v2以前のデータには決済手段がない。ほとんどが銀行明細のため普通預金として引き継ぐ
    fund: FUND_IDS.includes(t.fund as FundId) ? (t.fund as FundId) : 'bank',
    ...(FUND_IDS.includes(t.counterFund as FundId)
      ? { counterFund: t.counterFund as FundId }
      : {}),
    ...(TAX_CATEGORIES.includes(t.taxCategory as TaxCategory)
      ? { taxCategory: t.taxCategory as TaxCategory }
      : {}),
    // 未設定 = 適格請求書あり。明示的に false のときだけ保持する
    ...(t.qualifiedInvoice === false ? { qualifiedInvoice: false } : {}),
    // 口座・カード(補助科目)。存在しない ID でも捨てない(集計時に既定の口座へ寄せる)
    ...(typeof t.fundAccount === 'string' && t.fundAccount !== '' ? { fundAccount: t.fundAccount } : {}),
    ...(typeof t.counterAccount === 'string' && t.counterAccount !== ''
      ? { counterAccount: t.counterAccount }
      : {}),
    // 借入金の返済のうち利息(0〜金額の範囲)
    ...(typeof t.interest === 'number' && Number.isFinite(t.interest) && t.interest > 0
      ? { interest: Math.min(Math.round(t.interest), Math.round(t.amount)) }
      : {}),
  };
}

function sanitizeOpeningBalance(raw: unknown): OpeningBalance | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Partial<OpeningBalance>;
  if (
    typeof o.year !== 'number' ||
    !Number.isInteger(o.year) ||
    o.year < 2000 ||
    o.year > 2100
  ) {
    return null;
  }
  // 「前年末の残高から自動設定」は前年末B/Sの写しなので、負の残高(現金の使いすぎ等)も
  // そのまま入り得る。0に補正するとリロードのたびに帳簿が静かにズレるため符号は保つ
  const amount = (v: unknown) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : 0;
  return {
    year: o.year,
    cash: amount(o.cash),
    bank: amount(o.bank),
    receivable: amount(o.receivable),
    card: amount(o.card),
    payable: amount(o.payable),
    // v3.8.2 以前のデータには借入金がない(0として読み込む)
    loan: amount(o.loan),
    deposit: amount(o.deposit),
    ...subBalancesOf(o.subBalances),
  };
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function sanitizeInvoiceItem(raw: unknown): InvoiceItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const i = raw as Partial<InvoiceItem>;
  const quantity = typeof i.quantity === 'number' && Number.isFinite(i.quantity) && i.quantity > 0 ? i.quantity : 1;
  const unitPrice =
    typeof i.unitPrice === 'number' && Number.isFinite(i.unitPrice) ? Math.round(i.unitPrice) : 0;
  return {
    id: typeof i.id === 'string' && i.id !== '' ? i.id : uid(),
    description: str(i.description),
    quantity,
    unitPrice,
    taxRate: i.taxRate === 8 || i.taxRate === 0 ? i.taxRate : 10,
  };
}

function sanitizeInvoice(raw: unknown, seenIds: Set<string>): Invoice | null {
  if (!raw || typeof raw !== 'object') return null;
  const i = raw as Partial<Invoice>;
  if (typeof i.number !== 'string' || i.number.trim() === '') return null;
  let id = typeof i.id === 'string' && i.id !== '' ? i.id : uid();
  if (seenIds.has(id)) id = uid();
  seenIds.add(id);
  const date = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : '');
  const linked = Array.isArray(i.linkedTxIds)
    ? i.linkedTxIds.filter((x): x is string => typeof x === 'string')
    : [];
  return {
    id,
    number: i.number.trim(),
    issueDate: date(i.issueDate),
    dueDate: date(i.dueDate),
    client: str(i.client),
    clientSuffix: str(i.clientSuffix) || '御中',
    title: str(i.title),
    items: (Array.isArray(i.items) ? i.items : [])
      .map(sanitizeInvoiceItem)
      .filter((x): x is InvoiceItem => x !== null),
    taxIncluded: i.taxIncluded === true,
    withholding: i.withholding === true,
    notes: str(i.notes),
    ...(linked.length > 0 ? { linkedTxIds: linked } : {}),
    ...(date(i.paidDate) ? { paidDate: date(i.paidDate) } : {}),
    createdAt:
      typeof i.createdAt === 'number' && Number.isFinite(i.createdAt) ? i.createdAt : Date.now(),
  };
}

function sanitizeFixedAsset(raw: unknown, seenIds: Set<string>): FixedAsset | null {
  if (!raw || typeof raw !== 'object') return null;
  const a = raw as Partial<FixedAsset>;
  if (typeof a.name !== 'string' || a.name.trim() === '') return null;
  if (typeof a.acquiredDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(a.acquiredDate)) return null;
  if (typeof a.cost !== 'number' || !Number.isFinite(a.cost) || a.cost <= 0) return null;
  let id = typeof a.id === 'string' && a.id !== '' ? a.id : uid();
  if (seenIds.has(id)) id = uid();
  seenIds.add(id);
  const method =
    a.method === 'declining' ||
    a.method === 'lump3' ||
    a.method === 'immediate' ||
    a.method === 'deferred'
      ? a.method
      : 'straight';
  // 定率法の係数表は50年まで(51年以上の定率法資産は実務上存在しない)
  const lifeMax = method === 'declining' ? 50 : 100;
  const usefulLife =
    typeof a.usefulLife === 'number' && Number.isFinite(a.usefulLife)
      ? Math.min(lifeMax, Math.max(2, Math.round(a.usefulLife)))
      : 4;
  const businessRatio =
    typeof a.businessRatio === 'number' && Number.isFinite(a.businessRatio)
      ? Math.min(100, Math.max(1, Math.round(a.businessRatio)))
      : 100;
  const memo = typeof a.memo === 'string' ? a.memo.trim() : '';
  const disposed =
    typeof a.disposedDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(a.disposedDate)
      ? a.disposedDate
      : '';
  // 繰延資産の任意償却履歴(年ごとに1件へ寄せる)
  const deferredByYear = new Map<number, { year: number; amount: number }>();
  for (const item of Array.isArray(a.deferredDep) ? a.deferredDep : []) {
    if (!item || typeof item !== 'object') continue;
    const y = (item as { year?: unknown }).year;
    const amt = (item as { amount?: unknown }).amount;
    if (typeof y !== 'number' || !Number.isInteger(y) || y < 2000 || y > 2100) continue;
    if (typeof amt !== 'number' || !Number.isFinite(amt) || amt <= 0) continue;
    deferredByYear.set(y, { year: y, amount: Math.round(amt) });
  }
  const deferredDep = [...deferredByYear.values()].sort((x, y) => x.year - y.year);
  return {
    id,
    name: a.name.trim(),
    acquiredDate: a.acquiredDate,
    cost: Math.round(a.cost),
    method,
    usefulLife,
    businessRatio,
    ...(memo ? { memo } : {}),
    ...(disposed ? { disposedDate: disposed } : {}),
    ...(deferredDep.length > 0 ? { deferredDep } : {}),
    createdAt:
      typeof a.createdAt === 'number' && Number.isFinite(a.createdAt) ? a.createdAt : Date.now(),
  };
}

function sanitizePayroll(raw: unknown, seenIds: Set<string>): PayrollEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Partial<PayrollEntry>;
  if (typeof p.employee !== 'string' || p.employee.trim() === '') return null;
  if (typeof p.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(p.date)) return null;
  if (typeof p.gross !== 'number' || !Number.isFinite(p.gross) || p.gross <= 0) return null;
  let id = typeof p.id === 'string' && p.id !== '' ? p.id : uid();
  if (seenIds.has(id)) id = uid();
  seenIds.add(id);
  const withholding =
    typeof p.withholding === 'number' && Number.isFinite(p.withholding) && p.withholding > 0
      ? Math.min(Math.round(p.withholding), Math.round(p.gross))
      : 0;
  // 社会保険料等の天引きは「総支給 − 源泉」を超えない範囲で保持する
  const socialInsurance =
    typeof p.socialInsurance === 'number' && Number.isFinite(p.socialInsurance) && p.socialInsurance > 0
      ? Math.min(Math.round(p.socialInsurance), Math.round(p.gross) - withholding)
      : 0;
  const linked = Array.isArray(p.linkedTxIds)
    ? p.linkedTxIds.filter((x): x is string => typeof x === 'string')
    : [];
  const note = typeof p.note === 'string' ? p.note.trim() : '';
  return {
    id,
    employee: p.employee.trim(),
    date: p.date,
    gross: Math.round(p.gross),
    withholding,
    ...(socialInsurance > 0 ? { socialInsurance } : {}),
    table: p.table === 'kou' || p.table === 'otsu' || p.table === 'hei' ? p.table : 'manual',
    ...(note ? { note } : {}),
    ...(linked.length > 0 ? { linkedTxIds: linked } : {}),
    createdAt:
      typeof p.createdAt === 'number' && Number.isFinite(p.createdAt) ? p.createdAt : Date.now(),
  };
}

function sanitizePartner(raw: unknown): Partner | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Partial<Partner>;
  if (typeof p.name !== 'string' || p.name.trim() === '') return null;
  return {
    id: typeof p.id === 'string' && p.id !== '' ? p.id : uid(),
    name: p.name.trim(),
    invoiceRegNumber: str(p.invoiceRegNumber),
    memo: str(p.memo),
    createdAt:
      typeof p.createdAt === 'number' && Number.isFinite(p.createdAt) ? p.createdAt : Date.now(),
  };
}

function sanitizeDeduction(raw: unknown): DeductionEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as Partial<DeductionEntry>;
  if (typeof d.year !== 'number' || !Number.isInteger(d.year) || d.year < 2000 || d.year > 2100) {
    return null;
  }
  const amount = (v: unknown) =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0;
  return {
    year: d.year,
    socialInsurance: amount(d.socialInsurance),
    mutualAid: amount(d.mutualAid),
    lifeInsurance: amount(d.lifeInsurance),
    earthquakeInsurance: amount(d.earthquakeInsurance),
    medicalPaid: amount(d.medicalPaid),
    medicalReimbursed: amount(d.medicalReimbursed),
    donations: amount(d.donations),
    spouse: amount(d.spouse),
    dependents: amount(d.dependents),
    others: amount(d.others),
    blueDeduction:
      d.blueDeduction === 550000 || d.blueDeduction === 100000 ? d.blueDeduction : 650000,
    withholding: amount(d.withholding),
    // v3.9.0 以前のデータにはない(0 として読み込む)
    prepaidTax: amount(d.prepaidTax),
    lossCarryforward: amount(d.lossCarryforward),
  };
}

function sanitizeInventory(raw: unknown): InventoryCount | null {
  if (!raw || typeof raw !== 'object') return null;
  const i = raw as Partial<InventoryCount>;
  if (typeof i.year !== 'number' || !Number.isInteger(i.year) || i.year < 2000 || i.year > 2100) {
    return null;
  }
  if (typeof i.amount !== 'number' || !Number.isFinite(i.amount) || i.amount <= 0) return null;
  return { year: i.year, amount: Math.round(i.amount) };
}

function sanitizeIssuer(raw: unknown): IssuerProfile {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_ISSUER };
  const s = raw as Partial<IssuerProfile>;
  return {
    name: str(s.name),
    invoiceRegNumber: str(s.invoiceRegNumber),
    address: str(s.address),
    tel: str(s.tel),
    email: str(s.email),
    bankInfo: str(s.bankInfo),
    nameKana: str(s.nameKana),
    yago: str(s.yago),
    shokugyo: str(s.shokugyo),
    etaxId: str(s.etaxId),
    zeimushoCode: str(s.zeimushoCode),
    zeimushoName: str(s.zeimushoName),
  };
}

function sanitizeTaxSettings(raw: unknown): TaxSettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_TAX_SETTINGS };
  const s = raw as Partial<TaxSettings>;
  return {
    taxable: s.taxable === true,
    method:
      s.method === 'general' || s.method === 'simplified' || s.method === 'special20'
        ? s.method
        : DEFAULT_TAX_SETTINGS.method,
    simplifiedType:
      typeof s.simplifiedType === 'number' && [1, 2, 3, 4, 5, 6].includes(s.simplifiedType)
        ? (s.simplifiedType as TaxSettings['simplifiedType'])
        : DEFAULT_TAX_SETTINGS.simplifiedType,
  };
}

function sanitizeRule(raw: unknown): Rule | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<Rule>;
  if (typeof r.keyword !== 'string' || r.keyword.trim() === '') return null;
  if (typeof r.account !== 'string' || r.account === '') return null;
  return {
    id: typeof r.id === 'string' && r.id !== '' ? r.id : uid(),
    keyword: r.keyword.trim(),
    account: r.account,
  };
}

function sanitizeAnbunSetting(raw: unknown): AnbunSetting | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Partial<AnbunSetting>;
  if (typeof s.account !== 'string' || s.account === '') return null;
  if (s.type !== 'percent' && s.type !== 'fixed') return null;
  if (typeof s.value !== 'number' || !Number.isFinite(s.value) || s.value <= 0) return null;
  const value = s.type === 'percent' ? Math.min(100, Math.round(s.value)) : Math.round(s.value);
  const memo = typeof s.memo === 'string' ? s.memo.trim() : '';
  return {
    id: typeof s.id === 'string' && s.id !== '' ? s.id : uid(),
    account: s.account,
    ...(isYear(s.fromYear) ? { fromYear: s.fromYear } : {}),
    type: s.type,
    value,
    ...(memo ? { memo } : {}),
  };
}
