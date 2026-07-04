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
import { applyRulesToTransactions, buildDefaultRules } from './rules';
import {
  AnbunSetting,
  AppData,
  DEFAULT_ISSUER,
  DEFAULT_TAX_SETTINGS,
  DeductionEntry,
  FixedAsset,
  Invoice,
  InventoryCount,
  IssuerProfile,
  OpeningBalance,
  Rule,
  TaxSettings,
  Transaction,
  uid,
} from './types';

const STORAGE_KEY = 'shinkoku-snap:v2';

interface Store {
  /** localStorage の読込が完了したか(SSR/初回描画ではfalse) */
  ready: boolean;
  /** 直近の保存が失敗したか(容量超過など)。true の間は変更が永続化されていない */
  saveError: boolean;
  transactions: Transaction[];
  rules: Rule[];
  anbunSettings: AnbunSetting[];
  openingBalances: OpeningBalance[];
  taxSettings: TaxSettings;
  invoices: Invoice[];
  issuer: IssuerProfile;
  assets: FixedAsset[];
  inventories: InventoryCount[];
  deductions: DeductionEntry[];

  /** 取引を追加(取込・手入力)。按分は自動で再計算される */
  addTransactions: (
    txs: Omit<Transaction, 'id' | 'createdAt' | 'businessAmount' | 'anbunApplied'>[],
  ) => void;
  updateTransaction: (id: string, patch: Partial<Transaction>) => void;
  deleteTransaction: (id: string) => void;
  deleteTransactions: (ids: string[]) => void;
  /** 削除した取引を元に戻す(Undo用。IDが既に存在するものは追加しない) */
  restoreTransactions: (txs: Transaction[]) => void;
  approveTransactions: (ids: string[], approved: boolean) => void;
  /** 未仕訳の取引にルールを一括適用。更新件数を返す */
  reapplyRules: () => number;

  addRule: (rule: Omit<Rule, 'id'>) => void;
  updateRule: (id: string, patch: Partial<Rule>) => void;
  deleteRule: (id: string) => void;
  moveRule: (id: string, dir: -1 | 1) => void;

  addAnbunSetting: (s: Omit<AnbunSetting, 'id'>) => void;
  updateAnbunSetting: (id: string, patch: Partial<AnbunSetting>) => void;
  deleteAnbunSetting: (id: string) => void;
  /** 按分を全取引へ一括再適用(自動でも実行されるが明示ボタン用) */
  recalcAnbun: () => void;

  /** 期首残高を登録・更新(年ごとに1件) */
  setOpeningBalance: (ob: OpeningBalance) => void;
  updateTaxSettings: (patch: Partial<TaxSettings>) => void;

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
    invoices: [],
    issuer: { ...DEFAULT_ISSUER },
    assets: [],
    inventories: [],
    deductions: [],
  };
}

