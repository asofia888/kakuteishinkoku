import { accountLabel, accountType, isExcluded } from './accounts';
import { transactionsOfYear } from './aggregate';
import {
  bookValueAtEnd,
  bookValueAtStart,
  depreciationForYear,
  isDeferred,
} from './assets';
import { escapeFormulaCell } from './csv';
import { FixedAsset, InventoryCount, OpeningBalance, Transaction } from './types';

/**
 * 複式簿記エンジン。
 * 取引(収支 + 勘定科目 + 決済手段)から複式仕訳を自動導出し、
 * 仕訳帳・総勘定元帳・貸借対照表を作る。
 *
 * 仕訳のルール:
 * - 収入:            (借) 決済手段        / (貸) 収入科目
 * - 経費:            (借) 経費科目(事業分) / (貸) 決済手段
 *                    (借) 事業主貸(家事分)
 * - 対象外の入金:     (借) 決済手段        / (貸) 事業主借
 * - 対象外の支払い:   (借) 事業主貸        / (貸) 決済手段
 * - 売掛金の回収:     (借) 決済手段        / (貸) 売掛金
 * - カード引落し:     (借) 未払金(カード)  / (貸) 決済手段
 * - 未払金の支払い:   (借) 買掛金・未払金  / (貸) 決済手段
 * 決済手段が「事業主(私費)」のときは、借方では事業主貸・貸方では事業主借になる。
 */

/** 貸借対照表側の勘定ID(資産・負債・資本) */
export type LedgerAccountId =
  | 'cash'
  | 'bank'
  | 'receivable'
  | 'inventory'
  | 'fixed_asset'
  | 'deferred_asset'
  | 'card'
  | 'payable'
  | 'owner_draw'
  | 'owner_invest';

export const LEDGER_LABELS: Record<LedgerAccountId, string> = {
  cash: '現金',
  bank: '普通預金',
  receivable: '売掛金',
  inventory: '棚卸資産(商品)',
  fixed_asset: '減価償却資産(工具器具備品等)',
  deferred_asset: '繰延資産(開業費等)',
  card: '未払金(クレジットカード)',
  payable: '買掛金・未払金',
  owner_draw: '事業主貸',
  owner_invest: '事業主借',
};

/** 期首残高(OpeningBalance)から引き継ぐ資産勘定。棚卸・固定資産・繰延資産は台帳から自動算出 */
const ASSET_IDS: LedgerAccountId[] = ['cash', 'bank', 'receivable'];
const LIABILITY_IDS: LedgerAccountId[] = ['card', 'payable'];
const DEBIT_POSITIVE_IDS: string[] = [
  'cash',
  'bank',
  'receivable',
  'inventory',
  'fixed_asset',
  'deferred_asset',
  'owner_draw',
];

/** 仕訳の勘定ラベル(B/S勘定 + 損益科目の両方を解決する) */
export function ledgerLineLabel(account: string): string {
  return (LEDGER_LABELS as Record<string, string>)[account] ?? accountLabel(account);
}

export interface JournalLine {
  account: string;
  amount: number;
}

export interface JournalEntry {
  txId: string;
  date: string;
  description: string;
  debits: JournalLine[];
  credits: JournalLine[];
}

/**
 * 取引1件から複式仕訳を導出する。
 * 未仕訳(account=null)と、私費で払った私的な取引(帳簿外)は null。
 */
