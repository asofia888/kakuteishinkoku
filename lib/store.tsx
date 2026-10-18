'use client';

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { applyAnbun } from './anbun';
import { sanitizeAppData } from './backup';
import { buildDemoData } from './demo';
import { buildInvoiceTransactions } from './invoice';
import { changedLockedYears, isLockedDate } from './lock';
import { openPersistence, Persistence } from './persist';
import { buildPayrollTransactions } from './payroll';
import { applyRulesToTransactions, buildDefaultRules } from './rules';
import { taxSettingsFor, updateTaxSettingsForYear } from './tax';
import {
  AnbunSetting,
  AppData,
  DEFAULT_ISSUER,
  DEFAULT_TAX_SETTINGS,
  DeductionEntry,
  FixedAsset,
  FundAccount,
  Invoice,
  InventoryCount,
  IssuerProfile,
  OpeningBalance,
  Partner,
  PayrollEntry,
  Reconciliation,
  RentPayee,
  Rule,
  TaxSettings,
  Transaction,
  uid,
  YearEndAdjustment,
} from './types';

/** 申告済みロックにより保存されなかった変更の通知(バナー表示用) */
export interface LockNotice {
  /** 帳簿の数字が変わるため変更を止めたロック中の年 */
  years: number[];
  /** 取込・追加でロック中の年のため追加しなかった取引の件数 */
  skipped?: number;
  at: number;
}

interface Store {
  /** 保存データの読込が完了したか(SSR/初回描画ではfalse) */
  ready: boolean;
  /** 直近の保存が失敗したか(容量超過など)。true の間は変更が永続化されていない */
  saveError: boolean;
  /** 起動時に保存データを読み取れず、破損データを退避キーへ写して空で起動したか */
  dataCorrupted: boolean;
  transactions: Transaction[];
  rules: Rule[];
  anbunSettings: AnbunSetting[];
  openingBalances: OpeningBalance[];
  /** その年分に適用する消費税の設定 */
  taxSettingsFor: (year: number) => TaxSettings;
  invoices: Invoice[];
  issuer: IssuerProfile;
  assets: FixedAsset[];
  inventories: InventoryCount[];
  deductions: DeductionEntry[];
  partners: Partner[];
  payrolls: PayrollEntry[];
  yearEndAdjustments: YearEndAdjustment[];
  /** 申告済みとしてロックした年 */
  lockedYears: number[];
  /** 直近でロックにより保存されなかった変更(null = なし) */
  lockNotice: LockNotice | null;
  dismissLockNotice: () => void;
  /** 年を申告済みとしてロック/解除する */
  setYearLocked: (year: number, locked: boolean) => void;

  /** 口座・カードの補助科目 */
  fundAccounts: FundAccount[];
  addFundAccount: (fund: FundAccount['fund'], name: string) => void;
  renameFundAccount: (id: string, name: string) => void;
  /** 口座を削除(その口座の取引は既定の口座として扱われる) */
  deleteFundAccount: (id: string) => void;
  /** 残高照合の記録 */
  reconciliations: Reconciliation[];
  addReconciliation: (r: Omit<Reconciliation, 'id' | 'createdAt'>) => void;
  deleteReconciliation: (id: string) => void;
  /** 地代家賃の支払先(決算書「地代家賃の内訳」) */
  rentPayees: RentPayee[];
  addRentPayee: (p: Omit<RentPayee, 'id' | 'createdAt'>) => void;
  updateRentPayee: (id: string, patch: Partial<RentPayee>) => void;
  deleteRentPayee: (id: string) => void;

