'use client';

import Link from 'next/link';
import React, { useMemo, useState } from 'react';
import { Alert, btn, Card, PageHeader, selectCls } from '@/components/ui';
import { availableYears, summarizeYear, transactionsOfYear } from '@/lib/aggregate';
import { yearDepreciationTotals } from '@/lib/assets';
import { IncomeTaxResult, simulateIncomeTax } from '@/lib/incometax';
import { BalanceSheet, buildBalanceSheet } from '@/lib/ledger';
import { useStore } from '@/lib/store';
import { DeductionEntry, emptyDeduction, IssuerProfile } from '@/lib/types';

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

/** 損益計算書の経費欄の並び(青色申告決算書 一般用の順序) */
const EXPENSE_ORDER: { account: string; label: string }[] = [
  { account: 'taxes_dues', label: '租税公課' },
  { account: 'shipping', label: '荷造運賃' },
  { account: 'utilities', label: '水道光熱費' },
  { account: 'travel', label: '旅費交通費' },
  { account: 'communication', label: '通信費' },
  { account: 'advertising', label: '広告宣伝費' },
  { account: 'entertainment', label: '接待交際費' },
  { account: 'insurance', label: '損害保険料' },
  { account: 'repairs', label: '修繕費' },
  { account: 'supplies', label: '消耗品費' },
  { account: 'depreciation', label: '減価償却費' },
  { account: 'welfare', label: '福利厚生費' },
  { account: 'salaries', label: '給料賃金' },
  { account: 'outsourcing', label: '外注工賃' },
  { account: 'interest', label: '利子割引料' },
  { account: 'rent', label: '地代家賃' },
  { account: 'books', label: '新聞図書費(空欄科目に記入)' },
  { account: 'fees', label: '支払手数料(空欄科目に記入)' },
  { account: 'misc', label: '雑費' },
];

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
              expLine={expLine}
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
            {EXPENSE_ORDER.map((e) => (
              <Row key={e.account} label={e.label} value={expLine(e.account)} />
            ))}
            <Row label="経費 計" value={expensesTotal} strong note="⑧〜雑費の合計" />
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
      </div>
    </>
  );
}

// ── 様式イメージ(印刷用)──

/** 様式イメージの1行(番号・科目・金額)。value が null の欄は空欄にする */
function FormRow({
  no,
  label,
  value,
  strong,
}: {
  no?: string;
  label: string;
  value: number | null;
  strong?: boolean;
}) {
  return (
    <tr className={strong ? 'bg-slate-50 font-semibold' : ''}>
      <td className="w-8 border border-slate-400 px-1 py-[3px] text-center text-[10px] text-slate-600">
        {no ?? ''}
      </td>
      <td className="border border-slate-400 px-1.5 py-[3px] text-[11px]">{label}</td>
      <td className="tabular w-28 border border-slate-400 px-1.5 py-[3px] text-right text-[11px]">
        {value === null ? '' : value.toLocaleString()}
      </td>
    </tr>
  );
}

/** 様式イメージの節見出し(第一表の「収入金額等」など) */
function FormSection({ label }: { label: string }) {
  return (
    <tr>
      <td colSpan={3} className="border border-slate-400 bg-slate-100 px-1.5 py-[3px] text-[11px] font-semibold">
        {label}
      </td>
    </tr>
  );
}

/** 各ページ共通のヘッダー(年分・タイトル・申告者情報) */
function SheetHeader({ year, title, sub, issuer }: { year: number; title: string; sub: string; issuer: IssuerProfile }) {
  return (
    <header>
      <div className="flex flex-wrap items-end justify-between gap-2 border-b-2 border-slate-800 pb-2">
        <h2 className="text-base font-bold">
          令和{year - 2018}年分({year}年分) {title}
          <span className="ml-2 text-[11px] font-normal text-slate-500">様式イメージ(提出用ではありません)</span>
        </h2>
        <div className="text-[11px] text-slate-600">{sub}</div>
      </div>
      <div className="mt-2 grid grid-cols-1 gap-1 text-[11px] sm:grid-cols-3 sm:gap-2">
        <div className="border border-slate-400 px-2 py-1">氏 名: {issuer.name}</div>
        <div className="border border-slate-400 px-2 py-1">住 所: {issuer.address}</div>
        <div className="border border-slate-400 px-2 py-1">電 話: {issuer.tel}</div>
      </div>
    </header>
  );
}