export function entryForTransaction(t: Transaction): JournalEntry | null {
  if (t.account === null) return null;
  const base = { txId: t.id, date: t.date, description: t.description };
  // 決済手段の勘定。「事業主(私費)」だけは借方と貸方で科目が変わる
  const fundDr: string = t.fund === 'owner' ? 'owner_draw' : t.fund;
  const fundCr: string = t.fund === 'owner' ? 'owner_invest' : t.fund;

  if (isExcluded(t.account)) {
    // 私費で払った私的な取引は事業の帳簿に載らない
    if (t.fund === 'owner') return null;
    return t.type === 'income'
      ? {
          ...base,
          debits: [{ account: fundDr, amount: t.amount }],
          credits: [{ account: 'owner_invest', amount: t.amount }],
        }
      : {
          ...base,
          debits: [{ account: 'owner_draw', amount: t.amount }],
          credits: [{ account: fundCr, amount: t.amount }],
        };
  }

  if (t.account === 'ar_collect') {
    return {
      ...base,
      debits: [{ account: fundDr, amount: t.amount }],
      credits: [{ account: 'receivable', amount: t.amount }],
    };
  }
  if (t.account === 'card_payment') {
    return {
      ...base,
      debits: [{ account: 'card', amount: t.amount }],
      credits: [{ account: fundCr, amount: t.amount }],
    };
  }
  if (t.account === 'ap_payment') {
    return {
      ...base,
      debits: [{ account: 'payable', amount: t.amount }],
      credits: [{ account: fundCr, amount: t.amount }],
    };
  }
  if (t.account === 'asset_purchase') {
    // 資産計上(経費にしない)。経費化は固定資産台帳の減価償却で行う
    return {
      ...base,
      debits: [{ account: 'fixed_asset', amount: t.amount }],
      credits: [{ account: fundCr, amount: t.amount }],
    };
  }
  if (t.account === 'fund_transfer') {
    // 資金の間の移動(ATM引き出し・預け入れなど)。損益に影響しない
    const counter = t.counterFund ?? (t.fund === 'cash' ? 'bank' : 'cash');
    const counterDr: string = counter === 'owner' ? 'owner_draw' : counter;
    const counterCr: string = counter === 'owner' ? 'owner_invest' : counter;
    return t.type === 'expense'
      ? // 支出 = fund から counterFund へ(例: 預金からATMで現金を引き出す)
        {
          ...base,
          debits: [{ account: counterDr, amount: t.amount }],
          credits: [{ account: fundCr, amount: t.amount }],
        }
      : // 収入 = counterFund から fund へ(例: 現金を口座へ預け入れる)
        {
          ...base,
          debits: [{ account: fundDr, amount: t.amount }],
          credits: [{ account: counterCr, amount: t.amount }],
        };
  }

  if (t.type === 'income') {
    return {
      ...base,
      debits: [{ account: fundDr, amount: t.amount }],
      credits: [{ account: t.account, amount: t.amount }],
    };
  }

  // 経費: 家事按分の家事分は事業主貸として経費から外す
  const debits: JournalLine[] = [];
  if (t.businessAmount > 0) debits.push({ account: t.account, amount: t.businessAmount });
  const ownerPart = t.amount - t.businessAmount;
  if (ownerPart > 0) debits.push({ account: 'owner_draw', amount: ownerPart });
  return { ...base, debits, credits: [{ account: fundCr, amount: t.amount }] };
}

/** 仕訳済みの全取引から仕訳帳を作る(日付順) */
export function deriveJournal(transactions: Transaction[]): JournalEntry[] {
  return [...transactions]
    .sort((a, b) => a.date.localeCompare(b.date) || a.createdAt - b.createdAt)
    .map(entryForTransaction)
    .filter((e): e is JournalEntry => e !== null);
}

/**
 * 固定資産台帳から指定年の減価償却の決算整理仕訳(12/31付)を作る。
 * (借)減価償却費(事業分)+ 事業主貸(家事分) / (貸)減価償却資産
 */
