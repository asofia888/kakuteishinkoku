'use client';

import React, { useMemo, useState } from 'react';
import { Alert, btn, Card, input, PageHeader, selectCls, StatCard } from '@/components/ui';
import { availableYears, summarizeYear } from '@/lib/aggregate';
import { yen } from '@/lib/format';
import { salaryIncomeAfterDeduction, simulateIncomeTax, suggestedLossCarryforward } from '@/lib/incometax';
import { computeInvoiceTotals } from '@/lib/invoice';
import { useStore } from '@/lib/store';
import {
  BLUE_DEDUCTION_REFORM_YEAR,
  BlueDeductionAmount,
  blueDeductionOptionsFor,
} from '@/lib/taxparams';
import { DeductionEntry, emptyDeduction } from '@/lib/types';

/** 控除入力フィールドの定義(金額はすべて円) */
const FIELDS: {
  key: keyof Omit<
    DeductionEntry,
    'year' | 'blueDeduction' | 'withholding' | 'salaryGross' | 'salaryWithholding' | 'prepaidTax' | 'lossCarryforward'
  >;
  label: string;
  hint: string;
}[] = [
  { key: 'socialInsurance', label: '社会保険料控除', hint: '国民年金・国民健康保険などの支払額(全額控除)' },
  { key: 'mutualAid', label: '小規模企業共済等掛金控除', hint: 'iDeCo・小規模企業共済の掛金(全額控除)' },
  { key: 'lifeInsurance', label: '生命保険料控除(控除額)', hint: '控除証明書の計算後の控除額。上限12万円は自動適用' },
  { key: 'earthquakeInsurance', label: '地震保険料控除', hint: '支払保険料。上限5万円は自動適用' },
  { key: 'medicalPaid', label: '支払った医療費', hint: '足切り(10万円 or 所得の5%)と上限200万円は自動計算' },
  { key: 'medicalReimbursed', label: 'うち保険金などの補填額', hint: '高額療養費・保険金など' },
  { key: 'donations', label: '寄附金(ふるさと納税)支払額', hint: '2,000円の足切りと所得40%上限は自動計算' },
  { key: 'spouse', label: '配偶者(特別)控除額', hint: '一般38万円・老人48万円など(条件に応じた額を入力)' },
  { key: 'dependents', label: '扶養控除額', hint: '一般38万円/人・特定扶養(19〜22歳)63万円/人などの合計' },
  { key: 'others', label: 'その他の控除', hint: '寡婦・ひとり親(35万円)・障害者控除などの合計' },
];

/** 青色申告特別控除の枠の表示名(2027年分から書面提出は10万円・75万円枠が新設) */
function blueDeductionLabel(amount: BlueDeductionAmount, year: number): string {
  const reformed = year >= BLUE_DEDUCTION_REFORM_YEAR;
  switch (amount) {
    case 750_000:
      return '75万円(複式簿記 + e-Tax提出 + 優良な電子帳簿の保存等)';
    case 650_000:
      return reformed ? '65万円(複式簿記 + e-Tax提出)' : '65万円(複式簿記 + e-Tax申告等)';
    case 550_000:
      return '55万円(複式簿記・書面提出)';
    case 100_000:
      return reformed ? '10万円(書面提出・簡易簿記)' : '10万円(簡易簿記)';
  }
}

