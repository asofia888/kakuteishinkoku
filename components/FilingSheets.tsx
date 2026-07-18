'use client';

import React from 'react';
import { summarizeYear } from '@/lib/aggregate';
import { IncomeTaxResult } from '@/lib/incometax';
import { KESSANSHO_BLANK_NOS, KessanshoExpenseValues } from '@/lib/kessansho';
import { BalanceSheet } from '@/lib/ledger';
import { DeductionEntry, IssuerProfile } from '@/lib/types';

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
export function FilingSheets({
  year,
  issuer,
  summary,
  purchases,
  costOfSales,
  grossProfit,
  expensesTotal,
  expenses,
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
  expenses: KessanshoExpenseValues;
  bs: BalanceSheet;
  tax: IncomeTaxResult;
  deduction: DeductionEntry;
}) {
  // 損益計算書の経費欄: 固定欄(⑧〜㉔)・空欄科目(㉕〜㉚)・雑費㉛を共通定義表から組み立てる
  const fixedRows = expenses.fixed.filter((e) => e.no !== '㉛');
  const miscRow = expenses.fixed.find((e) => e.no === '㉛');
  const plExpenses: { no: string; label: string; value: number | null }[] = [
    ...fixedRows.map((e) => ({ no: e.no, label: e.label, value: e.amount })),
    ...KESSANSHO_BLANK_NOS.map((no, i) => {
      const ex = expenses.extras[i];
      return ex ? { no, label: ex.label, value: ex.amount } : { no, label: '', value: null };
    }),
    { no: '㉛', label: miscRow?.label ?? '雑費', value: miscRow?.amount ?? null },
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