export function depreciationEntries(assets: FixedAsset[], year: number): JournalEntry[] {
  const entries: JournalEntry[] = [];
  for (const a of assets) {
    const d = depreciationForYear(a, year);
    if (d.total === 0) continue;
    const debits: JournalLine[] = [];
    if (d.business > 0) debits.push({ account: 'depreciation', amount: d.business });
    if (d.ownerPart > 0) debits.push({ account: 'owner_draw', amount: d.ownerPart });
    entries.push({
      txId: `dep-${a.id}-${year}`,
      date: `${year}-12-31`,
      description: `${isDeferred(a) ? '繰延資産償却' : '減価償却費'} ${a.name}`,
      debits,
      credits: [{ account: isDeferred(a) ? 'deferred_asset' : 'fixed_asset', amount: d.total }],
    });
  }
  return entries;
}

/**
 * 繰延資産(開業費)の計上仕訳。開業費は通常、開業前に個人資金で支出するため、
 * 台帳に登録された年に (借)繰延資産 / (貸)事業主借 を自動起票する
 * (「固定資産の取得」取引は不要。貸借は常に一致する)。
 */
export function deferredAcquisitionEntries(assets: FixedAsset[], year: number): JournalEntry[] {
  return assets
    .filter((a) => isDeferred(a) && a.acquiredDate.startsWith(`${year}-`) && a.cost > 0)
    .map((a) => ({
      txId: `deferred-acq-${a.id}`,
      date: a.acquiredDate,
      description: `開業費等の計上 ${a.name}`,
      debits: [{ account: 'deferred_asset', amount: a.cost }],
      credits: [{ account: 'owner_invest', amount: a.cost }],
    }));
}

/** 指定年末の棚卸高(未登録は0) */
export function inventoryAmount(inventories: InventoryCount[], year: number): number {
  return inventories.find((i) => i.year === year)?.amount ?? 0;
}

/**
 * 年末棚卸高から売上原価の決算整理仕訳を作る。
 * 期首振替: (借)仕入高 / (貸)棚卸資産、期末振替: (借)棚卸資産 / (貸)仕入高。
 * これで仕入高が「期首 + 仕入 − 期末 = 売上原価」になる。
 */
export function inventoryEntries(inventories: InventoryCount[], year: number): JournalEntry[] {
  const opening = inventoryAmount(inventories, year - 1);
  const closing = inventoryAmount(inventories, year);
  const entries: JournalEntry[] = [];
  if (opening > 0) {
    entries.push({
      txId: `inv-open-${year}`,
      date: `${year}-12-31`,
      description: '期首商品棚卸高の振替(売上原価へ)',
      debits: [{ account: 'purchases', amount: opening }],
      credits: [{ account: 'inventory', amount: opening }],
    });
  }
  if (closing > 0) {
    entries.push({
      txId: `inv-close-${year}`,
      date: `${year}-12-31`,
      description: '期末商品棚卸高の振替(売上原価から控除)',
      debits: [{ account: 'inventory', amount: closing }],
      credits: [{ account: 'purchases', amount: closing }],
    });
  }
  return entries;
}

/** 指定年の全仕訳(取引由来 + 減価償却・棚卸の決算整理仕訳) */
export function journalForYear(
  transactions: Transaction[],
  year: number,
  assets: FixedAsset[] = [],
  inventories: InventoryCount[] = [],
): JournalEntry[] {
  return [
    ...deriveJournal(transactionsOfYear(transactions, year)),
    ...deferredAcquisitionEntries(assets, year),
    ...depreciationEntries(assets, year),
    ...inventoryEntries(inventories, year),
  ];
}

// ── 貸借対照表 ──

export interface BalanceSheetRow {
  id: string;
  label: string;
  /** 期首残高(事業主貸/借・所得は期首0のため表示は「—」) */
  opening: number;
  closing: number;
}

export interface BalanceSheet {
  year: number;
  assets: BalanceSheetRow[];
  liabilities: BalanceSheetRow[];
  equity: BalanceSheetRow[];
  totalAssetsOpening: number;
  totalAssetsClosing: number;
  totalLiabEquityOpening: number;
  totalLiabEquityClosing: number;
  /** 借方合計と貸方合計が一致しているか(複式簿記の検算) */
  balanced: boolean;
  /** 青色申告特別控除前の所得金額(損益計算と一致する) */
  profit: number;
  /** 元入金(期首の 資産 - 負債) */
  capital: number;
  /** 翌年の元入金 = 元入金 + 所得 + 事業主借 - 事業主貸 */
  nextCapital: number;
}

