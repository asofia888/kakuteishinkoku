'use client';

import React, { useMemo, useState } from 'react';
import { Alert, btn, Card, EmptyState, input, PageHeader, selectCls, StatCard } from '@/components/ui';
import { availableYears } from '@/lib/aggregate';
import { downloadText } from '@/lib/csv';
import { dateLabel, today, yen } from '@/lib/format';
import { buildBalanceSheet } from '@/lib/ledger';
import { payrollLedgerCsv, SALARY_TABLE_LABELS, salaryWithholding } from '@/lib/payroll';
import { salaryWithholdingFor } from '@/lib/taxparams';
import { useStore } from '@/lib/store';
import { SalaryTableType } from '@/lib/types';

export default function PayrollPage() {
  const store = useStore();
  const [year, setYear] = useState(() => new Date().getFullYear());
  const [message, setMessage] = useState<string | null>(null);

  // フォーム
  const [employee, setEmployee] = useState('');
  const [date, setDate] = useState(today());
  const [gross, setGross] = useState('');
  const [socialInsurance, setSocialInsurance] = useState('0');
  const [table, setTable] = useState<SalaryTableType>('kou');
  const [withholding, setWithholding] = useState('0');
  const [note, setNote] = useState('');

  // 納付フォーム
  const [payDate, setPayDate] = useState(today());
  const [payAmount, setPayAmount] = useState('');

  const years = useMemo(
    () => availableYears(store.transactions, new Date().getFullYear()),
    [store.transactions],
  );

  const employees = useMemo(
    () => [...new Set(store.payrolls.map((p) => p.employee))],
    [store.payrolls],
  );

  const inYear = useMemo(
    () =>
      store.payrolls
        .filter((p) => p.date.startsWith(`${year}-`))
        .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt),
    [store.payrolls, year],
  );
  const totals = useMemo(
    () =>
      inYear.reduce(
        (acc, p) => ({
          gross: acc.gross + p.gross,
          si: acc.si + (p.socialInsurance ?? 0),
          withholding: acc.withholding + p.withholding,
        }),
        { gross: 0, si: 0, withholding: 0 },
      ),
    [inYear],
  );

  // 預り金の現在残高(今年の貸借対照表の期末値)
  const depositBalance = useMemo(() => {
    const y = new Date().getFullYear();
    const bs = buildBalanceSheet(
      store.transactions,
      y,
      store.openingBalances.find((ob) => ob.year === y),
      store.assets,
      store.inventories,
    );
    return bs.liabilities.find((r) => r.id === 'deposit')?.closing ?? 0;
  }, [store.transactions, store.openingBalances, store.assets, store.inventories]);

  const grossNum = Math.round(Number(gross)) || 0;
  const siNum = Math.min(Math.max(0, Math.round(Number(socialInsurance)) || 0), grossNum);
  // 源泉徴収税額表の判定は「社会保険料等控除後の給与」と支払年分の税額表で行う
  const payYear = Number(date.slice(0, 4)) || new Date().getFullYear();
  const taxable = grossNum - siNum;
  const lines = salaryWithholdingFor(payYear);
  const auto = table === 'manual' ? null : salaryWithholding(taxable, table, payYear);
  const needsTable = table !== 'manual' && auto === null && grossNum > 0;
  const effectiveWithholding =
    table !== 'manual' && auto !== null ? auto : Math.round(Number(withholding)) || 0;

  const save = () => {
    if (!employee.trim() || !date || grossNum <= 0) return;
    const w = Math.min(effectiveWithholding, grossNum - siNum);
    store.registerPayroll({
      employee: employee.trim(),
      date,
      gross: grossNum,
      withholding: w,
      ...(siNum > 0 ? { socialInsurance: siNum } : {}),
      table,
      ...(note.trim() ? { note: note.trim() } : {}),
    });
    setMessage(
      `給与を記帳しました(総支給 ${yen(grossNum)}` +
        (siNum > 0 ? `・社会保険料等 ${yen(siNum)}` : '') +
        `・源泉 ${yen(w)})。` +
        (w > 0 || siNum > 0
          ? ' 源泉・社会保険料等の天引き分は「預り金」に計上されました。納付したら下の「預り金の納付」で記帳してください。'
          : ''),
    );
    setGross('');
    setSocialInsurance('0');
    setWithholding('0');
    setNote('');
  };

  if (!store.ready) {
    return <div className="py-24 text-center text-sm text-slate-500">読み込み中…</div>;
  }

  return (
    <>
      <PageHeader
        title="給与(源泉・預り金)"
        description="バイト代・給与の支払いを記帳します。総支給額と源泉徴収税額から、手取りの支払いと預り金(源泉所得税)の複式仕訳を自動起票し、賃金台帳CSVも出力できます。"
      />
      <div className="space-y-6">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <StatCard label={`${year}年の給与 総支給額`} value={yen(totals.gross)} />
          <StatCard label={`${year}年の源泉徴収 合計`} value={yen(totals.withholding)} />
          <StatCard
            label="預り金の残高(未納付の源泉・社保等)"
            value={yen(depositBalance)}
            tone={depositBalance > 0 ? 'primary' : 'muted'}
            sub="貸借対照表の「預り金」"
          />
        </div>

        {message && <Alert tone="success">{message}</Alert>}

        <Card title="給与を記帳">
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label htmlFor="pay-employee" className="mb-1 block text-xs font-medium text-slate-500">従業員名 *</label>
              <input
                id="pay-employee"
                type="text"
                className={`${input} w-40`}
                list="employee-list"
                value={employee}
                onChange={(e) => setEmployee(e.target.value)}
              />
              <datalist id="employee-list">
                {employees.map((e) => (
                  <option key={e} value={e} />
                ))}
              </datalist>
            </div>
            <div>
              <label htmlFor="pay-date" className="mb-1 block text-xs font-medium text-slate-500">支払日 *</label>
              <input id="pay-date" type="date" className={input} value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            <div>
              <label htmlFor="pay-gross" className="mb-1 block text-xs font-medium text-slate-500">総支給額 *</label>
              <input
                id="pay-gross"
                type="number"
                min={1}
                className={`${input} w-32 text-right`}
                value={gross}
                onChange={(e) => setGross(e.target.value)}
              />
            </div>
            <div>
              <label htmlFor="pay-social-insurance" className="mb-1 block text-xs font-medium text-slate-500">社会保険料等(天引き)</label>
              <input
                id="pay-social-insurance"
                type="number"
                min={0}
                className={`${input} w-28 text-right`}
                title="雇用保険料・社会保険料など給与から天引きする額。源泉徴収税額の判定はこの控除後の金額で行います"
                value={socialInsurance}
                onChange={(e) => setSocialInsurance(e.target.value)}
              />
            </div>
            <div>
              <label htmlFor="pay-table" className="mb-1 block text-xs font-medium text-slate-500">税額区分</label>
              <select
                id="pay-table"
                className={selectCls}
                value={table}
                onChange={(e) => setTable(e.target.value as SalaryTableType)}
              >
                <option value="kou">甲欄(扶養控除等申告書あり)</option>
                <option value="otsu">乙欄(申告書なし)</option>
                <option value="hei">丙欄(日雇い・2ヶ月以内)</option>
                <option value="manual">手入力</option>
              </select>
            </div>
            <div>
              <label htmlFor="pay-withholding" className="mb-1 block text-xs font-medium text-slate-500">源泉徴収税額</label>
              {table !== 'manual' && auto !== null ? (
                <div className={`${input} w-28 bg-slate-50 text-right text-slate-600`}>{yen(auto)}</div>
              ) : (
                <input
                  id="pay-withholding"
                  type="number"
                  min={0}
                  className={`${input} w-28 text-right`}
                  value={withholding}
                  onChange={(e) => setWithholding(e.target.value)}
                />
              )}
            </div>
            <div className="min-w-40 flex-1">
              <label htmlFor="pay-note" className="mb-1 block text-xs font-medium text-slate-500">備考(○月分など)</label>
              <input id="pay-note" type="text" className={`${input} w-full`} value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
            <button
              type="button"
              className={btn.primary}
              disabled={!employee.trim() || !date || grossNum <= 0 || needsTable}
              onClick={save}
            >
              記帳する
            </button>
          </div>
          {needsTable && (
            <div className="mt-3">
              <Alert tone="warning">
                社会保険料等控除後の給与({yen(taxable)})が{payYear}年分の自動計算の範囲(甲欄: 月
                {lines.monthlyZeroUnder.toLocaleString()}円未満0円 / 乙欄: 同未満3.063% / 丙欄: 日額
                {lines.dailyZeroUnder.toLocaleString()}円未満0円)を超えています。国税庁の
                <strong>源泉徴収税額表({payYear}年分)</strong>で税額を調べ、区分を「手入力」にして入力してください。
              </Alert>
            </div>
          )}
          <p className="mt-3 text-xs leading-relaxed text-slate-500">
            仕訳は「(借)給料賃金 総支給額 /(貸)普通預金 手取り +(貸)預り金 源泉・社会保険料等」で自動起票されます(取引一覧にも表示)。
            源泉徴収税額の判定は<strong>社会保険料等控除後の給与</strong>と<strong>支払年分の税額表</strong>で行います(2026年分から判定ラインが引き上げ)。
            人を雇うと「給与支払事務所等の開設届出書」の提出、賃金台帳の作成(労働日数・時間も記録)、
            労災保険の加入などの義務が生じます。源泉0円でも源泉徴収票の交付は必要です。
          </p>
        </Card>

        <Card
          title={`給与の記録(${year}年・${inYear.length}件)`}
          action={
            <div className="flex items-center gap-2">
              <select aria-label="表示する年" className={selectCls} value={year} onChange={(e) => setYear(Number(e.target.value))}>
                {years.map((y) => (
                  <option key={y} value={y}>
                    {y}年
                  </option>
                ))}
              </select>
              <button
                type="button"
                className={btn.small}
                disabled={inYear.length === 0}
                onClick={() => downloadText(`賃金台帳_${year}.csv`, payrollLedgerCsv(store.payrolls, year))}
              >
                ⬇ 賃金台帳CSV
              </button>
            </div>
          }
        >
          {inYear.length === 0 ? (
            <EmptyState>この年の給与の記録はありません。</EmptyState>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[860px] text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
                    <th className="py-2 pr-2 font-medium">支払日</th>
                    <th className="px-2 py-2 font-medium">従業員</th>
                    <th className="px-2 py-2 font-medium">区分</th>
                    <th className="px-2 py-2 text-right font-medium">総支給額</th>
                    <th className="px-2 py-2 text-right font-medium">社会保険料等</th>
                    <th className="px-2 py-2 text-right font-medium">源泉徴収</th>
                    <th className="px-2 py-2 text-right font-medium">差引支給額</th>
                    <th className="px-2 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {inYear.map((p) => (
                    <tr key={p.id} className="border-b border-slate-100 hover:bg-slate-50/60">
                      <td className="tabular py-2 pr-2 whitespace-nowrap">{dateLabel(p.date)}</td>
                      <td className="max-w-[140px] truncate px-2 py-2" title={p.note ?? ''}>
                        {p.employee}
                      </td>
                      <td className="px-2 py-2 text-xs whitespace-nowrap">{SALARY_TABLE_LABELS[p.table]}</td>
                      <td className="tabular px-2 py-2 text-right">{yen(p.gross)}</td>
                      <td className="tabular px-2 py-2 text-right">
                        {(p.socialInsurance ?? 0) > 0 ? yen(p.socialInsurance ?? 0) : '—'}
                      </td>
                      <td className="tabular px-2 py-2 text-right">
                        {p.withholding > 0 ? yen(p.withholding) : '—'}
                      </td>
                      <td className="tabular px-2 py-2 text-right font-medium">
                        {yen(p.gross - (p.socialInsurance ?? 0) - p.withholding)}
                      </td>
                      <td className="px-2 py-2 text-right">
                        <button
                          type="button"
                          className={btn.danger}
                          onClick={() => {
                            if (confirm(`${dateLabel(p.date)} の「${p.employee}」の給与記録を削除しますか?\n自動起票した取引も一緒に削除されます。`)) {
                              store.deletePayroll(p.id);
                            }
                          }}
                        >
                          削除
                        </button>
                      </td>
                    </tr>
                  ))}
                  <tr className="bg-slate-50 font-semibold">
                    <td className="py-2 pr-2" colSpan={3}>
                      合計
                    </td>
                    <td className="tabular px-2 py-2 text-right">{yen(totals.gross)}</td>
                    <td className="tabular px-2 py-2 text-right">{yen(totals.si)}</td>
                    <td className="tabular px-2 py-2 text-right">{yen(totals.withholding)}</td>
                    <td className="tabular px-2 py-2 text-right">
                      {yen(totals.gross - totals.si - totals.withholding)}
                    </td>
                    <td />
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card title="預り金の納付(源泉所得税・社会保険料等を納めたとき)">
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label htmlFor="pay-deposit-date" className="mb-1 block text-xs font-medium text-slate-500">納付日</label>
              <input id="pay-deposit-date" type="date" className={input} value={payDate} onChange={(e) => setPayDate(e.target.value)} />
            </div>
            <div>
              <label htmlFor="pay-deposit-amount" className="mb-1 block text-xs font-medium text-slate-500">納付額</label>
              <input
                id="pay-deposit-amount"
                type="number"
                min={1}
                className={`${input} w-32 text-right`}
                placeholder={depositBalance > 0 ? String(depositBalance) : ''}
                value={payAmount}
                onChange={(e) => setPayAmount(e.target.value)}
              />
            </div>
            <button
              type="button"
              className={btn.secondary}
              disabled={!payDate || (Math.round(Number(payAmount)) || 0) <= 0}
              onClick={() => {
                const n = Math.round(Number(payAmount));
                store.addTransactions([
                  {
                    date: payDate,
                    amount: n,
                    description: '源泉所得税の納付(預り金)',
                    type: 'expense',
                    account: 'deposit_payment',
                    approved: true,
                    source: 'manual',
                    fund: 'bank',
                  },
                ]);
                setPayAmount('');
                setMessage(`預り金の納付 ${yen(n)} を記帳しました((借)預り金 /(貸)普通預金)。`);
              }}
            >
              納付を記帳
            </button>
          </div>
          <p className="mt-3 text-xs leading-relaxed text-slate-500">
            源泉徴収した所得税は原則<strong>翌月10日</strong>までに納付します。従業員が常時10人未満なら
            「源泉所得税の納期の特例」の届出により<strong>年2回(1〜6月分→7月10日、7〜12月分→翌年1月20日)</strong>
            にまとめられます。納付書は「給与所得・退職所得等の所得税徴収高計算書」を使います。
          </p>
        </Card>
      </div>
    </>
  );
}
