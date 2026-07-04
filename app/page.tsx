'use client';

import Link from 'next/link';
import { useMemo, useRef, useState } from 'react';
import BarChart from '@/components/BarChart';
import { Alert, btn, Card, EmptyState, PageHeader, selectCls, StatCard } from '@/components/ui';
import {
  availableYears,
  depreciationCandidates,
  periodSlipCandidates,
  summarizeYear,
  summaryToCsv,
  transactionsOfYear,
} from '@/lib/aggregate';
import { buildBackupJson, parseBackupJson } from '@/lib/backup';
import { downloadText, transactionsToCsv } from '@/lib/csv';
import { today, yen } from '@/lib/format';
import { useStore } from '@/lib/store';

export default function DashboardPage() {
  const store = useStore();
  const [year, setYear] = useState(() => new Date().getFullYear());
  const restoreRef = useRef<HTMLInputElement>(null);

  const years = useMemo(
    () => availableYears(store.transactions, new Date().getFullYear()),
    [store.transactions],
  );
  // 固定資産台帳の減価償却費・棚卸高の売上原価調整も合算される
  const summary = useMemo(
    () => summarizeYear(store.transactions, year, store.assets, store.inventories),
    [store.transactions, year, store.assets, store.inventories],
  );

  if (!store.ready) {
    return <div className="py-24 text-center text-sm text-slate-400">読み込み中…</div>;
  }

  const hasData = store.transactions.length > 0;

  const loadDemo = () => {
    if (
      hasData &&
      !confirm('現在の取引・ルール・按分設定はすべてサンプルデータで置き換えられます。よろしいですか?')
    ) {
      return;
    }
    store.loadDemoData();
  };

  const downloadBackup = () =>
    downloadText(
      `申告スナップ_バックアップ_${today()}.json`,
      buildBackupJson(store.exportData()),
      'application/json',
    );

  const onRestoreFile = async (file: File) => {
    const text = await file.text();
    const data = parseBackupJson(text);
    // 同じファイルを選び直しても onChange が発火するようクリアしておく
    if (restoreRef.current) restoreRef.current.value = '';
    if (!data) {
      alert('バックアップファイルとして読み取れませんでした。「申告スナップ」でダウンロードしたJSONファイルをご指定ください。');
      return;
    }
    if (
      confirm(
        `バックアップ(取引${data.transactions.length}件・ルール${data.rules.length}件・按分設定${data.anbunSettings.length}件)で現在のデータをすべて置き換えます。よろしいですか?`,
      )
    ) {
      store.restoreData(data);
    }
  };

  const yearTxs = transactionsOfYear(store.transactions, year);
  // 期ズレ候補: 翌年1月に入金された売上(12月分の仕事の対価なら当年の売上にすべきもの)
  const slip = periodSlipCandidates(store.transactions, year);
  const slipTotal = slip.reduce((s, t) => s + t.amount, 0);
  // 減価償却候補: 10万円以上なのに消耗品費のままの取引
  const depre = depreciationCandidates(yearTxs);
  const depreTotal = depre.reduce((s, t) => s + t.amount, 0);

  return (
    <>
      {/* バックアップ復元用のファイル選択(空状態・データ管理の両方から使う) */}
      <input
        ref={restoreRef}
        type="file"
        accept=".json,application/json"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void onRestoreFile(f);
        }}
      />

      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <PageHeader
          title="ダッシュボード"
          description={`${year}年1月1日〜12月31日の集計(入出金日ベース・青色申告決算書の参考値)`}
        />
        <div className="flex items-center gap-2">
          <label htmlFor="year" className="text-sm text-slate-500">
            対象年度
          </label>
          <select
            id="year"
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
        </div>
      </div>

      {!hasData && (
        <EmptyState>
          <p className="mb-4">まだ取引データがありません。</p>
          <div className="flex flex-wrap justify-center gap-3">
            <Link href="/transactions" className={btn.primary}>
              CSVを取り込む
            </Link>
            <button type="button" className={btn.secondary} onClick={loadDemo}>
              サンプルデータを読み込む
            </button>
            <button
              type="button"
              className={btn.secondary}
              onClick={() => restoreRef.current?.click()}
            >
              バックアップから復元
            </button>
          </div>
        </EmptyState>
      )}

      {hasData && (
        <div className="space-y-6">
          {(summary.unclassifiedCount > 0 || summary.unapprovedCount > 0) && (
            <Alert tone="warning">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  ⚠️ {year}年分に
                  {summary.unclassifiedCount > 0 && (
                    <>
                      <strong className="mx-1">未仕訳の取引が{summary.unclassifiedCount}件</strong>
                    </>
                  )}
                  {summary.unclassifiedCount > 0 && summary.unapprovedCount > 0 && '、'}
                  {summary.unapprovedCount > 0 && (
                    <>
                      <strong className="mx-1">未承認の取引が{summary.unapprovedCount}件</strong>
                    </>
                  )}
                  あります。集計前に確認してください。
                </div>
                <Link href="/transactions" className={btn.small}>
                  取引一覧で確認する →
                </Link>
              </div>
            </Alert>
          )}

          {slip.length > 0 && (
            <Alert tone="warning">
              🗓 <strong className="mx-1">{year + 1}年1月に入金された売上が{slip.length}件(合計 {yen(slipTotal)})</strong>
              あります。{year}年12月までの仕事の対価であれば、正しくは{year}年分の売上です(期ズレ)。
              12月付(発生日)の売上として手入力し、1月の入金行は「対象外(プライベート)」に変更してください。
            </Alert>
          )}

          {depre.length > 0 && (
            <Alert tone="warning">
              ⚠ <strong className="mx-1">10万円以上の「消耗品費」が{depre.length}件(合計 {yen(depreTotal)})</strong>
              あります。10万円以上の備品等は原則、減価償却資産です。取引一覧で科目を
              <strong>「固定資産の取得(振替)」</strong>に変更し、
              <strong>「固定資産台帳」ページに登録</strong>すると、償却費(定額法・一括償却・少額特例)が自動計算されます。
            </Alert>
          )}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label="売上(収入)金額 年間合計" value={yen(summary.totalSales)} tone="primary" />
            <StatCard
              label="経費 年間合計(按分後)"
              value={yen(summary.totalExpense)}
              sub={summary.totalOwner > 0 ? `按分前 ${yen(summary.totalGross)}` : undefined}
            />
            <StatCard
              label="差引金額(特別控除前の所得)"
              value={yen(summary.profit)}
              tone="positive"
              sub="売上合計 − 経費合計"
            />
            <StatCard
              label="事業主貸(家事分)"
              value={yen(summary.totalOwner)}
              tone="muted"
              sub="家事按分で経費から除いた額"
            />
          </div>

          <Card title={`月別売上(${year}年)`}>
            <BarChart values={summary.monthlySales} />
            <div className="mt-4 overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
                    <th className="py-2 pr-2 font-medium">月</th>
                    {summary.monthlySales.map((_, i) => (
                      <th key={i} className="tabular px-2 py-2 text-right font-medium">
                        {i + 1}月
                      </th>
                    ))}
                    <th className="tabular px-2 py-2 text-right font-semibold">年間合計</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td className="py-2 pr-2 text-xs text-slate-500">売上</td>
                    {summary.monthlySales.map((v, i) => (
                      <td key={i} className="tabular px-2 py-2 text-right">
                        {v === 0 ? '—' : v.toLocaleString()}
                      </td>
                    ))}
                    <td className="tabular px-2 py-2 text-right font-semibold text-blue-700">
                      {summary.totalSales.toLocaleString()}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </Card>

          <Card
            title={`経費の科目別内訳(${year}年・家事按分適用後)`}
            action={
              <div className="flex gap-2">
                <button
                  type="button"
                  className={btn.small}
                  onClick={() =>
                    downloadText(`青色申告集計_${year}.csv`, summaryToCsv(summary))
                  }
                >
                  ⬇ 決算書用CSV
                </button>
                <button
                  type="button"
                  className={btn.small}
                  onClick={() =>
                    downloadText(`取引データ_${year}.csv`, transactionsToCsv(yearTxs))
                  }
                >
                  ⬇ 取引データCSV
                </button>
              </div>
            }
          >
            {summary.expenseLines.length === 0 ? (
              <p className="text-sm text-slate-400">この年の経費データはまだありません。</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[560px] text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
                      <th className="py-2 pr-2 font-medium">勘定科目</th>
                      <th className="tabular px-2 py-2 text-right font-medium">支払額(按分前)</th>
                      <th className="tabular px-2 py-2 text-right font-medium">事業主貸(家事分)</th>
                      <th className="tabular px-2 py-2 text-right font-medium">経費計上額</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.expenseLines.map((l) => (
                      <tr key={l.account} className="border-b border-slate-100">
                        <td className="py-2 pr-2">
                          {l.label}
                          {l.owner > 0 && (
                            <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800">
                              按分
                            </span>
                          )}
                        </td>
                        <td className="tabular px-2 py-2 text-right text-slate-500">
                          {l.gross.toLocaleString()}
                        </td>
                        <td className="tabular px-2 py-2 text-right text-slate-500">
                          {l.owner === 0 ? '—' : l.owner.toLocaleString()}
                        </td>
                        <td className="tabular px-2 py-2 text-right font-medium">
                          {l.business.toLocaleString()}
                        </td>
                      </tr>
                    ))}
                    {(summary.inventoryOpening > 0 || summary.inventoryClosing > 0) && (
                      <>
                        <tr className="border-b border-slate-100">
                          <td className="py-2 pr-2">期首商品棚卸高(売上原価に加算)</td>
                          <td className="tabular px-2 py-2 text-right text-slate-500">
                            {summary.inventoryOpening.toLocaleString()}
                          </td>
                          <td className="tabular px-2 py-2 text-right text-slate-500">—</td>
                          <td className="tabular px-2 py-2 text-right font-medium">
                            {summary.inventoryOpening.toLocaleString()}
                          </td>
                        </tr>
                        <tr className="border-b border-slate-100">
                          <td className="py-2 pr-2">期末商品棚卸高(売上原価から控除)</td>
                          <td className="tabular px-2 py-2 text-right text-slate-500">
                            −{summary.inventoryClosing.toLocaleString()}
                          </td>
                          <td className="tabular px-2 py-2 text-right text-slate-500">—</td>
                          <td className="tabular px-2 py-2 text-right font-medium">
                            −{summary.inventoryClosing.toLocaleString()}
                          </td>
                        </tr>
                      </>
                    )}
                    <tr>
                      <td className="py-2 pr-2 font-semibold">経費合計</td>
                      <td className="tabular px-2 py-2 text-right font-semibold text-slate-500">
                        {summary.totalGross.toLocaleString()}
                      </td>
                      <td className="tabular px-2 py-2 text-right font-semibold text-slate-500">
                        {summary.totalOwner.toLocaleString()}
                      </td>
                      <td className="tabular px-2 py-2 text-right font-semibold">
                        {summary.totalExpense.toLocaleString()}
                      </td>
                    </tr>
                    <tr className="bg-emerald-50/60">
                      <td className="py-2 pr-2 font-bold text-emerald-800" colSpan={3}>
                        差引金額(青色申告特別控除前の所得金額)
                      </td>
                      <td className="tabular px-2 py-2 text-right font-bold text-emerald-800">
                        {summary.profit.toLocaleString()}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card title="申告前のご確認(このアプリの集計の前提)">
            <ul className="list-disc space-y-2 pl-5 text-sm leading-relaxed text-slate-600">
              <li>
                このページの集計は<strong>損益計算書(P/L)に相当</strong>します。あわせて
                <strong>「帳簿・決算書」ページ</strong>
                で複式簿記の仕訳帳・総勘定元帳・貸借対照表が自動作成されるため、全取引を仕訳・承認し
                発生主義で記帳すれば<strong>青色申告特別控除55万円</strong>
                (e-Tax等による申告なら<strong>65万円</strong>)の帳簿要件に対応できます。
              </li>
              <li>
                <strong>期ズレ(発生主義)</strong>: 12月分の仕事の対価が翌年1月入金の場合、
                12月末日付で決済手段を「売掛金(発生記録)」にした売上を手入力し、
                翌年1月の入金行は科目を「売掛金の回収」にしてください。売掛金は貸借対照表に自動で載ります。
              </li>
              <li>
                消費税は<strong>「消費税」ページ</strong>
                で税区分別の集計と納付額の試算(本則・簡易・2割特例)ができます(税込経理・概算)。
              </li>
              <li>
                集計値は国税庁「確定申告書等作成コーナー」等へ転記するための参考値です。
                最終的な申告内容は税理士等にご確認ください。
              </li>
            </ul>
          </Card>

          <Card title="データ管理(バックアップ)">
            <div className="flex flex-wrap items-center gap-3">
              <button type="button" className={btn.primary} onClick={downloadBackup}>
                ⬇ バックアップをダウンロード(JSON)
              </button>
              <button
                type="button"
                className={btn.secondary}
                onClick={() => restoreRef.current?.click()}
              >
                ⬆ バックアップから復元
              </button>
              <button type="button" className={btn.secondary} onClick={loadDemo}>
                サンプルデータを読み込む
              </button>
              <button
                type="button"
                className={`${btn.secondary} !text-rose-600`}
                onClick={() => {
                  if (confirm('すべての取引・ルール・按分設定を削除します。よろしいですか?')) {
                    store.clearAll();
                  }
                }}
              >
                全データを削除
              </button>
            </div>
            <p className="mt-3 text-xs leading-relaxed text-slate-400">
              ※データはこの端末のブラウザ内(localStorage)にのみ保存されています。ブラウザのデータ消去や
              端末の故障で帳簿が失われるため、<strong className="text-slate-500">定期的にバックアップをダウンロード</strong>
              して保管してください(帳簿・書類は原則7年の保存義務があります)。
            </p>
          </Card>
        </div>
      )}
    </>
  );
}