export function emptyOpeningBalance(year: number): OpeningBalance {
  return { year, cash: 0, bank: 0, receivable: 0, card: 0, payable: 0 };
}

/**
 * 指定年の仕訳から貸借対照表を作る(期首残高は未登録なら0)。
 * 棚卸資産・減価償却資産の残高は棚卸高・固定資産台帳から自動算出され、
 * 元入金(期首の資産 − 負債)にも自動で含まれる。
 */
export function buildBalanceSheet(
  transactions: Transaction[],
  year: number,
  opening?: OpeningBalance,
  fixedAssets: FixedAsset[] = [],
  inventories: InventoryCount[] = [],
): BalanceSheet {
  const ob = opening ?? emptyOpeningBalance(year);
  const entries = journalForYear(transactions, year, fixedAssets, inventories);

  const dr = new Map<string, number>();
  const cr = new Map<string, number>();
  for (const e of entries) {
    for (const l of e.debits) dr.set(l.account, (dr.get(l.account) ?? 0) + l.amount);
    for (const l of e.credits) cr.set(l.account, (cr.get(l.account) ?? 0) + l.amount);
  }
  const d = (id: string) => dr.get(id) ?? 0;
  const c = (id: string) => cr.get(id) ?? 0;

  // 損益: 収益 = 収入科目の貸方、費用 = 経費科目の借方(振替・B/S勘定は損益に出ない)
  let revenue = 0;
  let costs = 0;
  for (const [id, v] of cr) if (accountType(id) === 'income') revenue += v;
  for (const [id, v] of dr) if (accountType(id) === 'income') revenue -= v;
  for (const [id, v] of dr) if (accountType(id) === 'expense') costs += v;
  for (const [id, v] of cr) if (accountType(id) === 'expense') costs -= v;
  const profit = revenue - costs;

  const tangible = fixedAssets.filter((a) => !isDeferred(a));
  const deferred = fixedAssets.filter((a) => isDeferred(a));
  const openOf: Record<LedgerAccountId, number> = {
    cash: ob.cash,
    bank: ob.bank,
    receivable: ob.receivable,
    inventory: inventoryAmount(inventories, year - 1),
    fixed_asset: tangible.reduce((s, a) => s + bookValueAtStart(a, year), 0),
    deferred_asset: deferred.reduce((s, a) => s + bookValueAtStart(a, year), 0),
    card: ob.card,
    payable: ob.payable,
    owner_draw: 0,
    owner_invest: 0,
  };

  const assets: BalanceSheetRow[] = ASSET_IDS.map((id) => ({
    id,
    label: LEDGER_LABELS[id],
    opening: openOf[id],
    closing: openOf[id] + d(id) - c(id),
  }));
  // 棚卸資産: 決算整理仕訳(期首/期末振替)で期末棚卸高に一致する
  assets.push({
    id: 'inventory',
    label: LEDGER_LABELS.inventory,
    opening: openOf.inventory,
    closing: openOf.inventory + d('inventory') - c('inventory'),
  });
  // 減価償却資産: 未償却残高は固定資産台帳が正。取得年に「固定資産の取得」取引が
  // 正しく登録されていれば仕訳の増減とも一致し、貸借が一致する
  assets.push({
    id: 'fixed_asset',
    label: LEDGER_LABELS.fixed_asset,
    opening: openOf.fixed_asset,
    closing: tangible.reduce((s, a) => s + bookValueAtEnd(a, year), 0),
  });
  // 繰延資産(開業費): 計上仕訳(開業費/事業主借)を自動起票するため常に貸借一致する
  if (openOf.deferred_asset > 0 || deferred.length > 0) {
    assets.push({
      id: 'deferred_asset',
      label: LEDGER_LABELS.deferred_asset,
      opening: openOf.deferred_asset,
      closing: deferred.reduce((s, a) => s + bookValueAtEnd(a, year), 0),
    });
  }
  const ownerDraw = d('owner_draw') - c('owner_draw');
  assets.push({ id: 'owner_draw', label: LEDGER_LABELS.owner_draw, opening: 0, closing: ownerDraw });

  const liabilities: BalanceSheetRow[] = LIABILITY_IDS.map((id) => ({
    id,
    label: LEDGER_LABELS[id],
    opening: openOf[id],
    closing: openOf[id] + c(id) - d(id),
  }));

  const capital =
    ob.cash +
    ob.bank +
    ob.receivable +
    openOf.inventory +
    openOf.fixed_asset +
    openOf.deferred_asset -
    ob.card -
    ob.payable;
  const ownerInvest = c('owner_invest') - d('owner_invest');
  const equity: BalanceSheetRow[] = [
    { id: 'owner_invest', label: LEDGER_LABELS.owner_invest, opening: 0, closing: ownerInvest },
    { id: 'capital', label: '元入金', opening: capital, closing: capital },
    { id: 'profit', label: '青色申告特別控除前の所得金額', opening: 0, closing: profit },
  ];

  const totalAssetsOpening = assets.reduce((s, r) => s + r.opening, 0);
  const totalAssetsClosing = assets.reduce((s, r) => s + r.closing, 0);
  const totalLiabEquityOpening =
    liabilities.reduce((s, r) => s + r.opening, 0) + equity.reduce((s, r) => s + r.opening, 0);
  const totalLiabEquityClosing =
    liabilities.reduce((s, r) => s + r.closing, 0) + equity.reduce((s, r) => s + r.closing, 0);

  return {
    year,
    assets,
    liabilities,
    equity,
    totalAssetsOpening,
    totalAssetsClosing,
    totalLiabEquityOpening,
    totalLiabEquityClosing,
    balanced: totalAssetsClosing === totalLiabEquityClosing,
    profit,
    capital,
    nextCapital: capital + profit + ownerInvest - ownerDraw,
  };
}

