'use client';

import React, { useMemo, useState } from 'react';
import { Alert, btn, Card, EmptyState, input, PageHeader, selectCls } from '@/components/ui';
import { availableYears, transactionsOfYear } from '@/lib/aggregate';
import { bookValueAtStart, isDeferred } from '@/lib/assets';
import { downloadText } from '@/lib/csv';
import { dateLabel, yen } from '@/lib/format';
import {
  BalanceSheet,
  balanceSheetToCsv,
  buildBalanceSheet,
  carryForwardOpening,
  generalLedger,
  inventoryAmount,
  journalForYear,
  journalToCsv,
  ledgerAccountOptions,
  ledgerLineLabel,
} from '@/lib/ledger';
import { useStore } from '@/lib/store';
import { OpeningBalance } from '@/lib/types';

/** 期首残高の入力フィールド定義 */
const OB_FIELDS: { key: keyof Omit<OpeningBalance, 'year'>; label: string; hint: string }[] = [
  { key: 'cash', label: '現金', hint: '事業用の手元現金' },
  { key: 'bank', label: '普通預金', hint: '事業用口座の1/1残高' },
  { key: 'receivable', label: '売掛金', hint: '前年に計上し未回収の請求' },
  { key: 'card', label: 'カード未払金', hint: '前年利用・未引落しの額' },
  { key: 'payable', label: '買掛金・未払金', hint: 'その他の未払い' },
  { key: 'deposit', label: '預り金', hint: '未納付の源泉所得税など' },
];