export default function SimulationPage() {
  const store = useStore();
  const [year, setYear] = useState(() => new Date().getFullYear());

  const years = useMemo(
    () => availableYears(store.transactions, new Date().getFullYear()),
    [store.transactions],
  );

  const summary = useMemo(
    () => summarizeYear(store.transactions, year, store.assets, store.inventories),
    [store.transactions, year, store.assets, store.inventories],
  );

  // その年に発行した請求書の源泉徴収税額の合計(自動集計の提案値)
  const invoiceWithholding = useMemo(
    () =>
      store.invoices
        .filter((inv) => inv.issueDate.startsWith(`${year}-`) && inv.withholding)
        .reduce((s, inv) => s + computeInvoiceTotals(inv).withholdingTax, 0),
    [store.invoices, year],
  );

  const saved = store.deductions.find((d) => d.year === year);

  // 前年以前の帳簿の赤字から、この年に使える純損失の繰越額の目安(青色・3年)
  const lossSuggestion = useMemo(
    () =>
      suggestedLossCarryforward(
        years
          .filter((y) => y < year)
          .map((y) => {
            const saved = store.deductions.find((d) => d.year === y);
            return {
              year: y,
              profit: summarizeYear(store.transactions, y, store.assets, store.inventories).profit,
              blueDeduction: saved?.blueDeduction ?? 650_000,
              // その年に入力した給与所得と損益通算する
              otherIncome: salaryIncomeAfterDeduction(saved?.salaryGross ?? 0, y),
            };
          }),
        year,
      ),
    [years, year, store.transactions, store.assets, store.inventories, store.deductions],
  );

  if (!store.ready) {
    return <div className="py-24 text-center text-sm text-slate-500">読み込み中…</div>;
  }

  return (
    <>
      <PageHeader
        title="所得税シミュレーション"
        description="帳簿の事業所得(勤め先の給与があればそれも)に所得控除を加味して、所得税・復興特別所得税の納付見込みを試算します(概算)。確定申告書の「所得から差し引かれる金額」の下書きにもなります。"
      />
      <div className="space-y-6">
        <div className="flex items-center gap-3">
          <select aria-label="対象年度" className={selectCls} value={year} onChange={(e) => setYear(Number(e.target.value))}>
            {years.map((y) => (
              <option key={y} value={y}>
                {y}年分
              </option>
            ))}
          </select>
        </div>
        <SimulationBody
          key={year}
          year={year}
          profit={summary.profit}
          initial={saved ?? emptyDeduction(year)}
          invoiceWithholding={invoiceWithholding}
          lossSuggestion={lossSuggestion}
          onSave={(entry) => store.setDeduction(entry)}
        />
      </div>
    </>
  );
}