/**
 * 前年末の貸借対照表から翌年の期首残高を作る(期首残高の自動繰越)。
 * 元入金は「資産 - 負債」で自動的に 前年元入金 + 所得 + 事業主借 - 事業主貸 に一致する。
 */
export function carryForwardOpening(prev: BalanceSheet): OpeningBalance {
  const closingOf = (rows: BalanceSheetRow[], id: string) =>
    rows.find((r) => r.id === id)?.closing ?? 0;
  return {
    year: prev.year + 1,
    cash: closingOf(prev.assets, 'cash'),
    bank: closingOf(prev.assets, 'bank'),
    receivable: closingOf(prev.assets, 'receivable'),
    card: closingOf(prev.liabilities, 'card'),
    payable: closingOf(prev.liabilities, 'payable'),
  };
}

// ── 総勘定元帳 ──

export interface GeneralLedgerRow {
  date: string;
  description: string;
  /** 相手勘定(複合仕訳は「諸口」) */
  counter: string;
  debit: number;
  credit: number;
  balance: number;
}

/** 借方をプラスとして残高を計算する勘定か(資産・費用・事業主貸) */
function isDebitPositive(account: string): boolean {
  if (DEBIT_POSITIVE_IDS.includes(account)) return true;
  return accountType(account) === 'expense';
}