export default function BooksPage() {
  const store = useStore();
  const [year, setYear] = useState(() => new Date().getFullYear());
  const [message, setMessage] = useState<string | null>(null);

  const years = useMemo(
    () => availableYears(store.transactions, new Date().getFullYear()),
    [store.transactions],
  );

  const opening = store.openingBalances.find((ob) => ob.year === year);

  // 取引由来の仕訳 + 減価償却・棚卸の決算整理仕訳(12/31付)
  const journal = useMemo(
    () => journalForYear(store.transactions, year, store.assets, store.inventories),
    [store.transactions, year, store.assets, store.inventories],
  );

  const bs = useMemo(
    () => buildBalanceSheet(store.transactions, year, opening, store.assets, store.inventories),
    [store.transactions, year, opening, store.assets, store.inventories],
  );

  // 総勘定元帳のB/S勘定の期首残高(棚卸・固定資産は台帳から自動)
  const ledgerOpenings = useMemo<Record<string, number>>(
    () => ({
      cash: opening?.cash ?? 0,
      bank: opening?.bank ?? 0,
      receivable: opening?.receivable ?? 0,
      card: opening?.card ?? 0,
      payable: opening?.payable ?? 0,
      deposit: opening?.deposit ?? 0,
      inventory: inventoryAmount(store.inventories, year - 1),
      fixed_asset: store.assets
        .filter((a) => !isDeferred(a))
        .reduce((s, a) => s + bookValueAtStart(a, year), 0),
      deferred_asset: store.assets
        .filter((a) => isDeferred(a))
        .reduce((s, a) => s + bookValueAtStart(a, year), 0),
    }),
    [opening, store.inventories, store.assets, year],
  );

  const unclassified = useMemo(
    () => transactionsOfYear(store.transactions, year).filter((t) => t.account === null).length,
    [store.transactions, year],
  );

  // 期首残高が前年末の残高と食い違っていないか(前年の帳簿を後から修正すると起きる)
  const openingMismatch = useMemo(() => {
    if (!opening) return false;
    const hasPrev =
      store.openingBalances.some((ob) => ob.year === year - 1) ||
      transactionsOfYear(store.transactions, year - 1).length > 0;
    if (!hasPrev) return false;
    const prevOpening = store.openingBalances.find((ob) => ob.year === year - 1);
    const prevBs = buildBalanceSheet(
      store.transactions,
      year - 1,
      prevOpening,
      store.assets,
      store.inventories,
    );
    const carry = carryForwardOpening(prevBs);
    return (
      carry.cash !== opening.cash ||
      carry.bank !== opening.bank ||
      carry.receivable !== opening.receivable ||
      carry.card !== opening.card ||
      carry.payable !== opening.payable ||
      carry.deposit !== opening.deposit
    );
  }, [opening, store.openingBalances, store.transactions, store.assets, store.inventories, year]);

  if (!store.ready) {
    return <div className="py-24 text-center text-sm text-slate-500">読み込み中…</div>;
  }

  return (
    <>
      <PageHeader
        title="帳簿・決算書(複式簿記)"
        description="全取引から複式仕訳を自動生成し、仕訳帳・総勘定元帳・貸借対照表を作成します。青色申告特別控除55万円(e-Tax等なら65万円)の帳簿要件に対応する主要簿です。"
      />

      <div className="space-y-6">
        <div className="flex flex-wrap items-center gap-3">
          <select
            aria-label="年分を選択"
            className={selectCls}
            value={year}
            onChange={(e) => setYear(Number(e.target.value))}
          >
            {years.map((y) => (
              <option key={y} value={y}>
                {y}年分
              </option>
            ))}
          </select>
          {unclassified > 0 && (
            <span className="text-xs text-amber-700">
              ⚠ 未仕訳の取引が{unclassified}件あります(仕訳されるまで帳簿に載りません)
            </span>
          )}
        </div>

        <Alert tone="info">
          <strong>55万/65万円控除への道のり</strong>:
          ①すべての取引を仕訳・承認する ②売上は請求時に「売掛金(発生記録)」で計上し、入金行は「売掛金の回収」にする(発生主義)
          ③期首残高を登録する ④この画面の仕訳帳・総勘定元帳・貸借対照表と、ダッシュボードの科目別集計(損益計算書)を保存する
          ⑤e-Tax で申告すると65万円控除。
        </Alert>

        {message && <Alert tone="success">{message}</Alert>}

        <OpeningBalanceCard
          key={`${year}:${opening ? `${opening.cash}-${opening.bank}-${opening.receivable}-${opening.card}-${opening.payable}-${opening.deposit}` : 'none'}`}
          year={year}
          opening={opening}
          hasPrevData={
            store.openingBalances.some((ob) => ob.year === year - 1) ||
            transactionsOfYear(store.transactions, year - 1).length > 0
          }
          onCarryForward={() => {
            const prevOpening = store.openingBalances.find((ob) => ob.year === year - 1);
            const prevBs = buildBalanceSheet(
              store.transactions,
              year - 1,
              prevOpening,
              store.assets,
              store.inventories,
            );
            store.setOpeningBalance(carryForwardOpening(prevBs));
            setMessage(
              `${year - 1}年末の貸借対照表から${year}年の期首残高を設定しました(元入金 ${yen(prevBs.nextCapital)})。`,
            );
          }}
          onSave={(ob) => {
            store.setOpeningBalance(ob);
            setMessage(`${year}年の期首残高を保存しました。貸借対照表に反映されています。`);
          }}
        />

        {openingMismatch && (
          <Alert tone="warning">
            {year}年の期首残高が<strong>前年末の貸借対照表の残高と一致していません</strong>。
            前年の取引を後から修正した場合に起きます。「前年末の残高から自動設定」を押すと揃えられます
            (意図的にずらしている場合はこのままで構いません)。
          </Alert>
        )}

        <InventoryCard
          key={`inv-${year}-${inventoryAmount(store.inventories, year - 1)}-${inventoryAmount(store.inventories, year)}`}
          year={year}
          opening={inventoryAmount(store.inventories, year - 1)}
          closing={inventoryAmount(store.inventories, year)}
          onSave={(openingAmount, closingAmount) => {
            store.setInventory(year - 1, openingAmount);
            store.setInventory(year, closingAmount);
            setMessage(
              `${year}年の棚卸高を保存しました。売上原価(期首 + 仕入 − 期末)として損益・貸借対照表に反映されます。`,
            );
          }}
        />

        <BalanceSheetCard bs={bs} />

        <JournalCard
          journal={journal}
          year={year}
          onDownload={() => downloadText(`仕訳帳_${year}.csv`, journalToCsv(journal))}
        />

        <GeneralLedgerCard journal={journal} openings={ledgerOpenings} capital={bs.capital} />
      </div>
    </>
  );
}