function SimulationBody({
  year,
  profit,
  initial,
  invoiceWithholding,
  lossSuggestion,
  onSave,
}: {
  year: number;
  profit: number;
  initial: DeductionEntry;
  invoiceWithholding: number;
  lossSuggestion: number;
  onSave: (entry: DeductionEntry) => void;
}) {
  const [form, setForm] = useState<DeductionEntry>(initial);
  const [message, setMessage] = useState<string | null>(null);
  const set = (patch: Partial<DeductionEntry>) => setForm((prev) => ({ ...prev, ...patch }));
  const num = (v: string) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
  };

  const result = useMemo(() => simulateIncomeTax(profit, form), [profit, form]);

  return (
    <>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label={`事業所得(青色控除 ${yen(result.blueApplied)} 後)`}
          value={yen(result.businessIncome)}
          sub={
            form.salaryGross > 0
              ? `+ 給与所得 ${yen(result.salaryIncome)} = 合計所得 ${yen(result.totalIncome)}`
              : `差引金額 ${yen(profit)} − 青色申告特別控除`
          }
        />
        <StatCard label="課税所得(控除後・千円未満切捨て)" value={yen(result.taxable)} />
        <StatCard
          label="所得税+復興特別所得税"
          value={yen(result.totalTax)}
          sub={`所得税 ${yen(result.incomeTax)} + 復興税 ${yen(result.reconstructionTax)}`}
          tone="primary"
        />
        <StatCard
          label={result.balanceDue >= 0 ? '納付見込み(源泉・予定納税差引後)' : '還付見込み'}
          value={yen(Math.abs(result.balanceDue))}
          sub={`源泉徴収税額 ${yen(result.withholdingTotal)}${form.prepaidTax > 0 ? `・予定納税 ${yen(form.prepaidTax)}` : ''}`}
          tone={result.balanceDue >= 0 ? 'default' : 'positive'}
        />
      </div>

      {message && <Alert tone="success">{message}</Alert>}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="所得控除の入力">
          <div className="mb-4">
            <label htmlFor="sim-blue-deduction" className="mb-1 block text-xs font-medium text-slate-500">青色申告特別控除</label>
            <select
              id="sim-blue-deduction"
              className={selectCls}
              value={form.blueDeduction}
              onChange={(e) => set({ blueDeduction: Number(e.target.value) as DeductionEntry['blueDeduction'] })}
            >
              {blueDeductionOptionsFor(year).map((amount) => (
                <option key={amount} value={amount}>
                  {blueDeductionLabel(amount, year)}
                </option>
              ))}
            </select>
            {form.blueDeduction === 750_000 ? (
              <p className="mt-1 text-[11px] leading-snug text-amber-700">
                75万円は、仕訳帳・総勘定元帳を「優良な電子帳簿」の要件(訂正・削除の履歴が残るなど)を満たす
                会計ソフトで保存している場合などに限られます。このアプリの帳簿はその要件を満たしていないため、
                このアプリで記帳している場合は65万円(e-Tax提出)を選んでください。
              </p>
            ) : (
              year >= BLUE_DEDUCTION_REFORM_YEAR && (
                <p className="mt-1 text-[11px] leading-snug text-slate-500">
                  令和8年度改正により{BLUE_DEDUCTION_REFORM_YEAR}年分から、書面で提出すると10万円になります(55万円の枠は廃止)。
                  65万円を受けるには申告書と決算書を期限内に e-Tax で提出してください。
                </p>
              )
            )}
          </div>
          <fieldset className="mb-4 rounded-lg border border-slate-200 p-3">
            <legend className="px-1 text-xs font-medium text-slate-600">勤め先の給与(源泉徴収票から・なければ空欄)</legend>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label htmlFor="sim-salary-gross" className="mb-1 block text-xs font-medium text-slate-500">
                  給与の収入金額(支払金額)
                </label>
                <input
                  id="sim-salary-gross"
                  type="number"
                  min={0}
                  className={`${input} w-full text-right`}
                  value={form.salaryGross || ''}
                  placeholder="0"
                  onChange={(e) => set({ salaryGross: num(e.target.value) })}
                />
                <p className="mt-0.5 text-[10px] leading-snug text-slate-500">
                  {form.salaryGross > 0
                    ? `給与所得 ${yen(result.salaryIncome)}(給与所得控除後。事業の赤字はここから差し引く)`
                    : '2か所以上から給与があれば合計額。給与所得控除は自動計算'}
                </p>
              </div>
              <div>
                <label htmlFor="sim-salary-withholding" className="mb-1 block text-xs font-medium text-slate-500">
                  給与の源泉徴収税額
                </label>
                <input
                  id="sim-salary-withholding"
                  type="number"
                  min={0}
                  className={`${input} w-full text-right`}
                  value={form.salaryWithholding || ''}
                  placeholder="0"
                  onChange={(e) => set({ salaryWithholding: num(e.target.value) })}
                />
                <p className="mt-0.5 text-[10px] leading-snug text-slate-500">
                  源泉徴収票の社会保険料・生命保険料などの控除額は、下の各控除欄に合算して入力
                </p>
              </div>
            </div>
          </fieldset>
          <div className="grid gap-3 sm:grid-cols-2">
            {FIELDS.map((f) => (
              <div key={f.key}>
                <label htmlFor={`sim-${f.key.replace(/([A-Z])/g, '-$1').toLowerCase()}`} className="mb-1 block text-xs font-medium text-slate-500" title={f.hint}>
                  {f.label}
                </label>
                <input
                  id={`sim-${f.key.replace(/([A-Z])/g, '-$1').toLowerCase()}`}
                  type="number"
                  min={0}
                  className={`${input} w-full text-right`}
                  value={form[f.key] || ''}
                  placeholder="0"
                  onChange={(e) => set({ [f.key]: num(e.target.value) } as Partial<DeductionEntry>)}
                />
                <p className="mt-0.5 text-[10px] leading-snug text-slate-500">{f.hint}</p>
              </div>
            ))}
            <div>
              <label htmlFor="sim-withholding" className="mb-1 block text-xs font-medium text-slate-500">報酬の源泉徴収税額</label>
              <input
                id="sim-withholding"
                type="number"
                min={0}
                className={`${input} w-full text-right`}
                value={form.withholding || ''}
                placeholder="0"
                onChange={(e) => set({ withholding: num(e.target.value) })}
              />
              {invoiceWithholding > 0 && (
                <button
                  type="button"
                  className="mt-1 text-[11px] font-medium text-blue-700 underline"
                  onClick={() => set({ withholding: invoiceWithholding })}
                >
                  請求書から集計({yen(invoiceWithholding)})を使う
                </button>
              )}
            </div>
            <div>
              <label htmlFor="sim-prepaid-tax" className="mb-1 block text-xs font-medium text-slate-500">
                予定納税額(第1期・第2期の合計)
              </label>
              <input
                id="sim-prepaid-tax"
                type="number"
                min={0}
                className={`${input} w-full text-right`}
                value={form.prepaidTax || ''}
                placeholder="0"
                onChange={(e) => set({ prepaidTax: num(e.target.value) })}
              />
              <p className="mt-0.5 text-[10px] leading-snug text-slate-500">
                前年の納税額が15万円以上だと7月・11月に納付する予定納税(通知書の金額)
              </p>
            </div>
            <div>
              <label htmlFor="sim-loss-carryforward" className="mb-1 block text-xs font-medium text-slate-500">
                繰り越された純損失(前年以前3年分)
              </label>
              <input
                id="sim-loss-carryforward"
                type="number"
                min={0}
                className={`${input} w-full text-right`}
                value={form.lossCarryforward || ''}
                placeholder="0"
                onChange={(e) => set({ lossCarryforward: num(e.target.value) })}
              />
              {lossSuggestion > 0 && lossSuggestion !== form.lossCarryforward ? (
                <button
                  type="button"
                  className="mt-1 text-[11px] font-medium text-blue-700 underline"
                  onClick={() => set({ lossCarryforward: lossSuggestion })}
                >
                  帳簿の赤字から計算({yen(lossSuggestion)})を使う
                </button>
              ) : (
                <p className="mt-0.5 text-[10px] leading-snug text-slate-500">
                  青色申告で赤字の年があれば、翌年から3年間の所得から差し引ける
                </p>
              )}
            </div>
          </div>
          <div className="mt-4">
            <button
              type="button"
              className={btn.primary}
              onClick={() => {
                onSave(form);
                setMessage(`${year}年分の控除入力を保存しました。`);
              }}
            >
              保存
            </button>
          </div>
        </Card>

        <Card title="計算の内訳">
          <table className="w-full text-sm">
            <tbody>
              <tr className="border-b border-slate-100">
                <td className="py-1.5 pr-2 text-slate-600">差引金額(青色申告特別控除前)</td>
                <td className="tabular py-1.5 text-right">{yen(profit)}</td>
              </tr>
              <tr className="border-b border-slate-100">
                <td className="py-1.5 pr-2 text-slate-600">青色申告特別控除</td>
                <td className="tabular py-1.5 text-right">−{yen(result.blueApplied)}</td>
              </tr>
              {form.salaryGross > 0 ? (
                <>
                  <tr className="border-b border-slate-100">
                    <td className="py-1.5 pr-2 text-slate-600">事業所得</td>
                    <td className="tabular py-1.5 text-right">{yen(result.businessIncome)}</td>
                  </tr>
                  <tr className="border-b border-slate-100">
                    <td className="py-1.5 pr-2 text-slate-600">
                      給与所得(収入 {yen(form.salaryGross)} − 給与所得控除)
                    </td>
                    <td className="tabular py-1.5 text-right">{yen(result.salaryIncome)}</td>
                  </tr>
                  <tr className="border-b border-slate-200 font-medium">
                    <td className="py-1.5 pr-2">合計所得金額</td>
                    <td className="tabular py-1.5 text-right">{yen(result.totalIncome)}</td>
                  </tr>
                </>
              ) : (
                <tr className="border-b border-slate-200 font-medium">
                  <td className="py-1.5 pr-2">事業所得(合計所得金額)</td>
                  <td className="tabular py-1.5 text-right">{yen(result.totalIncome)}</td>
                </tr>
              )}
              {result.lossApplied > 0 && (
                <>
                  <tr className="border-b border-slate-100">
                    <td className="py-1.5 pr-2 text-slate-600">純損失の繰越控除</td>
                    <td className="tabular py-1.5 text-right">−{yen(result.lossApplied)}</td>
                  </tr>
                  <tr className="border-b border-slate-200 font-medium">
                    <td className="py-1.5 pr-2">総所得金額等</td>
                    <td className="tabular py-1.5 text-right">{yen(result.incomeAfterLoss)}</td>
                  </tr>
                </>
              )}
              {result.breakdown.map((l) => (
                <tr key={l.label} className="border-b border-slate-100">
                  <td className="py-1.5 pr-2 text-slate-600">{l.label}</td>
                  <td className="tabular py-1.5 text-right">−{yen(l.amount)}</td>
                </tr>
              ))}
              <tr className="border-b border-slate-200 font-medium">
                <td className="py-1.5 pr-2">課税所得(千円未満切捨て)</td>
                <td className="tabular py-1.5 text-right">{yen(result.taxable)}</td>
              </tr>
              <tr className="border-b border-slate-100">
                <td className="py-1.5 pr-2 text-slate-600">所得税(速算表)</td>
                <td className="tabular py-1.5 text-right">{yen(result.incomeTax)}</td>
              </tr>
              <tr className="border-b border-slate-100">
                <td className="py-1.5 pr-2 text-slate-600">復興特別所得税(2.1%)</td>
                <td className="tabular py-1.5 text-right">{yen(result.reconstructionTax)}</td>
              </tr>
              <tr className="border-b border-slate-100">
                <td className="py-1.5 pr-2 text-slate-600">源泉徴収税額{form.salaryWithholding > 0 ? '(報酬 + 給与)' : ''}</td>
                <td className="tabular py-1.5 text-right">−{yen(result.withholdingTotal)}</td>
              </tr>
              {form.prepaidTax > 0 && (
                <>
                  <tr className="border-b border-slate-100">
                    <td className="py-1.5 pr-2 text-slate-600">申告納税額(100円未満切捨て)</td>
                    <td className="tabular py-1.5 text-right">{yen(result.filingTax)}</td>
                  </tr>
                  <tr className="border-b border-slate-100">
                    <td className="py-1.5 pr-2 text-slate-600">予定納税額(第1期・第2期)</td>
                    <td className="tabular py-1.5 text-right">−{yen(form.prepaidTax)}</td>
                  </tr>
                </>
              )}
              <tr className="bg-emerald-50/60 font-bold text-emerald-800">
                <td className="py-2 pr-2">
                  {result.balanceDue >= 0 ? '納付見込み(第3期分の税額)' : '還付見込み'}
                </td>
                <td className="tabular py-2 text-right">{yen(Math.abs(result.balanceDue))}</td>
              </tr>
            </tbody>
          </table>

          <div className="mt-4 grid grid-cols-2 gap-3">
            <div className="rounded-lg bg-slate-50 p-3 text-sm">
              <div className="text-xs text-slate-500">住民税の概算(翌年度)</div>
              <div className="tabular mt-1 font-semibold">{yen(result.residentTaxEst)}</div>
              <div className="mt-1 text-[10px] text-slate-500">所得割10% + 均等割約5,000円の目安</div>
            </div>
            <div className="rounded-lg bg-slate-50 p-3 text-sm">
              <div className="text-xs text-slate-500">個人事業税の概算</div>
              <div className="tabular mt-1 font-semibold">{yen(result.businessTaxEst)}</div>
              <div className="mt-1 text-[10px] text-slate-500">事業主控除290万円・税率5%の業種の場合</div>
            </div>
          </div>

          <ul className="mt-4 list-disc space-y-1 pl-5 text-xs leading-relaxed text-slate-500">
            <li>
              基礎控除は<strong>令和8年度税制改正に対応</strong>
              (2025年分は58万円+上乗せ、2026・2027年分は合計所得489万円以下104万円・655万円以下67万円・それ超62万円、2028年分以後は62万円〔132万円以下は99万円〕)。年分に応じて自動で切り替わります。
            </li>
            <li>
              事業所得と給与所得を前提とした概算です(給与所得は所得税法別表第五と同じ計算。所得金額調整控除・
              その他の所得・税額控除〔住宅ローン控除等〕は未対応)。
            </li>
            {result.lossToCarry > 0 && (
              <li className="font-medium text-amber-800">
                翌年以後に繰り越せる純損失は{yen(result.lossToCarry)}です(青色申告のみ。損失の年の翌年から3年間)。
                申告書第四表(損失申告用)の提出が必要です。
              </li>
            )}
            <li>住民税は基礎控除だけ住民税の額(43万円)に置き換えて概算しています。扶養控除など他の控除額の差(住民税33万円など)は反映していないため、あくまで目安です。</li>
            <li>国民健康保険料・国民年金は含まれません。最終的な申告は国税庁の確定申告書等作成コーナーで確認してください。</li>
          </ul>
        </Card>
      </div>
    </>
  );
}