/** 指定勘定の総勘定元帳(日付順・残高付き) */
export function generalLedger(
  entries: JournalEntry[],
  account: string,
  openingBalance = 0,
): GeneralLedgerRow[] {
  const rows: GeneralLedgerRow[] = [];
  let balance = openingBalance;
  const drPlus = isDebitPositive(account);
  for (const e of entries) {
    const debit = e.debits.filter((l) => l.account === account).reduce((s, l) => s + l.amount, 0);
    const credit = e.credits.filter((l) => l.account === account).reduce((s, l) => s + l.amount, 0);
    if (debit === 0 && credit === 0) continue;
    // 相手勘定: 自分以外の行が1つならその科目、複数なら「諸口」
    const others = [
      ...e.debits.filter((l) => l.account !== account),
      ...e.credits.filter((l) => l.account !== account),
    ];
    const counter = others.length === 1 ? ledgerLineLabel(others[0].account) : '諸口';
    balance += drPlus ? debit - credit : credit - debit;
    rows.push({ date: e.date, description: e.description, counter, debit, credit, balance });
  }
  return rows;
}

/** 元帳に表示できる勘定の一覧(B/S勘定 + 仕訳に登場する損益科目) */
export function ledgerAccountOptions(entries: JournalEntry[]): { id: string; label: string }[] {
  const used = new Set<string>();
  for (const e of entries) {
    for (const l of e.debits) used.add(l.account);
    for (const l of e.credits) used.add(l.account);
  }
  const bs = (Object.keys(LEDGER_LABELS) as LedgerAccountId[]).map((id) => ({
    id,
    label: LEDGER_LABELS[id],
  }));
  const pl = [...used]
    .filter((id) => !(id in LEDGER_LABELS))
    .sort()
    .map((id) => ({ id, label: accountLabel(id) }));
  return [...bs, ...pl];
}

// ── CSVエクスポート ──

function csvCell(s: string): string {
  return `"${escapeFormulaCell(s).replace(/"/g, '""')}"`;
}

/** 仕訳帳をCSVにする(複合仕訳は行を分ける。Excel対応のためBOM付き) */
export function journalToCsv(entries: JournalEntry[]): string {
  const lines = ['No,日付,借方科目,借方金額,貸方科目,貸方金額,摘要'];
  entries.forEach((e, i) => {
    const n = Math.max(e.debits.length, e.credits.length);
    for (let row = 0; row < n; row++) {
      const dLine = e.debits[row];
      const cLine = e.credits[row];
      lines.push(
        [
          row === 0 ? i + 1 : '',
          row === 0 ? e.date : '',
          dLine ? csvCell(ledgerLineLabel(dLine.account)) : '',
          dLine ? dLine.amount : '',
          cLine ? csvCell(ledgerLineLabel(cLine.account)) : '',
          cLine ? cLine.amount : '',
          row === 0 ? csvCell(e.description) : '',
        ].join(','),
      );
    }
  });
  return '\ufeff' + lines.join('\r\n');
}

/** 貸借対照表をCSVにする(青色申告決算書の形式に合わせた 期首/期末 の2列) */
export function balanceSheetToCsv(bs: BalanceSheet): string {
  const lines: string[] = [];
  lines.push(`"${bs.year}年分 貸借対照表(${bs.year}年1月1日 / ${bs.year}年12月31日)"`);
  lines.push('');
  lines.push('部,科目,期首(1月1日),期末(12月31日)');
  for (const r of bs.assets) lines.push(`資産の部,${csvCell(r.label)},${r.opening},${r.closing}`);
  lines.push(`資産の部,合計,${bs.totalAssetsOpening},${bs.totalAssetsClosing}`);
  for (const r of bs.liabilities)
    lines.push(`負債の部,${csvCell(r.label)},${r.opening},${r.closing}`);
  for (const r of bs.equity) lines.push(`資本の部,${csvCell(r.label)},${r.opening},${r.closing}`);
  lines.push(`負債・資本の部,合計,${bs.totalLiabEquityOpening},${bs.totalLiabEquityClosing}`);
  lines.push('');
  lines.push(`翌年の元入金(元入金+所得+事業主借-事業主貸),,,${bs.nextCapital}`);
  return '\ufeff' + lines.join('\r\n');
}
