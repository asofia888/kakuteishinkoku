'use client';

import React, { useMemo, useState } from 'react';
import { Alert, btn, Card, EmptyState, input, PageHeader, selectCls } from '@/components/ui';
import { repaymentInterest } from '@/lib/accounts';
import { availableYears, transactionsOfYear } from '@/lib/aggregate';
import { bookValueAtStart, isDeferred } from '@/lib/assets';
import { downloadText } from '@/lib/csv';
import { dateLabel, today, yen } from '@/lib/format';
import {
  bookBalanceAt,
  hasMultiple,
  lineLabel,
  lineMatcher,
  negativeBalances,
  reconTargets,
  resolveReconTarget,
  SUB_FUND_LABELS,
  SubFund,
  subAccountsOf,
  subClosingBalances,
  subOpening,
} from '@/lib/fundAccounts';
import {
  BalanceSheet,
  balanceSheetToCsv,
  buildBalanceSheet,
  carryForwardOpening,
  generalLedger,
  inventoryAmount,
  journalForYear,
  journalToCsv,
  JournalLine,
  ledgerAccountOptions,
  ledgerLineLabel,
} from '@/lib/ledger';
import { useStore } from '@/lib/store';
import { FundAccount, OpeningBalance, Reconciliation } from '@/lib/types';

type ObKey = Exclude<keyof OpeningBalance, 'year' | 'subBalances'>;

