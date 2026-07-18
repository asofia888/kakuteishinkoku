'use client';

import Link from 'next/link';
import React, { useMemo, useState } from 'react';
import { EtaxCard } from '@/components/EtaxCard';
import { FilingSheets } from '@/components/FilingSheets';
import { Alert, btn, Card, PageHeader, selectCls } from '@/components/ui';
import { availableYears, summarizeYear, transactionsOfYear } from '@/lib/aggregate';
import { yearDepreciationTotals } from '@/lib/assets';
import { simulateIncomeTax } from '@/lib/incometax';
import { kessanshoExpenseValues } from '@/lib/kessansho';
import { buildBalanceSheet } from '@/lib/ledger';
import { useStore } from '@/lib/store';
import { emptyDeduction } from '@/lib/types';

/** 転記用の1行(様式の欄名 → 帳簿の金額) */
function Row({ label, value, note, strong }: { label: string; value: number | null; note?: string; strong?: boolean }) {
  return (
    <tr className={`border-b border-slate-100 ${strong ? 'bg-slate-50 font-semibold' : ''}`}>
      <td className="py-1.5 pr-2">{label}</td>
      <td className="tabular px-2 py-1.5 text-right whitespace-nowrap">
        {value === null ? <span className="text-slate-300">—</span> : value.toLocaleString()}
      </td>
      <td className="py-1.5 pl-2 text-xs text-slate-500">{note ?? ''}</td>
    </tr>
  );
}

function SectionTable({ children }: { children: React.ReactNode }) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
          <th className="py-1.5 pr-2 font-medium">様式の欄</th>
          <th className="px-2 py-1.5 text-right font-medium">転記する金額</th>
          <th className="py-1.5 pl-2 font-medium">メモ</th>
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  );
}