/** 棚卸資産(商品・材料)の棚卸高カード。物販など仕入がある事業向け */
function InventoryCard({
  year,
  opening,
  closing,
  onSave,
}: {
  year: number;
  opening: number;
  closing: number;
  onSave: (opening: number, closing: number) => void;
}) {
  const [openValue, setOpenValue] = useState(String(opening));
  const [closeValue, setCloseValue] = useState(String(closing));
  const num = (s: string) => {
    const n = Number(s);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
  };
  return (
    <Card title={`棚卸資産(商品・材料の棚卸高)── 物販・製造など仕入がある事業向け`}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSave(num(openValue), num(closeValue));
        }}
        className="flex flex-wrap items-end gap-3"
      >
        <div>
          <label htmlFor="book-inventory-opening" className="mb-1 block text-xs font-medium text-slate-500">
            期首棚卸高({year}年1月1日 = 前年末)
          </label>
          <input
            id="book-inventory-opening"
            type="number"
            min={0}
            className={`${input} w-40`}
            value={openValue}
            onChange={(e) => setOpenValue(e.target.value)}
          />
        </div>
        <div>
          <label htmlFor="book-inventory-closing" className="mb-1 block text-xs font-medium text-slate-500">
            期末棚卸高({year}年12月31日)
          </label>
          <input
            id="book-inventory-closing"
            type="number"
            min={0}
            className={`${input} w-40`}
            value={closeValue}
            onChange={(e) => setCloseValue(e.target.value)}
          />
        </div>
        <button type="submit" className={btn.primary}>
          保存
        </button>
      </form>
      <p className="mt-3 text-xs leading-relaxed text-slate-500">
        年末に在庫(商品・製品・材料)を数えて原価で評価した金額を入力してください。売上原価 =
        期首棚卸高 + 仕入高 −
        期末棚卸高として損益に反映され、期末棚卸高は貸借対照表の「棚卸資産」になります。
        在庫のないサービス業は0のままで構いません。
      </p>
    </Card>
  );
}

/** 期首残高の登録カード */
function OpeningBalanceCard({
  year,
  opening,
  hasPrevData,
  onSave,
  onCarryForward,
}: {
  year: number;
  opening: OpeningBalance | undefined;
  hasPrevData: boolean;
  onSave: (ob: OpeningBalance) => void;
  onCarryForward: () => void;
}) {
  // 表示中の年が変わったら入力値を作り直す(key={year} で親から強制リセット)
  const [values, setValues] = useState<Record<string, string>>(() => {
    const v: Record<string, string> = {};
    for (const f of OB_FIELDS) v[f.key] = String(opening?.[f.key] ?? 0);
    return v;
  });

  // 前年末繰越で入った負の残高(現金の使いすぎ等)も、そのまま保存し直せるようにする
  const num = (key: string) => {
    const n = Number(values[key]);
    return Number.isFinite(n) ? Math.round(n) : 0;
  };
  const capital =
    num('cash') + num('bank') + num('receivable') - num('card') - num('payable') - num('deposit');

  return (
    <Card
      title={`期首残高(${year}年1月1日時点)`}
      action={
        hasPrevData ? (
          <button type="button" className={btn.small} onClick={onCarryForward}>
            ↩ 前年末の残高から自動設定
          </button>
        ) : undefined
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSave({
            year,
            cash: num('cash'),
            bank: num('bank'),
            receivable: num('receivable'),
            card: num('card'),
            payable: num('payable'),
            deposit: num('deposit'),
          });
        }}
        className="flex flex-wrap items-end gap-3"
      >
        {OB_FIELDS.map((f) => (
          <div key={f.key}>
            <label htmlFor={`book-opening-${f.key}`} className="mb-1 block text-xs font-medium text-slate-500" title={f.hint}>
              {f.label}
            </label>
            <input
              id={`book-opening-${f.key}`}
              type="number"
              className={`${input} w-32`}
              value={values[f.key]}
              onChange={(e) => setValues((prev) => ({ ...prev, [f.key]: e.target.value }))}
            />
          </div>
        ))}
        <div className="text-sm text-slate-600">
          <div className="text-xs font-medium text-slate-500">元入金(自動計算)</div>
          <div className="tabular mt-1 font-semibold">{yen(capital)}</div>
        </div>
        <button type="submit" className={btn.primary}>
          {opening ? '上書き保存' : '保存'}
        </button>
      </form>
      <p className="mt-3 text-xs leading-relaxed text-slate-500">
        初めて登録する年は、1月1日時点の事業用の現金・預金残高などを入力してください(元入金 =
        資産合計 −
        負債合計)。翌年以降は「前年末の残高から自動設定」で繰り越せます(翌年の元入金 = 元入金 +
        所得 + 事業主借 − 事業主貸)。
      </p>
    </Card>
  );
}