  /**
   * 取引を追加(取込・手入力)。按分は自動で再計算される。
   * ロック中の年の取引は追加しない。実際に追加した件数を返す
   */
  addTransactions: (
    txs: Omit<Transaction, 'id' | 'createdAt' | 'businessAmount' | 'anbunApplied'>[],
  ) => number;
  updateTransaction: (id: string, patch: Partial<Transaction>) => void;
  /** 取引を削除。ロック中の年で削除できなかったときは false */
  deleteTransaction: (id: string) => boolean;
  deleteTransactions: (ids: string[]) => boolean;
  /** 削除した取引を元に戻す(Undo用。IDが既に存在するものは追加しない) */
  restoreTransactions: (txs: Transaction[]) => void;
  approveTransactions: (ids: string[], approved: boolean) => void;
  /** 未仕訳の取引にルールを一括適用。更新件数を返す */
  reapplyRules: () => number;

  addRule: (rule: Omit<Rule, 'id'>) => void;
  updateRule: (id: string, patch: Partial<Rule>) => void;
  deleteRule: (id: string) => void;
  moveRule: (id: string, dir: -1 | 1) => void;

  /** 按分設定を保存(同じ科目・同じ適用開始年は置き換え)。ロック中の年の経費が変わるときは false */
  addAnbunSetting: (s: Omit<AnbunSetting, 'id'>) => boolean;
  updateAnbunSetting: (id: string, patch: Partial<AnbunSetting>) => void;
  deleteAnbunSetting: (id: string) => boolean;
  /** 按分を全取引へ一括再適用(自動でも実行されるが明示ボタン用) */
  recalcAnbun: () => void;

  /** 期首残高を登録・更新(年ごとに1件) */
  setOpeningBalance: (ob: OpeningBalance) => void;
  /**
   * 消費税の設定を「その年分から」変更する(前の年分は変わらない。翌年分以後は引き継ぐ)。
   * ロック中の年の設定が変わるときは保存されない
   */
  updateTaxSettings: (year: number, patch: Partial<TaxSettings>) => void;

  addInvoice: (inv: Omit<Invoice, 'id' | 'createdAt'>) => void;
  updateInvoice: (id: string, patch: Partial<Invoice>) => void;
  deleteInvoice: (id: string) => void;
  /** 請求元(自分)の情報を更新 */
  updateIssuer: (patch: Partial<IssuerProfile>) => void;
  /**
   * 請求書を売掛金として売上計上する(発生主義)。
   * 税率ごとの売上取引と源泉徴収の差引を作成し、請求書に紐付ける。作成件数を返す。
   */
  registerInvoiceSales: (invoiceId: string) => number;

  addAsset: (a: Omit<FixedAsset, 'id' | 'createdAt'>) => void;
  updateAsset: (id: string, patch: Partial<FixedAsset>) => void;
  deleteAsset: (id: string) => void;
  /** 年末棚卸高を登録(0を渡すとその年の記録を削除) */
  setInventory: (year: number, amount: number) => void;
  /** 所得控除の入力を保存(年ごとに1件) */
  setDeduction: (entry: DeductionEntry) => void;

  /**
   * 給与を記帳する(賃金台帳への記録 + 手取り支払い・源泉預りの取引を自動起票)。
   * 作成した取引数を返す。
   */
  registerPayroll: (entry: Omit<PayrollEntry, 'id' | 'createdAt' | 'linkedTxIds'>) => number;
  /** 給与記録を削除(自動起票した取引も一緒に削除する) */
  deletePayroll: (id: string) => void;
  /** 年末調整の入力を保存(年×従業員ごとに1件。全項目0なら削除) */
  setYearEndAdjustment: (entry: YearEndAdjustment) => void;

  /** 取引先を登録(同名があれば何もしない)。請求書の保存時に自動で呼ばれる */
  ensurePartner: (name: string) => void;
  updatePartner: (id: string, patch: Partial<Partner>) => void;
  deletePartner: (id: string) => void;

  loadDemoData: () => void;
  clearAll: () => void;
  /** バックアップ(JSON)からの復元。現在の全データを置き換える */
  restoreData: (data: AppData) => void;
  /** バックアップ用に全データを返す */
  exportData: () => AppData;
}

const StoreContext = createContext<Store | null>(null);