/** 期首残高の入力フィールド定義 */
const OB_FIELDS: { key: ObKey; label: string; hint: string }[] = [
  { key: 'cash', label: '現金', hint: '事業用の手元現金' },
  { key: 'bank', label: '普通預金', hint: '事業用口座の1/1残高' },
  { key: 'receivable', label: '売掛金', hint: '前年に計上し未回収の請求' },
  { key: 'card', label: 'カード未払金', hint: '前年利用・未引落しの額' },
  { key: 'payable', label: '買掛金・未払金', hint: 'その他の未払い' },
  { key: 'loan', label: '借入金', hint: '1/1時点の事業用借入の残高(返済予定表の元金残高)' },
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
      loan: opening?.loan ?? 0,
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

  /** 前年末の貸借対照表から作る期首残高(口座を分けていれば口座別の残高も繰り越す) */
  const carryFromPrevYear = () => {
    const prevOpening = store.openingBalances.find((ob) => ob.year === year - 1);
    const prevBs = buildBalanceSheet(
      store.transactions,
      year - 1,
      prevOpening,
      store.assets,
      store.inventories,
    );
    const subs = subClosingBalances(store.transactions, year - 1, prevOpening, store.fundAccounts);
    const carry: OpeningBalance = {
      ...carryForwardOpening(prevBs),
      ...(Object.keys(subs).length > 0 ? { subBalances: subs } : {}),
    };
    return { carry, prevBs };
  };

  // 期首残高が前年末の残高と食い違っていないか(前年の帳簿を後から修正すると起きる)
  const openingMismatch = useMemo(() => {
    if (!opening) return false;
    const hasPrev =
      store.openingBalances.some((ob) => ob.year === year - 1) ||
      transactionsOfYear(store.transactions, year - 1).length > 0;
    if (!hasPrev) return false;
    const { carry } = carryFromPrevYear();
    const subMismatch = Object.entries(carry.subBalances ?? {}).some(([id, v]) => {
      const a = store.fundAccounts.find((x) => x.id === id);
      return a !== undefined && subOpening(opening, store.fundAccounts, a.fund, id) !== v;
    });
    return subMismatch || OB_FIELDS.some((f) => carry[f.key] !== opening[f.key]);
    // carryFromPrevYear は下記の依存から決まる
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opening, store.openingBalances, store.transactions, store.assets, store.inventories, store.fundAccounts, year]);

  // 借入金: 期末残高がマイナス(期首残高の登録漏れ・利息を含めた全額を元金にしている等)と、
  // 利息の内訳が未入力の返済(利息は利子割引料として経費になる)
  const loanClosing = bs.liabilities.find((r) => r.id === 'loan')?.closing ?? 0;
  // 現金・預金の日末残高のマイナス(記帳漏れの典型)
  const negatives = useMemo(
    () => negativeBalances(store.transactions, year, opening, store.fundAccounts),
    [store.transactions, year, opening, store.fundAccounts],
  );
  const repaymentsWithoutInterest = useMemo(
    () =>
      transactionsOfYear(store.transactions, year).filter(
        (t) => t.account === 'loan_repayment' && repaymentInterest(t) === 0,
      ).length,
    [store.transactions, year],
  );

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

        <YearLockCard
          year={year}
          locked={store.lockedYears.includes(year)}
          onChange={(locked) => {
            store.setYearLocked(year, locked);
            setMessage(
              locked
                ? `${year}年分を申告済みとしてロックしました。この年の帳簿の数字が変わる変更は保存されません。`
                : `${year}年分のロックを解除しました。修正が終わったら再びロックしてください。`,
            );
          }}
        />

        <FundAccountsCard />

        <OpeningBalanceCard
          key={`${year}:${opening ? `${OB_FIELDS.map((f) => opening[f.key]).join('-')}:${JSON.stringify(opening.subBalances ?? {})}` : 'none'}:${store.fundAccounts.map((a) => a.id).join(',')}`}
          year={year}
          opening={opening}
          fundAccounts={store.fundAccounts}
          hasPrevData={
            store.openingBalances.some((ob) => ob.year === year - 1) ||
            transactionsOfYear(store.transactions, year - 1).length > 0
          }
          onCarryForward={() => {
            const { carry, prevBs } = carryFromPrevYear();
            store.setOpeningBalance(carry);
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

        {negatives.length > 0 && (
          <Alert tone="warning">
            {negatives.map((n) => (
              <div key={n.target}>
                <strong>{n.label}</strong>の残高が{dateLabel(n.firstDate)}にマイナスになっています(最低
                {yen(n.lowest)}・{dateLabel(n.lowestDate)})。
              </div>
            ))}
            <div className="mt-1 text-xs">
              現金・預金の残高がマイナスになることはないため、記帳漏れの可能性が高いです(私費で立て替えた経費の
              「事業主借」の計上漏れ、現金売上・預け入れの漏れ、日付の誤りなど)。期首残高の登録漏れでも起きます。
              税務調査でも真っ先に確認される点です。
            </div>
          </Alert>
        )}

        {loanClosing < 0 && (
          <Alert tone="warning">
            {year}年末の<strong>借入金の残高がマイナス({yen(loanClosing)})</strong>です。
            期首残高の「借入金」が未登録か、返済の<strong>利息を元金として</strong>処理している可能性があります
            (取引一覧で返済行の「うち利息」を入力すると、利息は利子割引料として経費になります)。
          </Alert>
        )}

        {repaymentsWithoutInterest > 0 && (
          <Alert tone="info">
            利息の内訳が未入力の「借入金の返済」が{repaymentsWithoutInterest}件あります。
            返済予定表(償還予定表)を見て、取引一覧の各返済行に<strong>うち利息</strong>を入力してください。
            利息は利子割引料として必要経費になります(無利子の融資なら入力は不要です)。
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

        <ReconciliationCard key={year} year={year} />

        <JournalCard
          journal={journal}
          year={year}
          label={(l) => lineLabel(l, store.fundAccounts)}
          onDownload={() =>
            downloadText(
              `仕訳帳_${year}.csv`,
              journalToCsv(journal, (l) => lineLabel(l, store.fundAccounts)),
            )
          }
        />

        <GeneralLedgerCard
          journal={journal}
          openings={ledgerOpenings}
          opening={opening}
          fundAccounts={store.fundAccounts}
          capital={bs.capital}
        />
      </div>
    </>
  );
}

/**
 * 申告済みロックのカード。申告後に取引の修正・按分の変更などで
 * 申告した年の帳簿が静かに書き換わるのを防ぐ(修正申告のときだけ解除する)。
 */
function YearLockCard({
  year,
  locked,
  onChange,
}: {
  year: number;
  locked: boolean;
  onChange: (locked: boolean) => void;
}) {
  return locked ? (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900">
      <span className="font-medium">🔒 {year}年分は申告済み(ロック中)です。</span>
      <span className="text-xs text-sky-800">
        取引・固定資産・棚卸・期首残高・按分設定の変更で、この年の帳簿の数字が変わるものは保存されません
        (承認や証憑の添付はできます)。
      </span>
      <button
        type="button"
        className={`${btn.small} ml-auto`}
        onClick={() => {
          if (
            confirm(
              `${year}年分のロックを解除しますか?\n修正申告・更正の請求などで帳簿を直す場合だけ解除し、終わったら再びロックしてください。`,
            )
          ) {
            onChange(false);
          }
        }}
      >
        ロックを解除
      </button>
    </div>
  ) : (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600">
      <span>
        {year}年分の申告が済んだら、帳簿を<strong>申告済みとしてロック</strong>
        できます。以後、この年の数字が変わる変更(取引の修正・按分割合の変更など)は保存されなくなります。
      </span>
      <button
        type="button"
        className={`${btn.small} ml-auto`}
        onClick={() => {
          if (
            confirm(
              `${year}年分を申告済みとしてロックしますか?\nこの年の帳簿の数字が変わる変更は保存されなくなります(解除はいつでもできます)。`,
            )
          ) {
            onChange(true);
          }
        }}
      >
        🔒 {year}年分を申告済みにする
      </button>
    </div>
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
  fundAccounts,
  hasPrevData,
  onSave,
  onCarryForward,
}: {
  year: number;
  opening: OpeningBalance | undefined;
  fundAccounts: FundAccount[];
  hasPrevData: boolean;
  onSave: (ob: OpeningBalance) => void;
  onCarryForward: () => void;
}) {
  // 口座を2つ以上に分けている資金(普通預金・カード)は、口座ごとの入力欄に置き換える
  const splitFunds = (['bank', 'card'] as SubFund[]).filter((f) => hasMultiple(fundAccounts, f));
  const fields: { key: string; label: string; hint: string }[] = OB_FIELDS.flatMap((f) =>
    (splitFunds as string[]).includes(f.key)
      ? subAccountsOf(fundAccounts, f.key as SubFund).map((a) => ({
          key: `sub:${a.id}`,
          label: `${f.label}(${a.name})`,
          hint: f.hint,
        }))
      : [f],
  );

  // 表示中の年が変わったら入力値を作り直す(key で親から強制リセット)
  const [values, setValues] = useState<Record<string, string>>(() => {
    const v: Record<string, string> = {};
    for (const f of OB_FIELDS) v[f.key] = String(opening?.[f.key] ?? 0);
    for (const fund of splitFunds) {
      for (const a of subAccountsOf(fundAccounts, fund)) {
        v[`sub:${a.id}`] = String(subOpening(opening, fundAccounts, fund, a.id));
      }
    }
    return v;
  });

  // 前年末繰越で入った負の残高(現金の使いすぎ等)も、そのまま保存し直せるようにする
  const num = (key: string) => {
    const n = Number(values[key]);
    return Number.isFinite(n) ? Math.round(n) : 0;
  };
  /** 資金の合計(口座を分けている資金は口座の合計) */
  const total = (fund: ObKey) =>
    (splitFunds as string[]).includes(fund)
      ? subAccountsOf(fundAccounts, fund as SubFund).reduce((s, a) => s + num(`sub:${a.id}`), 0)
      : num(fund);
  const capital =
    total('cash') +
    total('bank') +
    total('receivable') -
    total('card') -
    total('payable') -
    total('loan') -
    total('deposit');

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
          const subBalances: Record<string, number> = {};
          for (const fund of splitFunds) {
            for (const a of subAccountsOf(fundAccounts, fund)) subBalances[a.id] = num(`sub:${a.id}`);
          }
          onSave({
            year,
            cash: total('cash'),
            bank: total('bank'),
            receivable: total('receivable'),
            card: total('card'),
            payable: total('payable'),
            loan: total('loan'),
            deposit: total('deposit'),
            ...(splitFunds.length > 0 ? { subBalances } : {}),
          });
        }}
        className="flex flex-wrap items-end gap-3"
      >
        {fields.map((f) => (
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
  label,
  onDownload,
}: {
  journal: ReturnType<typeof journalForYear>;
  year: number;
  /** 勘定の表示名(口座を分けていれば「普通預金(楽天銀行)」) */
  label: (l: JournalLine) => string;
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
                        <div key={i}>{label(l)}</div>
                      ))}
                    </td>
                    <td className="tabular px-2 py-1.5 text-right whitespace-nowrap">
                      {e.debits.map((l, i) => (
                        <div key={i}>{yen(l.amount)}</div>
                      ))}
                    </td>
                    <td className="px-2 py-1.5">
                      {e.credits.map((l, i) => (
                        <div key={i}>{label(l)}</div>
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
  opening,
  fundAccounts,
  capital,
}: {
  journal: ReturnType<typeof journalForYear>;
  /** B/S勘定の期首残高(損益科目・事業主貸借は期首0) */
  openings: Record<string, number>;
  /** その年の期首残高(口座別の期首残高の算出用) */
  opening: OpeningBalance | undefined;
  fundAccounts: FundAccount[];
  capital: number;
}) {
  // 選択値は勘定ID、または口座ごとの補助元帳 `sub:<口座ID>`
  const [account, setAccount] = useState('bank');
  const options = useMemo(() => {
    const base = ledgerAccountOptions(journal);
    // 口座を分けている資金は、合計の直後に口座ごとの補助元帳を並べる
    return base.flatMap((o) =>
      hasMultiple(fundAccounts, o.id)
        ? [
            o,
            ...subAccountsOf(fundAccounts, o.id as SubFund).map((a) => ({
              id: `sub:${a.id}`,
              label: `└ ${o.label}(${a.name})`,
            })),
          ]
        : [o],
    );
  }, [journal, fundAccounts]);

  const subAccount = account.startsWith('sub:')
    ? fundAccounts.find((a) => a.id === account.slice(4))
    : undefined;
  const ledgerAccount = subAccount ? subAccount.fund : account.startsWith('sub:') ? 'bank' : account;
  const openingBalance = subAccount
    ? subOpening(opening, fundAccounts, subAccount.fund, subAccount.id)
    : (openings[ledgerAccount] ?? 0);

  const rows = useMemo(
    () =>
      generalLedger(
        journal,
        ledgerAccount,
        openingBalance,
        subAccount ? lineMatcher(fundAccounts, subAccount.fund, subAccount.id) : undefined,
      ),
    [journal, ledgerAccount, openingBalance, subAccount, fundAccounts],
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
          「{subAccount ? `${ledgerLineLabel(subAccount.fund)}(${subAccount.name})` : ledgerLineLabel(ledgerAccount)}」の記帳はこの年にありません。
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

/**
 * 口座・カード(補助科目)の登録。普通預金・カードを口座ごとに分けると、
 * 取引一覧で口座を選べるようになり、口座ごとの元帳・期首残高・残高照合ができる
 */
function FundAccountsCard() {
  const store = useStore();
  const [fund, setFund] = useState<SubFund>('bank');
  const [name, setName] = useState('');
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);

  return (
    <Card title="口座・クレジットカード(補助科目)">
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) return;
          store.addFundAccount(fund, name);
          setName('');
        }}
      >
        <div>
          <label htmlFor="fa-fund" className="mb-1 block text-xs font-medium text-slate-500">
            種類
          </label>
          <select
            id="fa-fund"
            className={selectCls}
            value={fund}
            onChange={(e) => setFund(e.target.value as SubFund)}
          >
            <option value="bank">普通預金(銀行口座)</option>
            <option value="card">クレジットカード</option>
          </select>
        </div>
        <div>
          <label htmlFor="fa-name" className="mb-1 block text-xs font-medium text-slate-500">
            名前
          </label>
          <input
            id="fa-name"
            type="text"
            maxLength={30}
            className={`${input} w-56`}
            placeholder={fund === 'bank' ? '例: 楽天銀行' : '例: 三井住友カード'}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <button type="submit" className={btn.secondary} disabled={!name.trim()}>
          ＋ 追加
        </button>
      </form>

      {store.fundAccounts.length > 0 && (
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          {(['bank', 'card'] as SubFund[]).map((f) => {
            const subs = subAccountsOf(store.fundAccounts, f);
            if (subs.length === 0) return null;
            return (
              <div key={f}>
                <h3 className="mb-1 text-xs font-semibold text-slate-500">{SUB_FUND_LABELS[f]}</h3>
                <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
                  {subs.map((a, i) => (
                    <li key={a.id} className="flex items-center gap-2 px-3 py-1.5 text-sm">
                      {editing?.id === a.id ? (
                        <input
                          aria-label={`${a.name} の新しい名前`}
                          className={`${input} w-40 py-1`}
                          value={editing.name}
                          maxLength={30}
                          autoFocus
                          onChange={(e) => setEditing({ id: a.id, name: e.target.value })}
                          onBlur={() => {
                            store.renameFundAccount(a.id, editing.name);
                            setEditing(null);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') e.currentTarget.blur();
                          }}
                        />
                      ) : (
                        <span className="font-medium">{a.name}</span>
                      )}
                      {i === 0 && (
                        <span
                          className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500"
                          title="口座の指定がない取引は、この口座として扱われます"
                        >
                          既定
                        </span>
                      )}
                      <span className="ml-auto flex gap-1">
                        <button type="button" className={btn.small} onClick={() => setEditing({ id: a.id, name: a.name })}>
                          名前を変更
                        </button>
                        <button
                          type="button"
                          className={btn.danger}
                          onClick={() => {
                            if (
                              confirm(
                                `「${a.name}」を削除しますか?\nこの口座を指定していた取引は、既定の口座として扱われます(取引は消えません)。`,
                              )
                            ) {
                              store.deleteFundAccount(a.id);
                            }
                          }}
                        >
                          削除
                        </button>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      )}
      <p className="mt-3 text-xs leading-relaxed text-slate-500">
        事業用の口座やカードが複数あるときに登録します。2つ以上登録すると、取引一覧・CSV取込で口座を選べるようになり、
        口座ごとの元帳(補助元帳)・期首残高・残高照合ができます。貸借対照表は合計で表示されます。
        最初に登録した口座が<strong>既定</strong>になり、口座を指定していない取引(登録前の取引を含む)はこの口座として扱われます。
      </p>
    </Card>
  );
}

/**
 * 残高照合。通帳・カード明細の残高を入力して帳簿残高と突き合わせ、記録を残す。
 * 後から取引を直して食い違いが生じると、記録の行が「差額あり」に変わる
 */
function ReconciliationCard({ year }: { year: number }) {
  const store = useStore();
  const targets = reconTargets(store.fundAccounts);
  const [target, setTarget] = useState(targets[1]?.id ?? 'cash');
  const [date, setDate] = useState(() => (today().startsWith(`${year}-`) ? today() : `${year}-12-31`));
  const [balance, setBalance] = useState('');

  const records = store.reconciliations
    .filter((r) => r.date.startsWith(`${year}-`))
    .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt);

  const preview =
    /^\d{4}-\d{2}-\d{2}$/.test(date) && date.startsWith(`${year}-`)
      ? bookBalanceAt(store.transactions, store.openingBalances, store.fundAccounts, target, date)
      : null;

  const rowOf = (r: Reconciliation) => {
    const t = resolveReconTarget(store.fundAccounts, r.target);
    const book = bookBalanceAt(store.transactions, store.openingBalances, store.fundAccounts, r.target, r.date);
    return { label: t?.label ?? '(削除された口座)', book: book?.balance ?? null, diff: book ? r.balance - book.balance : null };
  };
  const mismatches = records.map(rowOf).filter((x) => x.diff !== null && x.diff !== 0).length;

  return (
    <Card title={`残高照合(${year}年)`}>
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          const n = Math.round(Number(balance));
          if (!Number.isFinite(n) || balance.trim() === '' || !preview) return;
          store.addReconciliation({ target, date, balance: n });
          setBalance('');
        }}
      >
        <div>
          <label htmlFor="rc-target" className="mb-1 block text-xs font-medium text-slate-500">
            口座・カード
          </label>
          <select id="rc-target" className={selectCls} value={target} onChange={(e) => setTarget(e.target.value)}>
            {targets.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="rc-date" className="mb-1 block text-xs font-medium text-slate-500">
            照合日
          </label>
          <input
            id="rc-date"
            type="date"
            className={input}
            min={`${year}-01-01`}
            max={`${year}-12-31`}
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </div>
        <div>
          <label htmlFor="rc-balance" className="mb-1 block text-xs font-medium text-slate-500">
            {resolveReconTarget(store.fundAccounts, target)?.fund === 'card' ? '明細の未払残高' : '通帳・実際の残高'}
          </label>
          <input
            id="rc-balance"
            type="number"
            className={`${input} w-36 text-right`}
            value={balance}
            onChange={(e) => setBalance(e.target.value)}
          />
        </div>
        <div className="text-sm">
          <div className="text-xs font-medium text-slate-500">帳簿残高(照合日の終わり)</div>
          <div className="tabular mt-1 font-semibold">{preview ? yen(preview.balance) : '—'}</div>
        </div>
        <button type="submit" className={btn.primary} disabled={!preview || balance.trim() === ''}>
          照合して記録
        </button>
      </form>
      {preview && !preview.hasOpening && (
        <p className="mt-2 text-xs text-amber-700">
          ※{year}年の期首残高が未登録のため、帳簿残高は1/1を0円として計算しています。
        </p>
      )}

      {mismatches > 0 && (
        <div className="mt-3">
          <Alert tone="warning">
            差額のある照合が{mismatches}件あります。差額は記帳漏れ・二重計上・日付の誤りの手がかりです
            (照合日までの取引を明細と見比べてください)。
          </Alert>
        </div>
      )}

      {records.length > 0 && (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
                <th className="py-2 pr-2 font-medium">照合日</th>
                <th className="px-2 py-2 font-medium">口座・カード</th>
                <th className="px-2 py-2 text-right font-medium">明細の残高</th>
                <th className="px-2 py-2 text-right font-medium">帳簿残高</th>
                <th className="px-2 py-2 font-medium">結果</th>
                <th className="px-2 py-2" />
              </tr>
            </thead>
            <tbody>
              {records.map((r) => {
                const x = rowOf(r);
                return (
                  <tr key={r.id} className="border-b border-slate-100">
                    <td className="tabular py-1.5 pr-2 whitespace-nowrap">{dateLabel(r.date)}</td>
                    <td className="px-2 py-1.5">{x.label}</td>
                    <td className="tabular px-2 py-1.5 text-right">{yen(r.balance)}</td>
                    <td className="tabular px-2 py-1.5 text-right">{x.book !== null ? yen(x.book) : '—'}</td>
                    <td className="px-2 py-1.5">
                      {x.diff === null ? (
                        <span className="text-xs text-slate-500">—</span>
                      ) : x.diff === 0 ? (
                        <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[11px] font-medium text-emerald-700">✓ 一致</span>
                      ) : (
                        <span className="rounded bg-rose-100 px-1.5 py-0.5 text-[11px] font-medium text-rose-700">
                          ⚠ 差額 {yen(x.diff)}
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      <button type="button" className={btn.danger} onClick={() => store.deleteReconciliation(r.id)}>
                        削除
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-3 text-xs leading-relaxed text-slate-500">
        月末などに通帳・カード明細の残高と帳簿残高を突き合わせ、一致を確認した記録を残します(記帳漏れ・二重計上の発見に有効)。
        記録後に取引を直して帳簿残高が変わると、その記録は「差額」に変わって知らせます。
        差額 = 明細の残高 − 帳簿残高。現金・預金ならプラスは入金、マイナスは出金の記帳漏れ、
        カードならプラスは利用(購入)、マイナスは引落しの記帳漏れの可能性があります。
      </p>
    </Card>
  );
}