function loadData(): AppData {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyData();
    const parsed = JSON.parse(raw) as Partial<AppData>;
    // バックアップ復元と同じ検証を通し、壊れた要素が混ざっていても起動できるようにする
    const data = sanitizeAppData(parsed);
    if (!data) return emptyData();
    // 保存データにルール配列が無い(破損している)場合のみ初期ルールを補う
    if (!Array.isArray(parsed.rules)) data.rules = buildDefaultRules();
    return data;
  } catch {
    return emptyData();
  }
}

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const [data, setData] = useState<AppData>(emptyData);
  const [ready, setReady] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const skipSave = useRef(true);

  // 初回マウント時にlocalStorageから読込(SSRと初回描画の不一致を避ける)
  useEffect(() => {
    const loaded = loadData();
    // 保存後に按分設定だけ変わっているケースに備えて読込時にも再計算
    loaded.transactions = applyAnbun(loaded.transactions, loaded.anbunSettings);
    skipSave.current = true;
    setData(loaded);
    setReady(true);
  }, []);

  // 別タブでの変更を反映する(複数タブで同時編集したとき、後から保存したタブが
  // 相手の変更を丸ごと上書きして帳簿が巻き戻るのを防ぐ)。
  // storage イベントは変更を行った本人のタブでは発火しない。
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY || e.newValue === null) return;
      try {
        const received = sanitizeAppData(JSON.parse(e.newValue));
        if (!received) return;
        received.transactions = applyAnbun(received.transactions, received.anbunSettings);
        // 受け取った内容は保存済みの値そのものなので、保存し直さない
        skipSave.current = true;
        setData(received);
      } catch {
        // 壊れた値は無視して自タブのデータを守る
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  // 変更を保存(読込直後の1回はスキップ)
  useEffect(() => {
    if (!ready) return;
    if (skipSave.current) {
      skipSave.current = false;
      return;
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      setSaveError(false);
    } catch {
      // 容量超過などで保存できない場合はバナーで警告する(次の変更時に再試行される)
      setSaveError(true);
    }
  }, [data, ready]);

  /** transactions / anbunSettings を変更するときは必ず按分を再計算して整合を保つ */
  const mutate = useCallback((fn: (prev: AppData) => AppData) => {
    setData((prev) => {
      const next = fn(prev);
      return { ...next, transactions: applyAnbun(next.transactions, next.anbunSettings) };
    });
  }, []);

  const store = useMemo<Store>(() => {
    return {
      ready,
      saveError,
      transactions: data.transactions,
      rules: data.rules,
      anbunSettings: data.anbunSettings,
      openingBalances: data.openingBalances,
      taxSettings: data.taxSettings,
      invoices: data.invoices,
      issuer: data.issuer,
      assets: data.assets,
      inventories: data.inventories,
      deductions: data.deductions,

      addTransactions: (txs) =>
        mutate((prev) => ({
          ...prev,
          transactions: [
            ...prev.transactions,
            ...txs.map((t, i) => ({
              ...t,
              id: uid(),
              createdAt: Date.now() + i,
              businessAmount: t.amount,
              anbunApplied: false,
            })),
          ],
        })),

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
        mutate((prev) => ({
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
        // StrictModeでupdaterが2回呼ばれても件数が狂わないよう、先に計算してから反映する
        const { transactions, updated } = applyRulesToTransactions(data.transactions, data.rules);
        if (updated > 0) mutate((prev) => ({ ...prev, transactions }));
        return updated;
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
          // 同じ勘定科目の設定は1件のみ(既存があれば置き換え)
          const rest = prev.anbunSettings.filter((x) => x.account !== s.account);
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

      recalcAnbun: () => mutate((prev) => prev),

      setOpeningBalance: (ob) =>
        mutate((prev) => ({
          ...prev,
          openingBalances: [
            ...prev.openingBalances.filter((x) => x.year !== ob.year),
            ob,
          ].sort((a, b) => a.year - b.year),
        })),

      updateTaxSettings: (patch) =>
        mutate((prev) => ({ ...prev, taxSettings: { ...prev.taxSettings, ...patch } })),

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
        const inv = data.invoices.find((i) => i.id === invoiceId);
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
        mutate((prev) => ({
          ...prev,
          transactions: [...prev.transactions, ...txs],
          invoices: prev.invoices.map((i) =>
            i.id === invoiceId ? { ...i, linkedTxIds: ids } : i,
          ),
        }));
        return txs.length;
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

      loadDemoData: () => {
        mutate(() => buildDemoData());
      },

      clearAll: () => {
        mutate(() => emptyData());
      },

      // AppData全体を丸ごと置き換える。スライスを列挙しない(新フィールドの追加漏れを防ぐ)
      restoreData: (d) => {
        mutate(() => ({ ...d }));
      },

      exportData: () => data,
    };
  }, [data, mutate, ready, saveError]);

  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}

export function useStore(): Store {
  const store = useContext(StoreContext);
  if (!store) throw new Error('useStore は StoreProvider の内側で使用してください');
  return store;
}