function emptyData(): AppData {
  return {
    transactions: [],
    rules: buildDefaultRules(),
    anbunSettings: [],
    openingBalances: [],
    taxSettings: { ...DEFAULT_TAX_SETTINGS },
    taxSettingsByYear: [],
    invoices: [],
    issuer: { ...DEFAULT_ISSUER },
    assets: [],
    inventories: [],
    deductions: [],
    partners: [],
    payrolls: [],
    yearEndAdjustments: [],
    lockedYears: [],
    fundAccounts: [],
    reconciliations: [],
    rentPayees: [],
  };
}

/**
 * 保存されていた値(IndexedDB はオブジェクト、localStorage は JSON 文字列)を読む。
 * バックアップ復元と同じ検証を通し、壊れた要素が混ざっていても起動できるようにする。読めなければ null
 */
function parseStored(value: unknown): AppData | null {
  try {
    const parsed = (typeof value === 'string' ? JSON.parse(value) : value) as Partial<AppData>;
    const data = sanitizeAppData(parsed);
    if (!data) return null;
    // 保存データにルール配列が無い(破損している)場合のみ初期ルールを補う
    if (!Array.isArray(parsed.rules)) data.rules = buildDefaultRules();
    return data;
  } catch {
    return null;
  }
}

async function loadData(p: Persistence): Promise<{ data: AppData; corrupted: boolean }> {
  let stored;
  try {
    stored = await p.load();
  } catch {
    // 保存先に触れない環境は空で起動する(読めたのに壊れていた場合だけ警告する)
    return { data: emptyData(), corrupted: false };
  }
  if (!stored) return { data: emptyData(), corrupted: false };
  const data = parseStored(stored.value);
  if (!data) {
    // 空の状態で起動した直後に操作すると保存が原本を上書きするため、先に退避して手動復旧の道を残す
    await p.salvage(stored.value, stored.legacy).catch(() => {
      // 退避すら失敗する環境(容量不足等)でも起動は続ける。corrupted フラグで警告は出る
    });
    return { data: emptyData(), corrupted: true };
  }
  if (stored.legacy) {
    // v3.10.0 以前の localStorage のデータを IndexedDB へ移す。失敗しても次の保存で書かれる
    await p.migrate(data).catch(() => {});
  }
  return { data, corrupted: false };
}

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const [data, setData] = useState<AppData>(emptyData);
  const [ready, setReady] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [dataCorrupted, setDataCorrupted] = useState(false);
  const [lockNotice, setLockNotice] = useState<LockNotice | null>(null);
  const skipSave = useRef(true);
  // 保存先(IndexedDB、使えなければ localStorage)。読込が終わるまで null
  const persistRef = useRef<Persistence | null>(null);
  // 最新のデータ。変更は必ずこれを起点に計算する(同じイベント内で続けて変更しても前の変更を失わない。
  // 変更の可否(ロック判定)を state 更新の外で同期的に決めるためにも使う)
  const dataRef = useRef<AppData>(data);
  const commit = useCallback((next: AppData) => {
    dataRef.current = next;
    setData(next);
  }, []);

  // 初回マウント時に保存データを読込(SSRと初回描画の不一致を避ける)。
  // あわせて別タブでの変更を購読する(複数タブで同時編集したとき、後から保存したタブが
  // 相手の変更を丸ごと上書きして帳簿が巻き戻るのを防ぐ)
  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | null = null;
    void (async () => {
      const persistence = await openPersistence();
      const { data: loaded, corrupted } = await loadData(persistence);
      if (cancelled) {
        persistence.close();
        return;
      }
      persistRef.current = persistence;
      // 保存後に按分設定だけ変わっているケースに備えて読込時にも再計算
      loaded.transactions = applyAnbun(loaded.transactions, loaded.anbunSettings);
      skipSave.current = true;
      commit(loaded);
      if (corrupted) setDataCorrupted(true);
      setReady(true);
      unsubscribe = persistence.subscribe((value) => {
        const received = parseStored(value);
        // 壊れた値は無視して自タブのデータを守る
        if (!received) return;
        received.transactions = applyAnbun(received.transactions, received.anbunSettings);
        // 受け取った内容は保存済みの値そのものなので、保存し直さない
        skipSave.current = true;
        commit(received);
      });
    })();
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [commit]); // commit は不変(初回の1回だけ実行される)

  // 変更を保存(読込直後・他タブからの取り込み直後はスキップ)
  useEffect(() => {
    if (!ready) return;
    if (skipSave.current) {
      skipSave.current = false;
      return;
    }
    const persistence = persistRef.current;
    if (!persistence) return;
    // 容量超過などで保存できない場合はバナーで警告する(次の変更時に再試行される)
    persistence.save(data).then(
      () => setSaveError(false),
      () => setSaveError(true),
    );
  }, [data, ready]);

  /**
   * データを変更する唯一の入口。
   * - transactions / anbunSettings の変更に備えて必ず按分を再計算して整合を保つ
   * - ロック中の年の帳簿の数字が変わる変更は保存せず、通知を出して false を返す
   *   (replaceAll = 復元・サンプル読込・全削除はデータを丸ごと入れ替えるので判定しない)
   */
  const mutate = useCallback(
    (fn: (prev: AppData) => AppData, opts?: { replaceAll?: boolean }): boolean => {
      const prev = dataRef.current;
      const raw = fn(prev);
      if (raw === prev) return true;
      const next = { ...raw, transactions: applyAnbun(raw.transactions, raw.anbunSettings) };
      if (!opts?.replaceAll) {
        const years = changedLockedYears(prev, next);
        if (years.length > 0) {
          setLockNotice({ years, at: Date.now() });
          return false;
        }
      }
      commit(next);
      return true;
    },
    [commit],
  );

  const store = useMemo<Store>(() => {
    return {
      ready,
      saveError,
      dataCorrupted,
      transactions: data.transactions,
      rules: data.rules,
      anbunSettings: data.anbunSettings,
      openingBalances: data.openingBalances,
      taxSettingsFor: (year) => taxSettingsFor(data, year),
      invoices: data.invoices,
      issuer: data.issuer,
      assets: data.assets,
      inventories: data.inventories,
      deductions: data.deductions,
      partners: data.partners,
      payrolls: data.payrolls,
      yearEndAdjustments: data.yearEndAdjustments,
      lockedYears: data.lockedYears,
      lockNotice,
      dismissLockNotice: () => setLockNotice(null),

      setYearLocked: (year, locked) => {
        mutate((prev) => ({
          ...prev,
          lockedYears: locked
            ? [...new Set([...prev.lockedYears, year])].sort((a, b) => a - b)
            : prev.lockedYears.filter((y) => y !== year),
        }));
      },

      fundAccounts: data.fundAccounts,
      addFundAccount: (fund, name) => {
        const trimmed = name.trim().slice(0, 30);
        if (!trimmed) return;
        mutate((prev) => ({
          ...prev,
          fundAccounts: [...prev.fundAccounts, { id: uid(), fund, name: trimmed, createdAt: Date.now() }],
        }));
      },
      renameFundAccount: (id, name) => {
        const trimmed = name.trim().slice(0, 30);
        if (!trimmed) return;
        mutate((prev) => ({
          ...prev,
          fundAccounts: prev.fundAccounts.map((a) => (a.id === id ? { ...a, name: trimmed } : a)),
        }));
      },
      deleteFundAccount: (id) =>
        mutate((prev) => ({
          ...prev,
          fundAccounts: prev.fundAccounts.filter((a) => a.id !== id),
        })),
      reconciliations: data.reconciliations,
      addReconciliation: (r) =>
        mutate((prev) => ({
          ...prev,
          reconciliations: [...prev.reconciliations, { ...r, id: uid(), createdAt: Date.now() }],
        })),
      deleteReconciliation: (id) =>
        mutate((prev) => ({
          ...prev,
          reconciliations: prev.reconciliations.filter((r) => r.id !== id),
        })),

      rentPayees: data.rentPayees,
      addRentPayee: (p) =>
        mutate((prev) => ({
          ...prev,
          rentPayees: [...prev.rentPayees, { ...p, id: uid(), createdAt: Date.now() }],
        })),
      updateRentPayee: (id, patch) =>
        mutate((prev) => ({
          ...prev,
          rentPayees: prev.rentPayees.map((p) => (p.id === id ? { ...p, ...patch } : p)),
        })),
      deleteRentPayee: (id) =>
        mutate((prev) => ({ ...prev, rentPayees: prev.rentPayees.filter((p) => p.id !== id) })),

      addTransactions: (txs) => {
        // ロック中の年の取引(CSVに前年分が混ざっていた等)は追加せず、件数を知らせる
        const locked = dataRef.current.lockedYears;
        const accepted = txs.filter((t) => !isLockedDate(locked, t.date));
        const rejected = txs.filter((t) => isLockedDate(locked, t.date));
        if (rejected.length > 0) {
          setLockNotice({
            years: [...new Set(rejected.map((t) => Number(t.date.slice(0, 4))))].sort(),
            skipped: rejected.length,
            at: Date.now(),
          });
        }
        if (accepted.length === 0) return 0;
        const ok = mutate((prev) => ({
          ...prev,
          transactions: [
            ...prev.transactions,
            ...accepted.map((t, i) => ({
              ...t,
              id: uid(),
              createdAt: Date.now() + i,
              businessAmount: t.amount,
              anbunApplied: false,
            })),
          ],
        }));
        return ok ? accepted.length : 0;
      },

      updateTransaction: (id, patch) =>
        mutate((prev) => ({
          ...prev,
          transactions: prev.transactions.map((t) => (t.id === id ? { ...t, ...patch } : t)),
        })),

      deleteTransaction: (id) =>
        mutate((prev) => ({
          ...prev,
          transactions: prev.transactions.filter((t) => t.id !== id),
        })),

      deleteTransactions: (ids) => {
        const set = new Set(ids);
        return mutate((prev) => ({
          ...prev,
          transactions: prev.transactions.filter((t) => !set.has(t.id)),
        }));
      },

      restoreTransactions: (txs) =>
        mutate((prev) => {
          // Undoの二度押しやStrictModeの二重実行で重複しないようIDで弾く
          const existing = new Set(prev.transactions.map((t) => t.id));
          const toAdd = txs.filter((t) => !existing.has(t.id));
          if (toAdd.length === 0) return prev;
          return { ...prev, transactions: [...prev.transactions, ...toAdd] };
        }),

      approveTransactions: (ids, approved) => {
        const set = new Set(ids);
        mutate((prev) => ({
          ...prev,
          transactions: prev.transactions.map((t) =>
            set.has(t.id) && t.account !== null ? { ...t, approved } : t,
          ),
        }));
      },

      reapplyRules: () => {
        // ロック中の年の未仕訳は対象外(仕訳すると申告済みの帳簿が変わるため)
        const cur = dataRef.current;
        const open = cur.transactions.filter((t) => !isLockedDate(cur.lockedYears, t.date));
        const { transactions, updated } = applyRulesToTransactions(open, cur.rules);
        if (updated === 0) return 0;
        const byId = new Map(transactions.map((t) => [t.id, t]));
        const ok = mutate((prev) => ({
          ...prev,
          transactions: prev.transactions.map((t) => byId.get(t.id) ?? t),
        }));
        return ok ? updated : 0;
      },

      addRule: (rule) => mutate((prev) => ({ ...prev, rules: [...prev.rules, { ...rule, id: uid() }] })),

      updateRule: (id, patch) =>
        mutate((prev) => ({
          ...prev,
          rules: prev.rules.map((r) => (r.id === id ? { ...r, ...patch } : r)),
        })),

      deleteRule: (id) =>
        mutate((prev) => ({ ...prev, rules: prev.rules.filter((r) => r.id !== id) })),

      moveRule: (id, dir) =>
        mutate((prev) => {
          const idx = prev.rules.findIndex((r) => r.id === id);
          const to = idx + dir;
          if (idx < 0 || to < 0 || to >= prev.rules.length) return prev;
          const rules = [...prev.rules];
          [rules[idx], rules[to]] = [rules[to], rules[idx]];
          return { ...prev, rules };
        }),

      addAnbunSetting: (s) =>
        mutate((prev) => {
          // 同じ勘定科目・同じ適用開始年の設定は1件のみ(既存があれば置き換え)
          const rest = prev.anbunSettings.filter(
            (x) => !(x.account === s.account && x.fromYear === s.fromYear),
          );
          return { ...prev, anbunSettings: [...rest, { ...s, id: uid() }] };
        }),

      updateAnbunSetting: (id, patch) =>
        mutate((prev) => ({
          ...prev,
          anbunSettings: prev.anbunSettings.map((s) => (s.id === id ? { ...s, ...patch } : s)),
        })),

      deleteAnbunSetting: (id) =>
        mutate((prev) => ({
          ...prev,
          anbunSettings: prev.anbunSettings.filter((s) => s.id !== id),
        })),

      // 同じオブジェクトを返すと「変更なし」とみなされるため、複製して再計算させる
      recalcAnbun: () => {
        mutate((prev) => ({ ...prev }));
      },

      setOpeningBalance: (ob) =>
        mutate((prev) => ({
          ...prev,
          openingBalances: [
            ...prev.openingBalances.filter((x) => x.year !== ob.year),
            ob,
          ].sort((a, b) => a.year - b.year),
        })),

      updateTaxSettings: (year, patch) =>
        mutate((prev) => ({
          ...prev,
          taxSettingsByYear: updateTaxSettingsForYear(prev, year, patch),
        })),

      addInvoice: (inv) =>
        mutate((prev) => ({
          ...prev,
          invoices: [...prev.invoices, { ...inv, id: uid(), createdAt: Date.now() }],
        })),

      updateInvoice: (id, patch) =>
        mutate((prev) => ({
          ...prev,
          invoices: prev.invoices.map((i) => (i.id === id ? { ...i, ...patch } : i)),
        })),

      deleteInvoice: (id) =>
        mutate((prev) => ({ ...prev, invoices: prev.invoices.filter((i) => i.id !== id) })),

      updateIssuer: (patch) =>
        mutate((prev) => ({ ...prev, issuer: { ...prev.issuer, ...patch } })),

      registerInvoiceSales: (invoiceId) => {
        const inv = dataRef.current.invoices.find((i) => i.id === invoiceId);
        if (!inv) return 0;
        // StrictModeでupdaterが2回呼ばれても同じ結果になるよう、取引は先に確定させる
        const txs = buildInvoiceTransactions(inv).map((t, i) => ({
          ...t,
          id: uid(),
          createdAt: Date.now() + i,
          businessAmount: t.amount,
          anbunApplied: false,
        }));
        if (txs.length === 0) return 0;
        const ids = txs.map((t) => t.id);
        const ok = mutate((prev) => ({
          ...prev,
          transactions: [...prev.transactions, ...txs],
          invoices: prev.invoices.map((i) =>
            i.id === invoiceId ? { ...i, linkedTxIds: ids } : i,
          ),
        }));
        return ok ? txs.length : 0;
      },

      addAsset: (a) =>
        mutate((prev) => ({
          ...prev,
          assets: [...prev.assets, { ...a, id: uid(), createdAt: Date.now() }],
        })),

      updateAsset: (id, patch) =>
        mutate((prev) => ({
          ...prev,
          assets: prev.assets.map((a) => (a.id === id ? { ...a, ...patch } : a)),
        })),

      deleteAsset: (id) =>
        mutate((prev) => ({ ...prev, assets: prev.assets.filter((a) => a.id !== id) })),

      setInventory: (year, amount) =>
        mutate((prev) => ({
          ...prev,
          inventories: [
            ...prev.inventories.filter((i) => i.year !== year),
            ...(amount > 0 ? [{ year, amount: Math.round(amount) }] : []),
          ].sort((a, b) => a.year - b.year),
        })),

      setDeduction: (entry) =>
        mutate((prev) => ({
          ...prev,
          deductions: [...prev.deductions.filter((d) => d.year !== entry.year), entry].sort(
            (a, b) => a.year - b.year,
          ),
        })),

      registerPayroll: (entry) => {
        // StrictModeでupdaterが2回呼ばれても同じ結果になるよう、取引は先に確定させる
        const txs = buildPayrollTransactions(entry).map((t, i) => ({
          ...t,
          id: uid(),
          createdAt: Date.now() + i,
          businessAmount: t.amount,
          anbunApplied: false,
        }));
        const record: PayrollEntry = {
          ...entry,
          id: uid(),
          createdAt: Date.now(),
          ...(txs.length > 0 ? { linkedTxIds: txs.map((t) => t.id) } : {}),
        };
        const ok = mutate((prev) => ({
          ...prev,
          transactions: [...prev.transactions, ...txs],
          payrolls: [...prev.payrolls, record],
        }));
        return ok ? txs.length : 0;
      },

      setYearEndAdjustment: (entry) =>
        mutate((prev) => {
          const rest = prev.yearEndAdjustments.filter(
            (a) => !(a.year === entry.year && a.employee === entry.employee),
          );
          const isEmpty =
            entry.personalDeductions === 0 &&
            entry.insuranceDeductions === 0 &&
            entry.declaredSocialInsurance === 0;
          return {
            ...prev,
            yearEndAdjustments: isEmpty
              ? rest
              : [...rest, entry].sort(
                  (a, b) => a.year - b.year || a.employee.localeCompare(b.employee),
                ),
          };
        }),

      deletePayroll: (id) =>
        mutate((prev) => {
          const target = prev.payrolls.find((p) => p.id === id);
          const linked = new Set(target?.linkedTxIds ?? []);
          return {
            ...prev,
            transactions: prev.transactions.filter((t) => !linked.has(t.id)),
            payrolls: prev.payrolls.filter((p) => p.id !== id),
          };
        }),

      ensurePartner: (name) => {
        const trimmed = name.trim();
        if (!trimmed) return;
        mutate((prev) =>
          prev.partners.some((p) => p.name === trimmed)
            ? prev
            : {
                ...prev,
                partners: [
                  ...prev.partners,
                  { id: uid(), name: trimmed, invoiceRegNumber: '', memo: '', createdAt: Date.now() },
                ],
              },
        );
      },

      updatePartner: (id, patch) =>
        mutate((prev) => ({
          ...prev,
          partners: prev.partners.map((p) => (p.id === id ? { ...p, ...patch } : p)),
        })),

      deletePartner: (id) =>
        mutate((prev) => ({ ...prev, partners: prev.partners.filter((p) => p.id !== id) })),

      loadDemoData: () => {
        mutate(() => buildDemoData(), { replaceAll: true });
      },

      clearAll: () => {
        mutate(() => emptyData(), { replaceAll: true });
        // 手動復旧用に残していた写し(退避データ等)も消す
        void persistRef.current?.discardRecoveryCopies().catch(() => {});
      },

      // AppData全体を丸ごと置き換える。スライスを列挙しない(新フィールドの追加漏れを防ぐ)
      restoreData: (d) => {
        mutate(() => ({ ...d }), { replaceAll: true });
      },

      // 同じイベント内の直前の変更も含めて返す(描画前でも最新)
      exportData: () => dataRef.current,
    };
  }, [data, mutate, ready, saveError, dataCorrupted, lockNotice]);

  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}

export function useStore(): Store {
  const store = useContext(StoreContext);
  if (!store) throw new Error('useStore は StoreProvider の内側で使用してください');
  return store;
}
