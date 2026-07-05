'use client';

import React, { useMemo, useState } from 'react';
import { Alert, btn, Card, input, PageHeader, selectCls, StatCard } from '@/components/ui';
import { availableYears, summarizeYear } from '@/lib/aggregate';
import { yen } from '@/lib/format';
import { simulateIncomeTax } from '@/lib/incometax';
import { computeInvoiceTotals } from '@/lib/invoice';
import { useStore } from '@/lib/store';
import { DeductionEntry, emptyDeduction } from '@/lib/types';

/** 控除入力フィールドの定義(金額はすべて円) */
const FIELDS: {
  key: keyof Omit<DeductionEntry, 'year' | 'blueDeduction' | 'withholding'>;
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

  if (!store.ready) {
    return <div className="py-24 text-center text-sm text-slate-500">読み込み中…</div>;
  }

  return (
    <>
      <PageHeader
        title="所得税シミュレーション"
        description="帳簿の事業所得に所得控除を加味して、所得税・復興特別所得税の納付見込みを試算します(概算)。確定申告書の「所得から差し引かれる金額」の下書きにもなります。"
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
  onSave,
}: {
  year: number;
  profit: number;
  initial: DeductionEntry;
  invoiceWithholding: number;
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
          value={yen(result.totalIncome)}
          sub={`差引金額 ${yen(profit)} − 青色申告特別控除`}
        />
        <StatCard label="課税所得(控除後・千円未満切捨て)" value={yen(result.taxable)} />
        <StatCard
          label="所得税+復興特別所得税"
          value={yen(result.totalTax)}
          sub={`所得税 ${yen(result.incomeTax)} + 復興税 ${yen(result.reconstructionTax)}`}
          tone="primary"
        />
        <StatCard
          label={result.balanceDue >= 0 ? '納付見込み(源泉差引後)' : '還付見込み'}
          value={yen(Math.abs(result.balanceDue))}
          sub={`源泉徴収税額 ${yen(form.withholding)}`}
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
              <option value={650000}>65万円(複式簿記 + e-Tax申告等)</option>
              <option value={550000}>55万円(複式簿記・書面提出)</option>
              <option value={100000}>10万円(簡易簿記)</option>
            </select>
          </div>
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
              <label htmlFor="sim-withholding" className="mb-1 block text-xs font-medium text-slate-500">源泉徴収税額</label>
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
              <tr className="border-b border-slate-200 font-medium">
                <td className="py-1.5 pr-2">事業所得(合計所得金額)</td>
                <td className="tabular py-1.5 text-right">{yen(result.totalIncome)}</td>
              </tr>
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
                <td className="py-1.5 pr-2 text-slate-600">源泉徴収税額</td>
                <td className="tabular py-1.5 text-right">−{yen(form.withholding)}</td>
              </tr>
              <tr className="bg-emerald-50/60 font-bold text-emerald-800">
                <td className="py-2 pr-2">{result.balanceDue >= 0 ? '納付見込み(100円未満切捨て)' : '還付見込み'}</td>
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
              基礎控除は<strong>令和7年度税制改正に対応</strong>
              (2025年分以降58万円、合計所得132万円以下は95万円、2025・2026年分は中間所得層への時限上乗せ)。年分に応じて自動で切り替わります。
            </li>
            <li>事業所得のみを前提とした概算です(給与所得・予定納税・税額控除〔住宅ローン控除等〕は未対応)。</li>
            <li>住民税は基礎控除だけ住民税の額(43万円)に置き換えて概算しています。扶養控除など他の控除額の差(住民税33万円など)は反映していないため、あくまで目安です。</li>
            <li>国民健康保険料・国民年金は含まれません。最終的な申告は国税庁の確定申告書等作成コーナーで確認してください。</li>
          </ul>
        </Card>
      </div>
    </>
  );
}