/** 貸借対照表の1行(科目・期首・期末)。blankOpening は様式どおり期首を空欄にする */
function BsRow({
  label,
  opening,
  closing,
  blankOpening,
  strong,
}: {
  label: string;
  opening: number;
  closing: number;
  blankOpening?: boolean;
  strong?: boolean;
}) {
  return (
    <tr className={strong ? 'bg-slate-50 font-semibold' : ''}>
      <td className="border border-slate-400 px-1.5 py-[3px] text-[11px]">{label}</td>
      <td className="tabular w-28 border border-slate-400 px-1.5 py-[3px] text-right text-[11px]">
        {blankOpening ? '' : opening.toLocaleString()}
      </td>
      <td className="tabular w-28 border border-slate-400 px-1.5 py-[3px] text-right text-[11px]">
        {closing.toLocaleString()}
      </td>
    </tr>
  );
}

/**
 * 印刷用の様式イメージ(A4・3枚)。
 * 青色申告決算書1ページ目(損益計算書)・4ページ目(貸借対照表)・確定申告書第一表を
 * 様式に近い並びで出力する。数値は転記ガイドの表と同じ計算値。
 */
function FilingSheets({
  year,
  issuer,
  summary,
  purchases,
  costOfSales,
  grossProfit,
  expensesTotal,
  expLine,
  bs,
  tax,
  deduction,
}: {
  year: number;
  issuer: IssuerProfile;
  summary: ReturnType<typeof summarizeYear>;
  purchases: number;
  costOfSales: number;
  grossProfit: number;
  expensesTotal: number;
  expLine: (account: string) => number | null;
  bs: BalanceSheet;
  tax: IncomeTaxResult;
  deduction: DeductionEntry;
}) {
  // 損益計算書の経費欄(⑧〜㉛)。㉕〜㉚は様式の空欄で、帳簿の科目名を記入して使う
  const plExpenses: { no: string; label: string; value: number | null }[] = [
    { no: '⑧', label: '租税公課', value: expLine('taxes_dues') },
    { no: '⑨', label: '荷造運賃', value: expLine('shipping') },
    { no: '⑩', label: '水道光熱費', value: expLine('utilities') },
    { no: '⑪', label: '旅費交通費', value: expLine('travel') },
    { no: '⑫', label: '通信費', value: expLine('communication') },
    { no: '⑬', label: '広告宣伝費', value: expLine('advertising') },
    { no: '⑭', label: '接待交際費', value: expLine('entertainment') },
    { no: '⑮', label: '損害保険料', value: expLine('insurance') },
    { no: '⑯', label: '修繕費', value: expLine('repairs') },
    { no: '⑰', label: '消耗品費', value: expLine('supplies') },
    { no: '⑱', label: '減価償却費', value: expLine('depreciation') },
    { no: '⑲', label: '福利厚生費', value: expLine('welfare') },
    { no: '⑳', label: '給料賃金', value: expLine('salaries') },
    { no: '㉑', label: '外注工賃', value: expLine('outsourcing') },
    { no: '㉒', label: '利子割引料', value: expLine('interest') },
    { no: '㉓', label: '地代家賃', value: expLine('rent') },
    { no: '㉔', label: '貸倒金', value: null },
    { no: '㉕', label: '新聞図書費', value: expLine('books') },
    { no: '㉖', label: '支払手数料', value: expLine('fees') },
    { no: '㉗', label: '', value: null },
    { no: '㉘', label: '', value: null },
    { no: '㉙', label: '', value: null },
    { no: '㉚', label: '', value: null },
    { no: '㉛', label: '雑費', value: expLine('misc') },
  ];

  return (
    <div className="filing-sheet space-y-6">
      {/* 1枚目: 損益計算書 */}
      <section className="filing-page rounded border border-slate-300 bg-white p-6">
        <SheetHeader
          year={year}
          title="損益計算書(青色申告決算書 1ページ目)"
          sub={`自 ${year}年1月1日 至 ${year}年12月31日`}
          issuer={issuer}
        />
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <table className="w-full border-collapse">
            <tbody>
              <FormRow no="①" label="売上(収入)金額(雑収入を含む)" value={summary.totalSales} />
              <FormSection label="売上原価" />
              <FormRow no="②" label="期首商品(製品)棚卸高" value={summary.inventoryOpening || null} />
              <FormRow no="③" label="仕入金額(製品製造原価)" value={purchases || null} />
              <FormRow no="④" label="小計(② + ③)" value={summary.inventoryOpening + purchases || null} />
              <FormRow no="⑤" label="期末商品(製品)棚卸高" value={summary.inventoryClosing || null} />
              <FormRow no="⑥" label="差引原価(④ − ⑤)" value={costOfSales || null} />
              <FormRow no="⑦" label="差引金額(① − ⑥)" value={grossProfit} strong />
              <FormSection label="経費" />
              {plExpenses.map((e) => (
                <FormRow key={e.no} no={e.no} label={e.label} value={e.value} />
              ))}
              <FormRow no="㉜" label="経費 計(⑧〜㉛)" value={expensesTotal} strong />
            </tbody>
          </table>
          <div>
            <table className="w-full border-collapse">
              <tbody>
                <FormRow no="㉝" label="差引金額(⑦ − ㉜)" value={summary.profit} strong />
                <FormSection label="各種引当金・準備金等(本アプリ未対応・該当があれば手書き)" />
                <FormRow label="貸倒引当金 繰戻額等" value={null} />
                <FormRow label="貸倒引当金 繰入額等" value={null} />
                <FormRow label="専従者給与" value={null} />
                <FormSection label="所得金額" />
                <FormRow no="㊸" label="青色申告特別控除前の所得金額" value={summary.profit} strong />
                <FormRow no="㊹" label="青色申告特別控除額" value={tax.blueApplied} />
                <FormRow no="㊺" label="所得金額(㊸ − ㊹)" value={tax.totalIncome} strong />
              </tbody>
            </table>
            <p className="mt-2 text-[10px] leading-relaxed text-slate-500">
              青色申告特別控除は e-Tax 送信(または優良な電子帳簿保存)で65万円、
              書面提出は55万円、簡易帳簿は10万円。減価償却の明細(3ページ目)は
              固定資産台帳のCSVを使用してください。
            </p>
          </div>
        </div>
        <footer className="mt-3 border-t border-slate-300 pt-1 text-[10px] text-slate-400">
          申告スナップで作成した様式イメージ({year}年分)── 転記・検算用であり、提出用様式ではありません
        </footer>
      </section>

      {/* 2枚目: 貸借対照表 */}
      <section className="filing-page rounded border border-slate-300 bg-white p-6">
        <SheetHeader
          year={year}
          title="貸借対照表(青色申告決算書 4ページ目・資産負債調)"
          sub={`令和${year - 2018}年12月31日現在`}
          issuer={issuer}
        />
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <table className="w-full border-collapse">
            <tbody>
              <tr>
                <td className="border border-slate-400 bg-slate-100 px-1.5 py-[3px] text-[11px] font-semibold">
                  資産の部
                </td>
                <td className="w-28 border border-slate-400 bg-slate-100 px-1.5 py-[3px] text-right text-[10px]">
                  1月1日(期首)
                </td>
                <td className="w-28 border border-slate-400 bg-slate-100 px-1.5 py-[3px] text-right text-[10px]">
                  12月31日(期末)
                </td>
              </tr>
              {bs.assets.map((r) => (
                <BsRow
                  key={r.id}
                  label={r.label}
                  opening={r.opening}
                  closing={r.closing}
                  blankOpening={r.id === 'owner_draw'}
                />
              ))}
              <BsRow label="合計" opening={bs.totalAssetsOpening} closing={bs.totalAssetsClosing} strong />
            </tbody>
          </table>
          <table className="w-full border-collapse">
            <tbody>
              <tr>
                <td className="border border-slate-400 bg-slate-100 px-1.5 py-[3px] text-[11px] font-semibold">
                  負債・資本の部
                </td>
                <td className="w-28 border border-slate-400 bg-slate-100 px-1.5 py-[3px] text-right text-[10px]">
                  1月1日(期首)
                </td>
                <td className="w-28 border border-slate-400 bg-slate-100 px-1.5 py-[3px] text-right text-[10px]">
                  12月31日(期末)
                </td>
              </tr>
              {bs.liabilities.map((r) => (
                <BsRow key={r.id} label={r.label} opening={r.opening} closing={r.closing} />
              ))}
              {bs.equity.map((r) => (
                <BsRow
                  key={r.id}
                  label={r.label}
                  opening={r.opening}
                  closing={r.closing}
                  blankOpening={r.id !== 'capital'}
                />
              ))}
              <BsRow
                label="合計"
                opening={bs.totalLiabEquityOpening}
                closing={bs.totalLiabEquityClosing}
                strong
              />
            </tbody>
          </table>
        </div>
        {!bs.balanced && (
          <p className="mt-2 text-[11px] font-semibold text-rose-600">
            ⚠ 貸借が一致していません。帳簿・決算書ページで原因を確認してから使用してください。
          </p>
        )}
        <footer className="mt-3 border-t border-slate-300 pt-1 text-[10px] text-slate-400">
          申告スナップで作成した様式イメージ({year}年分)── 転記・検算用であり、提出用様式ではありません
        </footer>
      </section>

      {/* 3枚目: 確定申告書 第一表 */}
      <section className="filing-page rounded border border-slate-300 bg-white p-6">
        <SheetHeader
          year={year}
          title="確定申告書 第一表(該当欄の抜粋)"
          sub="欄の位置は年分の様式で異なります。科目名で照合してください"
          issuer={issuer}
        />
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <table className="w-full border-collapse">
            <tbody>
              <FormSection label="収入金額等" />
              <FormRow no="㋐" label="事業(営業等)" value={summary.totalSales} />
              <FormSection label="所得金額等" />
              <FormRow no="①" label="事業(営業等)── 青色申告特別控除後" value={tax.totalIncome} strong />
              <FormSection label="所得から差し引かれる金額" />
              {tax.breakdown.map((l) => (
                <FormRow key={l.label} label={l.label} value={l.amount} />
              ))}
              <FormRow label="合 計" value={tax.totalDeductions} strong />
            </tbody>
          </table>
          <div>
            <table className="w-full border-collapse">
              <tbody>
                <FormSection label="税金の計算" />
                <FormRow no="㉚" label="課税される所得金額(千円未満切捨て)" value={tax.taxable} />
                <FormRow no="㉛" label="上の㉚に対する税額(速算表)" value={tax.incomeTax} />
                <FormRow label="復興特別所得税額(㉛ × 2.1%)" value={tax.reconstructionTax} />
                <FormRow label="所得税及び復興特別所得税の額" value={tax.totalTax} strong />
                <FormRow label="源泉徴収税額" value={deduction.withholding || null} />
                <FormRow
                  label={tax.balanceDue >= 0 ? '納める税金(100円未満切捨て)' : '還付される税金'}
                  value={Math.abs(tax.balanceDue)}
                  strong
                />
              </tbody>
            </table>
            <p className="mt-2 text-[10px] leading-relaxed text-slate-500">
              社会保険料控除・生命保険料控除などの金額は所得税シミュレーションの入力値です。
              予定納税(第1期・第2期)がある場合は本アプリでは未管理のため、該当欄で差し引いてください。
              住民税・事業税は申告書第二表と住民税欄の記入が別途必要です。
            </p>
          </div>
        </div>
        <footer className="mt-3 border-t border-slate-300 pt-1 text-[10px] text-slate-400">
          申告スナップで作成した様式イメージ({year}年分)── 転記・検算用であり、提出用様式ではありません
        </footer>
      </section>
    </div>
  );
}