/** 貸借対照表カード(青色申告決算書の様式に合わせた期首/期末2列) */
function BalanceSheetCard({ bs }: { bs: BalanceSheet }) {
  const cell = (v: number, blank = false) =>
    blank ? <span className="text-slate-300">—</span> : yen(v);
  return (
    <Card
      title={`貸借対照表(${bs.year}年12月31日現在)`}
      action={
        <div className="flex items-center gap-2">
          {bs.balanced ? (
            <span className="rounded bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
              ✓ 貸借一致
            </span>
          ) : (
            <span className="rounded bg-rose-100 px-2 py-0.5 text-[11px] font-medium text-rose-700">
              ⚠ 貸借不一致
            </span>
          )}
          <button
            type="button"
            className={btn.small}
            onClick={() => downloadText(`貸借対照表_${bs.year}.csv`, balanceSheetToCsv(bs))}
          >
            ⬇ CSV
          </button>
        </div>
      }
    >
      <div className="grid gap-6 lg:grid-cols-2">
        <div>
          <h3 className="mb-2 text-xs font-semibold text-slate-500">資産の部</h3>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
                <th className="py-1.5 pr-2 font-medium">科目</th>
                <th className="px-2 py-1.5 text-right font-medium">期首(1/1)</th>
                <th className="px-2 py-1.5 text-right font-medium">期末(12/31)</th>
              </tr>
            </thead>
            <tbody>
              {bs.assets.map((r) => (
                <tr key={r.id} className="border-b border-slate-100">
                  <td className="py-1.5 pr-2">{r.label}</td>
                  <td className="tabular px-2 py-1.5 text-right text-slate-500">
                    {cell(r.opening, r.id === 'owner_draw')}
                  </td>
                  <td className="tabular px-2 py-1.5 text-right">{yen(r.closing)}</td>
                </tr>
              ))}
              <tr className="bg-slate-50 font-semibold">
                <td className="py-1.5 pr-2">合計</td>
                <td className="tabular px-2 py-1.5 text-right">{yen(bs.totalAssetsOpening)}</td>
                <td className="tabular px-2 py-1.5 text-right">{yen(bs.totalAssetsClosing)}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div>
          <h3 className="mb-2 text-xs font-semibold text-slate-500">負債・資本の部</h3>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
                <th className="py-1.5 pr-2 font-medium">科目</th>
                <th className="px-2 py-1.5 text-right font-medium">期首(1/1)</th>
                <th className="px-2 py-1.5 text-right font-medium">期末(12/31)</th>
              </tr>
            </thead>
            <tbody>
              {bs.liabilities.map((r) => (
                <tr key={r.id} className="border-b border-slate-100">
                  <td className="py-1.5 pr-2">{r.label}</td>
                  <td className="tabular px-2 py-1.5 text-right text-slate-500">{yen(r.opening)}</td>
                  <td className="tabular px-2 py-1.5 text-right">{yen(r.closing)}</td>
                </tr>
              ))}
              {bs.equity.map((r) => (
                <tr key={r.id} className="border-b border-slate-100">
                  <td className="py-1.5 pr-2">{r.label}</td>
                  <td className="tabular px-2 py-1.5 text-right text-slate-500">
                    {cell(r.opening, r.id !== 'capital')}
                  </td>
                  <td
                    className={`tabular px-2 py-1.5 text-right ${r.id === 'profit' ? 'font-semibold text-emerald-700' : ''}`}
                  >
                    {yen(r.closing)}
                  </td>
                </tr>
              ))}
              <tr className="bg-slate-50 font-semibold">
                <td className="py-1.5 pr-2">合計</td>
                <td className="tabular px-2 py-1.5 text-right">{yen(bs.totalLiabEquityOpening)}</td>
                <td className="tabular px-2 py-1.5 text-right">{yen(bs.totalLiabEquityClosing)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
      <p className="mt-3 text-xs leading-relaxed text-slate-500">
        「青色申告特別控除前の所得金額」はダッシュボードの差引金額と一致します。翌年の元入金は{' '}
        <strong className="text-slate-500">{yen(bs.nextCapital)}</strong>
        (元入金 + 所得 + 事業主借 − 事業主貸)です。銀行・カードの明細をすべて取り込み、
        私的な行を「対象外」にすると、期末残高が実際の口座残高と照合できます。
      </p>
    </Card>
  );
}

/** 仕訳帳カード */
function JournalCard({
  journal,
  year,
  onDownload,
}: {
  journal: ReturnType<typeof journalForYear>;
  year: number;
  onDownload: () => void;
}) {
  const [visible, setVisible] = useState(100);
  return (
    <Card
      title={`仕訳帳(${year}年・${journal.length}仕訳)`}
      action={
        <button type="button" className={btn.small} onClick={onDownload} disabled={journal.length === 0}>
          ⬇ CSV
        </button>
      }
    >
      {journal.length === 0 ? (
        <EmptyState>仕訳がありません。取引を取り込み、勘定科目を割り当ててください。</EmptyState>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
                  <th className="py-2 pr-2 font-medium">日付</th>
                  <th className="px-2 py-2 font-medium">借方</th>
                  <th className="px-2 py-2 text-right font-medium">金額</th>
                  <th className="px-2 py-2 font-medium">貸方</th>
                  <th className="px-2 py-2 text-right font-medium">金額</th>
                  <th className="px-2 py-2 font-medium">摘要</th>
                </tr>
              </thead>
              <tbody>
                {journal.slice(0, visible).map((e) => (
                  <tr key={e.txId} className="border-b border-slate-100 align-top">
                    <td className="tabular py-1.5 pr-2 whitespace-nowrap">{dateLabel(e.date)}</td>
                    <td className="px-2 py-1.5">
                      {e.debits.map((l, i) => (
                        <div key={i}>{ledgerLineLabel(l.account)}</div>
                      ))}
                    </td>
                    <td className="tabular px-2 py-1.5 text-right whitespace-nowrap">
                      {e.debits.map((l, i) => (
                        <div key={i}>{yen(l.amount)}</div>
                      ))}
                    </td>
                    <td className="px-2 py-1.5">
                      {e.credits.map((l, i) => (
                        <div key={i}>{ledgerLineLabel(l.account)}</div>
                      ))}
                    </td>
                    <td className="tabular px-2 py-1.5 text-right whitespace-nowrap">
                      {e.credits.map((l, i) => (
                        <div key={i}>{yen(l.amount)}</div>
                      ))}
                    </td>
                    <td className="max-w-[220px] truncate px-2 py-1.5 text-slate-500" title={e.description}>
                      {e.description}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {journal.length > visible && (
            <div className="mt-3 text-center">
              <button type="button" className={btn.secondary} onClick={() => setVisible((v) => v + 200)}>
                さらに表示({journal.length - visible}件)
              </button>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

/** 総勘定元帳カード */
function GeneralLedgerCard({
  journal,
  openings,
  capital,
}: {
  journal: ReturnType<typeof journalForYear>;
  /** B/S勘定の期首残高(損益科目・事業主貸借は期首0) */
  openings: Record<string, number>;
  capital: number;
}) {
  const [account, setAccount] = useState('bank');
  const options = useMemo(() => ledgerAccountOptions(journal), [journal]);

  const openingBalance = openings[account] ?? 0;

  const rows = useMemo(
    () => generalLedger(journal, account, openingBalance),
    [journal, account, openingBalance],
  );

  return (
    <Card
      title="総勘定元帳"
      action={
        <select aria-label="勘定科目を選択" className={selectCls} value={account} onChange={(e) => setAccount(e.target.value)}>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      }
    >
      {rows.length === 0 ? (
        <EmptyState>
          「{ledgerLineLabel(account)}」の記帳はこの年にありません。
          {openingBalance > 0 && ` 期首残高: ${yen(openingBalance)}`}
        </EmptyState>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
                <th className="py-2 pr-2 font-medium">日付</th>
                <th className="px-2 py-2 font-medium">摘要</th>
                <th className="px-2 py-2 font-medium">相手勘定</th>
                <th className="px-2 py-2 text-right font-medium">借方</th>
                <th className="px-2 py-2 text-right font-medium">貸方</th>
                <th className="px-2 py-2 text-right font-medium">残高</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-slate-100 bg-slate-50/60 text-slate-500">
                <td className="py-1.5 pr-2">期首</td>
                <td className="px-2 py-1.5">繰越残高</td>
                <td className="px-2 py-1.5">—</td>
                <td className="px-2 py-1.5" />
                <td className="px-2 py-1.5" />
                <td className="tabular px-2 py-1.5 text-right">{yen(openingBalance)}</td>
              </tr>
              {rows.map((r, i) => (
                <tr key={i} className="border-b border-slate-100">
                  <td className="tabular py-1.5 pr-2 whitespace-nowrap">{dateLabel(r.date)}</td>
                  <td className="max-w-[240px] truncate px-2 py-1.5" title={r.description}>
                    {r.description}
                  </td>
                  <td className="px-2 py-1.5 text-slate-500">{r.counter}</td>
                  <td className="tabular px-2 py-1.5 text-right">
                    {r.debit > 0 ? yen(r.debit) : ''}
                  </td>
                  <td className="tabular px-2 py-1.5 text-right">
                    {r.credit > 0 ? yen(r.credit) : ''}
                  </td>
                  <td className="tabular px-2 py-1.5 text-right font-medium">{yen(r.balance)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-3 text-xs text-slate-500">
        ※元入金({yen(capital)})は期首の 資産 − 負債 として自動計算され、元帳には登場しません。
      </p>
    </Card>
  );
}