export default function FilingPage() {
  const store = useStore();
  const [year, setYear] = useState(() => new Date().getFullYear());
  const [showSheets, setShowSheets] = useState(false);

  const years = useMemo(
    () => availableYears(store.transactions, new Date().getFullYear()),
    [store.transactions],
  );

  const summary = useMemo(
    () => summarizeYear(store.transactions, year, store.assets, store.inventories),
    [store.transactions, year, store.assets, store.inventories],
  );
  const opening = store.openingBalances.find((ob) => ob.year === year);
  const bs = useMemo(
    () => buildBalanceSheet(store.transactions, year, opening, store.assets, store.inventories),
    [store.transactions, year, opening, store.assets, store.inventories],
  );
  const deduction = store.deductions.find((d) => d.year === year) ?? emptyDeduction(year);
  const tax = useMemo(() => simulateIncomeTax(summary.profit, deduction), [summary.profit, deduction]);
  const dep = useMemo(() => yearDepreciationTotals(store.assets, year), [store.assets, year]);

  // 月別の売上と仕入(決算書2ページ)
  const monthlyPurchases = useMemo(() => {
    const arr = Array.from({ length: 12 }, () => 0);
    for (const t of transactionsOfYear(store.transactions, year)) {
      if (t.type === 'expense' && t.account === 'purchases') {
        const m = Number(t.date.slice(5, 7)) - 1;
        if (m >= 0 && m < 12) arr[m] += t.businessAmount;
      }
    }
    return arr;
  }, [store.transactions, year]);

  const expLine = (account: string) =>
    summary.expenseLines.find((l) => l.account === account)?.business ?? null;

  // 決算書の経費欄(固定欄⑧〜㉛と空欄科目)を共通定義表から組み立てる
  const expenseValues = useMemo(() => kessanshoExpenseValues(summary.expenseLines), [summary]);

  const purchases = expLine('purchases') ?? 0;
  const costOfSales = summary.inventoryOpening + purchases - summary.inventoryClosing;
  const grossProfit = summary.totalSales - costOfSales;
  const expensesTotal = summary.expenseLines
    .filter((l) => l.account !== 'purchases')
    .reduce((s, l) => s + l.business, 0);

  const unclassified = summary.unclassifiedCount + summary.unapprovedCount;

  if (!store.ready) {
    return <div className="py-24 text-center text-sm text-slate-500">読み込み中…</div>;
  }

  return (
    <>
      <PageHeader
        title="申告書 転記ガイド"
        description="国税庁「確定申告書等作成コーナー」や青色申告決算書の様式に、帳簿のどの数字を入れるかを様式の順番に並べたページです。上から順に転記してください。"
      />
      <div className="space-y-6">
        <div className="flex flex-wrap items-center gap-3">
          <select aria-label="対象年度" className={selectCls} value={year} onChange={(e) => setYear(Number(e.target.value))}>
            {years.map((y) => (
              <option key={y} value={y}>
                {y}年分
              </option>
            ))}
          </select>
          <button type="button" className={btn.secondary} onClick={() => setShowSheets((v) => !v)}>
            🖨 様式イメージ(A4・3枚)
          </button>
          {unclassified > 0 && (
            <span className="text-xs text-amber-700">
              ⚠ 未仕訳・未承認が{unclassified}件あります。転記前に取引一覧で整理してください
            </span>
          )}
        </div>

        {showSheets && (
          <Card
            title="様式イメージ ── 印刷・PDF保存して転記の下書き・控えに"
            action={
              <div className="flex gap-2">
                <button type="button" className={btn.primary} onClick={() => window.print()}>
                  🖨 印刷 / PDF保存
                </button>
                <button type="button" className={btn.secondary} onClick={() => setShowSheets(false)}>
                  閉じる
                </button>
              </div>
            }
          >
            <p className="mb-3 text-xs leading-relaxed text-slate-500">
              国税庁の提出用様式(OCR用紙)そのものではありません。作成コーナー入力時の検算・
              手書き転記の下書き・帳簿の控えとしてご利用ください。丸数字は年分の様式で多少ずれることがあります。
              印刷すると損益計算書・貸借対照表・申告書第一表が1枚ずつ(計3枚)出力されます。
            </p>
            <FilingSheets
              year={year}
              issuer={store.issuer}
              summary={summary}
              purchases={purchases}
              costOfSales={costOfSales}
              grossProfit={grossProfit}
              expensesTotal={expensesTotal}
              expenses={expenseValues}
              bs={bs}
              tax={tax}
              deduction={deduction}
            />
          </Card>
        )}

        <Alert tone="info">
          欄の丸数字は年分の様式で多少ずれることがあるため、<strong>科目名で照合</strong>してください。
          所得控除は
          <Link href="/simulation" className="mx-1 font-medium text-blue-700 underline">
            所得税シミュレーション
          </Link>
          で入力した{year}年分の内容を反映しています。
        </Alert>

        <Card title="青色申告決算書 1ページ目 ── 損益計算書">
          <SectionTable>
            <Row label="① 売上(収入)金額" value={summary.totalSales} note="雑収入を含む年間売上" />
            <Row label="② 期首商品棚卸高" value={summary.inventoryOpening || null} />
            <Row label="③ 仕入金額" value={purchases || null} />
            <Row label="⑤ 期末商品棚卸高" value={summary.inventoryClosing || null} />
            <Row label="⑥ 差引原価" value={costOfSales || null} note="② + ③ − ⑤" />
            <Row label="⑦ 差引金額(①−⑥)" value={grossProfit} strong />
            {expenseValues.fixed
              .filter((e) => e.no !== '㉛')
              .map((e) => (
                <Row key={e.no} label={`${e.no} ${e.label}`} value={e.amount} />
              ))}
            {expenseValues.extras.map((e) => (
              <Row key={e.label} label={`${e.label}(㉕〜㉚の空欄科目に記入)`} value={e.amount} />
            ))}
            {expenseValues.fixed
              .filter((e) => e.no === '㉛')
              .map((e) => (
                <Row key={e.no} label={`${e.no} ${e.label}`} value={e.amount} />
              ))}
            <Row label="経費 計" value={expensesTotal} strong note="⑧〜㉛の合計" />
            <Row label="差引金額(⑦ − 経費計)" value={summary.profit} strong />
            <Row
              label="青色申告特別控除前の所得金額"
              value={summary.profit}
              note="ダッシュボードの差引金額・貸借対照表と一致"
            />
            <Row
              label="青色申告特別控除額"
              value={tax.blueApplied}
              note={`シミュレーションの選択: ${deduction.blueDeduction.toLocaleString()}円(所得が上限)`}
            />
            <Row label="所得金額" value={tax.totalIncome} strong />
          </SectionTable>
        </Card>

        <Card title="青色申告決算書 2ページ目 ── 月別売上(収入)金額及び仕入金額">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
                  <th className="py-1.5 pr-2 font-medium">月</th>
                  {summary.monthlySales.map((_, i) => (
                    <th key={i} className="tabular px-2 py-1.5 text-right font-medium">
                      {i + 1}月
                    </th>
                  ))}
                  <th className="tabular px-2 py-1.5 text-right font-semibold">計</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-b border-slate-100">
                  <td className="py-1.5 pr-2 text-xs text-slate-500">売上金額</td>
                  {summary.monthlySales.map((v, i) => (
                    <td key={i} className="tabular px-2 py-1.5 text-right">
                      {v === 0 ? '—' : v.toLocaleString()}
                    </td>
                  ))}
                  <td className="tabular px-2 py-1.5 text-right font-semibold">
                    {summary.totalSales.toLocaleString()}
                  </td>
                </tr>
                <tr>
                  <td className="py-1.5 pr-2 text-xs text-slate-500">仕入金額</td>
                  {monthlyPurchases.map((v, i) => (
                    <td key={i} className="tabular px-2 py-1.5 text-right">
                      {v === 0 ? '—' : v.toLocaleString()}
                    </td>
                  ))}
                  <td className="tabular px-2 py-1.5 text-right font-semibold">
                    {purchases ? purchases.toLocaleString() : '—'}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-slate-500">
            ※家事按分している経費(地代家賃・水道光熱費など)の割合は、決算書2〜3ページの各欄の按分記載に
            <Link href="/anbun" className="mx-1 text-blue-700 underline">
              家事按分設定
            </Link>
            の内容(根拠メモ)を使ってください。
          </p>
        </Card>

        <Card title="青色申告決算書 3ページ目 ── 減価償却費の計算">
          <SectionTable>
            <Row label="本年分の必要経費算入額 合計" value={dep.business || null} note="損益計算書の「減価償却費」と一致" />
          </SectionTable>
          <p className="mt-2 text-xs text-slate-500">
            資産ごとの明細(取得価額・償却率・償却期間・未償却残高)は
            <Link href="/assets" className="mx-1 font-medium text-blue-700 underline">
              固定資産台帳
            </Link>
            の「決算書『減価償却費の計算』CSV」をそのまま転記できます。
          </p>
        </Card>

        <Card title="青色申告決算書 4ページ目 ── 貸借対照表(期首 1/1・期末 12/31)">
          <div className="grid gap-6 lg:grid-cols-2">
            <div>
              <h3 className="mb-2 text-xs font-semibold text-slate-500">資産の部</h3>
              <SectionTable>
                {bs.assets.map((r) => (
                  <Row
                    key={r.id}
                    label={r.label}
                    value={r.closing}
                    note={`期首: ${r.opening.toLocaleString()}${
                      r.id === 'bank'
                        ? '(「その他の預金」欄)'
                        : r.id === 'fixed_asset'
                          ? '(「工具 器具 備品」欄)'
                          : r.id === 'deferred_asset'
                            ? '(「開業費」欄)'
                            : ''
                    }`}
                  />
                ))}
                <Row label="資産の部 合計" value={bs.totalAssetsClosing} strong note={`期首: ${bs.totalAssetsOpening.toLocaleString()}`} />
              </SectionTable>
            </div>
            <div>
              <h3 className="mb-2 text-xs font-semibold text-slate-500">負債・資本の部</h3>
              <SectionTable>
                {bs.liabilities.map((r) => (
                  <Row key={r.id} label={r.label} value={r.closing} note={`期首: ${r.opening.toLocaleString()}`} />
                ))}
                {bs.equity.map((r) => (
                  <Row key={r.id} label={r.label} value={r.closing} note={r.id === 'capital' ? `期首: ${r.opening.toLocaleString()}` : ''} />
                ))}
                <Row label="負債・資本の部 合計" value={bs.totalLiabEquityClosing} strong note={`期首: ${bs.totalLiabEquityOpening.toLocaleString()}`} />
              </SectionTable>
            </div>
          </div>
          {!bs.balanced && (
            <div className="mt-3">
              <Alert tone="warning">
                貸借が一致していません。転記の前に
                <Link href="/books" className="mx-1 font-medium text-blue-700 underline">
                  帳簿・決算書
                </Link>
                ページで原因(固定資産の取得取引の漏れ・期首残高)を確認してください。
              </Alert>
            </div>
          )}
        </Card>

        <Card title="確定申告書 第一表(作成コーナーでは自動計算される欄もあります)">
          <SectionTable>
            <Row label="収入金額等 ── 事業(営業等)㋐" value={summary.totalSales} />
            <Row label="所得金額等 ── 事業(営業等)" value={tax.totalIncome} note="青色申告特別控除後" strong />
            {tax.breakdown.map((l) => (
              <Row key={l.label} label={`所得から差し引かれる金額 ── ${l.label}`} value={l.amount} />
            ))}
            <Row label="所得から差し引かれる金額 合計" value={tax.totalDeductions} strong />
            <Row label="課税される所得金額(千円未満切捨て)" value={tax.taxable} />
            <Row label="上の金額に対する税額(速算表)" value={tax.incomeTax} />
            <Row label="復興特別所得税(税額 × 2.1%)" value={tax.reconstructionTax} />
            <Row label="所得税及び復興特別所得税の額" value={tax.totalTax} strong />
            <Row label="源泉徴収税額" value={deduction.withholding} />
            <Row
              label={tax.balanceDue >= 0 ? '納める税金(100円未満切捨て)' : '還付される税金'}
              value={Math.abs(tax.balanceDue)}
              strong
            />
          </SectionTable>
          <ul className="mt-3 list-disc space-y-1 pl-5 text-xs leading-relaxed text-slate-500">
            <li>作成コーナーで決算書→申告書の順に入力すると、収入・所得は自動転記されます。</li>
            <li>65万円控除は e-Tax 送信(または優良な電子帳簿保存)が要件です。書面提出は55万円になります。</li>
            <li>予定納税がある場合は第一表の該当欄で差し引いてください(本アプリでは未管理)。</li>
          </ul>
        </Card>

        <EtaxCard
          year={year}
          summary={summary}
          purchases={purchases}
          costOfSales={costOfSales}
          grossProfit={grossProfit}
          expensesTotal={expensesTotal}
          tax={tax}
          deduction={deduction}
          bs={bs}
          monthlyPurchases={monthlyPurchases}
        />
      </div>
    </>
  );
}

