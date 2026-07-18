'use client';

import React, { useState } from 'react';
import { Alert, btn, Card, input } from '@/components/ui';
import { summarizeYear } from '@/lib/aggregate';
import { depreciationRowsForYear } from '@/lib/assets';
import { downloadText } from '@/lib/csv';
import { buildKessanshoXtx, EtaxPayrollRow, etaxInputProblems } from '@/lib/etax';
import { today } from '@/lib/format';
import { IncomeTaxResult } from '@/lib/incometax';
import { kessanshoExpenseValues } from '@/lib/kessansho';
import { BalanceSheet } from '@/lib/ledger';
import { useStore } from '@/lib/store';
import { summarizeTax } from '@/lib/tax';
import { DeductionEntry, IssuerProfile } from '@/lib/types';

/** e-Tax 連携カード(申告等データ .xtx のダウンロード)。転記ガイドページで使用 */
export function EtaxCard({
  year,
  summary,
  purchases,
  costOfSales,
  grossProfit,
  expensesTotal,
  tax,
  deduction,
  bs,
  monthlyPurchases,
}: {
  year: number;
  summary: ReturnType<typeof summarizeYear>;
  purchases: number;
  costOfSales: number;
  grossProfit: number;
  expensesTotal: number;
  tax: IncomeTaxResult;
  deduction: DeductionEntry;
  bs: BalanceSheet;
  monthlyPurchases: number[];
}) {
  const store = useStore();
  const iss = store.issuer;
  const [zeimushoCode, setZeimushoCode] = useState(iss.zeimushoCode);
  const [zeimushoName, setZeimushoName] = useState(iss.zeimushoName);
  const [etaxId, setEtaxId] = useState(iss.etaxId);
  const [nameKana, setNameKana] = useState(iss.nameKana);
  const [yago, setYago] = useState(iss.yago);
  const [shokugyo, setShokugyo] = useState(iss.shokugyo);
  const [message, setMessage] = useState<string | null>(null);

  const draft: IssuerProfile = {
    ...iss,
    zeimushoCode: zeimushoCode.trim(),
    zeimushoName: zeimushoName.trim(),
    etaxId: etaxId.trim(),
    nameKana: nameKana.trim(),
    yago: yago.trim(),
    shokugyo: shokugyo.trim(),
  };
  const problems = etaxInputProblems(draft);

  const download = () => {
    store.updateIssuer(draft); // 入力を保存してから出力する
    // 軽減税率(8%)対象の売上・仕入(税区分 taxable8 の集計)
    const taxSummary = summarizeTax(store.transactions, year, store.taxSettings);

    // 給料賃金の内訳(従業員別: 従事月数=支払があった月の数)
    const inYear = store.payrolls.filter((p) => p.date.startsWith(`${year}-`));
    const payroll: EtaxPayrollRow[] = [...new Set(inYear.map((p) => p.employee))].map((emp) => {
      const rows = inYear.filter((p) => p.employee === emp);
      return {
        name: emp,
        months: new Set(rows.map((p) => p.date.slice(5, 7))).size,
        salary: rows.reduce((s, p) => s + p.gross, 0),
        withholding: rows.reduce((s, p) => s + p.withholding, 0),
      };
    });

    // 減価償却費の計算(CSV出力と同じ共通の行データを使う)
    const depreciation = depreciationRowsForYear(store.assets, year);

    const rowOf = (rows: { id: string; opening: number; closing: number }[], id: string) =>
      rows.find((r) => r.id === id) ?? { opening: 0, closing: 0 };
    const asset = (id: string) => rowOf(bs.assets, id);
    const liab = (id: string) => rowOf(bs.liabilities, id);
    const equity = (id: string) => rowOf(bs.equity, id);

    const xml = buildKessanshoXtx({
      year,
      issuer: draft,
      createdDate: today(),
      pl: {
        sales: summary.totalSales,
        inventoryOpening: summary.inventoryOpening,
        purchases,
        inventoryClosing: summary.inventoryClosing,
        costOfSales,
        grossProfit,
        expenseByAccount: Object.fromEntries(
          summary.expenseLines.map((l) => [l.account, l.business]),
        ),
        extras: kessanshoExpenseValues(summary.expenseLines).extras.map((e) => ({
          name: e.label,
          amount: e.amount,
        })),
        expensesTotal,
        net: summary.profit,
        blueApplied: tax.blueApplied,
        income: tax.totalIncome,
        blueOption: deduction.blueDeduction,
      },
      monthly: { sales: summary.monthlySales, purchases: monthlyPurchases },
      reduced: { sales: taxSummary.sales8, purchases: taxSummary.purchase8 },
      payroll,
      depreciation,
      bs: {
        opening: {
          cash: asset('cash').opening,
          bank: asset('bank').opening,
          receivable: asset('receivable').opening,
          inventory: asset('inventory').opening,
          fixedAsset: asset('fixed_asset').opening,
          deferredAsset: asset('deferred_asset').opening,
          payable: liab('payable').opening,
          cardPayable: liab('card').opening,
          deposit: liab('deposit').opening,
          capital: equity('capital').opening,
        },
        closing: {
          cash: asset('cash').closing,
          bank: asset('bank').closing,
          receivable: asset('receivable').closing,
          inventory: asset('inventory').closing,
          fixedAsset: asset('fixed_asset').closing,
          deferredAsset: asset('deferred_asset').closing,
          ownerDraw: asset('owner_draw').closing,
          payable: liab('payable').closing,
          cardPayable: liab('card').closing,
          deposit: liab('deposit').closing,
          ownerCredit: equity('owner_invest').closing,
          capital: equity('capital').closing,
          profit: equity('profit').closing,
        },
      },
    });
    downloadText(`申告等データ_青色申告決算書_令和${year - 2018}年分.xtx`, xml, 'application/xml');
    setMessage('申告等データ(.xtx)をダウンロードしました。e-Taxソフト(インストール版)の「組み込み」→「申告・申請等」で読み込んでください。');
  };

  const field = (
    id: string,
    label: string,
    value: string,
    set: (v: string) => void,
    placeholder = '',
    hint = '',
  ) => (
    <div>
      <label htmlFor={id} className="mb-1 block text-xs font-medium text-slate-500" title={hint}>
        {label}
      </label>
      <input
        id={id}
        type="text"
        className={`${input} w-full`}
        placeholder={placeholder}
        value={value}
        onChange={(e) => set(e.target.value)}
      />
    </div>
  );

  return (
    <Card title="e-Tax 連携 ── 申告等データ(.xtx)のダウンロード">
      <p className="mb-3 text-xs leading-relaxed text-slate-500">
        この年分の<strong>青色申告決算書(一般用)</strong>を、e-Taxソフト(インストール版)の
        「組み込み」で読み込める<strong>申告等データ(.xtx)</strong>として出力します
        (手続「所得税及び復興特別所得税申告」v25.0.0・帳票KOA210 v11.0)。
        読み込み後、申告書第一表・第二表はe-Taxソフトまたは作成コーナーで作成してください。
      </p>
      <div className="grid gap-3 sm:grid-cols-3">
        {field('etax-zeimusho-code', '提出先税務署コード(5桁)*', zeimushoCode, setZeimushoCode, '01143', '国税庁サイトの「税務署の所在地などを知りたい方」で確認できます')}
        {field('etax-zeimusho-name', '税務署名(「税務署」は不要)', zeimushoName, setZeimushoName, '新宿')}
        {field('etax-id', '利用者識別番号(16桁・未取得は空欄)', etaxId, setEtaxId, '')}
        {field('etax-name-kana', '氏名フリガナ', nameKana, setNameKana, 'ヤマダ タロウ')}
        {field('etax-yago', '屋号', yago, setYago, '')}
        {field('etax-shokugyo', '業種名', shokugyo, setShokugyo, 'デザイン業')}
      </div>
      <p className="mt-2 text-[11px] text-slate-500">
        氏名・住所は請求書発行ページの「請求元情報」と共通です({iss.name || '未入力'} / {iss.address || '住所未入力'})。
      </p>
      {problems.length > 0 && (
        <ul className="mt-3 list-disc pl-5 text-xs text-amber-700">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          className={btn.primary}
          disabled={problems.length > 0}
          onClick={download}
        >
          ⬇ 申告等データ(.xtx)をダウンロード
        </button>
        <button
          type="button"
          className={btn.secondary}
          onClick={() => {
            store.updateIssuer(draft);
            setMessage('e-Tax用の入力を保存しました。');
          }}
        >
          入力を保存
        </button>
      </div>
      {message && (
        <div className="mt-3">
          <Alert tone="info">{message}</Alert>
        </div>
      )}
      <ul className="mt-4 list-disc space-y-1 pl-5 text-xs leading-relaxed text-slate-500">
        <li>
          出力データは国税庁公開のXML構造設計書・XMLスキーマ(RKO0010 v25.0.0)に適合することを確認しています。
          e-Taxソフト実機での最終確認は、読み込み後の帳票表示で必ず行ってください。
        </li>
        <li>e-Taxソフト(WEB版・SP版)は.xtxの組み込みに対応していません。インストール版をご利用ください。</li>
        <li>専従者給与・貸倒引当金・製造原価(3ページ目の一部)・売上先/仕入先明細には対応していません。該当がある場合はe-Taxソフト上で追記してください。</li>
        <li>貸借対照表が不一致のまま出力すると、そのままの数字が出ます。先に帳簿・決算書ページでご確認ください。</li>
      </ul>
    </Card>
  );
}

