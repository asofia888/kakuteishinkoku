'use client';

import React, { useMemo, useState } from 'react';
import { Alert, Card, PageHeader, selectCls, StatCard } from '@/components/ui';
import { availableYears } from '@/lib/aggregate';
import { yen } from '@/lib/format';
import { useStore } from '@/lib/store';
import {
  calcTaxReturn,
  DEEMED_PURCHASE_RATES,
  SIMPLIFIED_TYPES,
  summarizeTax,
  TAXABLE_THRESHOLD,
} from '@/lib/tax';
import { TaxSettings } from '@/lib/types';

const METHODS: { id: TaxSettings['method']; label: string; hint: string }[] = [
  {
    id: 'general',
    label: '本則課税(一般課税)',
    hint: '売上の消費税 − 仕入の消費税(適格請求書が必要。適格なし分は経過措置で80%/50%のみ控除)',
  },
  {
    id: 'simplified',
    label: '簡易課税',
    hint: '売上の消費税 × みなし仕入率で控除を概算(基準期間の課税売上5,000万円以下・事前届出が必要)',
  },
  {
    id: 'special20',
    label: '2割特例',
    hint: '売上の消費税 × 20% を納付(インボイス登録を機に課税事業者になった小規模事業者向け・届出不要。個人は2026年分の申告まで)',
  },
];

export default function TaxPage() {
  const store = useStore();
  const [year, setYear] = useState(() => new Date().getFullYear());

  const years = useMemo(
    () => availableYears(store.transactions, new Date().getFullYear()),
    [store.transactions],
  );

  const settings = store.taxSettings;
  const summary = useMemo(
    () => summarizeTax(store.transactions, year, settings),
    [store.transactions, year, settings],
  );
  // 申告書様式(割戻し計算・国税/地方分離・法定の端数処理)での計算
  const taxReturn = useMemo(
    () => calcTaxReturn(store.transactions, year, settings),
    [store.transactions, year, settings],
  );

  const taxableSales = summary.sales10 + summary.sales8;

  if (!store.ready) {
    return <div className="py-24 text-center text-sm text-slate-500">読み込み中…</div>;
  }

  return (
    <>
      <PageHeader
        title="消費税(インボイス)"
        description="税込経理を前提に、税区分別の集計と納付税額の試算を行います。税区分は科目から自動判定され、取引一覧で個別に変更できます。"
      />

      <div className="space-y-6">
        <Card title="消費税の設定">
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={settings.taxable}
              onChange={(e) => store.updateTaxSettings({ taxable: e.target.checked })}
            />
            課税事業者である(インボイス発行事業者に登録している)
          </label>
          {!settings.taxable && (
            <p className="mt-2 text-xs leading-relaxed text-slate-500">
              免税事業者の間は申告・納付は不要です(下の集計は参考表示)。基準期間(2年前)の課税売上高が1,000万円を超えると課税事業者になります。
            </p>
          )}

          <div className={`mt-4 space-y-2 ${settings.taxable ? '' : 'opacity-50'}`}>
            {METHODS.map((m) => (
              <label key={m.id} className="flex items-start gap-2 text-sm text-slate-700">
                <input
                  type="radio"
                  name="tax-method"
                  className="mt-0.5"
                  checked={settings.method === m.id}
                  disabled={!settings.taxable}
                  onChange={() => store.updateTaxSettings({ method: m.id })}
                />
                <span>
                  <span className="font-medium">{m.label}</span>
                  <span className="block text-xs text-slate-500">{m.hint}</span>
                </span>
              </label>
            ))}
            {settings.method === 'simplified' && (
              <div className="ml-6">
                <label htmlFor="tax-simplified-type" className="mb-1 block text-xs font-medium text-slate-500">
                  事業区分(みなし仕入率)
                </label>
                <select
                  id="tax-simplified-type"
                  className={selectCls}
                  value={settings.simplifiedType}
                  disabled={!settings.taxable}
                  onChange={(e) =>
                    store.updateTaxSettings({
                      simplifiedType: Number(e.target.value) as TaxSettings['simplifiedType'],
                    })
                  }
                >
                  {SIMPLIFIED_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
        </Card>

        <div className="flex items-center gap-3">
          <select
            aria-label="対象年度"
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
          {!settings.taxable && (
            <span className="text-xs text-slate-500">免税事業者のため参考表示です</span>
          )}
        </div>

        {!settings.taxable && taxableSales > TAXABLE_THRESHOLD && (
          <Alert tone="warning">
            {year}年の課税売上高が<strong>1,000万円を超えています</strong>(
            {yen(taxableSales)})。原則として{year + 2}
            年から課税事業者になります(納税資金の準備と、簡易課税・2割特例の検討を)。
          </Alert>
        )}

        {settings.taxable && settings.method === 'special20' && !summary.special20Available && (
          <Alert tone="warning">
            <strong>2割特例は{year}年分には適用できません</strong>
            (個人事業者は2026年分の申告が最後です)。この年分の納付見込みは
            <strong>本則課税</strong>で表示しています。簡易課税を使う場合は事前の届出が必要です。
          </Alert>
        )}

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            label="課税売上(税込)"
            value={yen(taxableSales)}
            sub={`10%: ${yen(summary.sales10)}${summary.sales8 > 0 ? ` / 軽減8%: ${yen(summary.sales8)}` : ''}`}
          />
          <StatCard label="売上に係る消費税" value={yen(summary.salesTax)} tone="primary" />
          <StatCard
            label="課税仕入(税込・事業分)"
            value={yen(summary.purchase10 + summary.purchase8)}
            sub="家事按分後の経費計上分のみ"
          />
          <StatCard
            label={`納付見込み(${
              settings.method === 'special20' && !summary.special20Available
                ? '本則課税・2割特例は対象外'
                : (METHODS.find((m) => m.id === settings.method)?.label ?? '')
            })`}
            value={yen(Math.max(0, summary.paySelected))}
            sub={summary.paySelected < 0 ? `還付見込み ${yen(-summary.paySelected)}` : undefined}
            tone="positive"
          />
        </div>

        <Card title={`納付税額の試算(${year}年分・3方式の比較)`}>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
                  <th className="py-2 pr-2 font-medium">方式</th>
                  <th className="px-2 py-2 text-right font-medium">売上の消費税</th>
                  <th className="px-2 py-2 text-right font-medium">控除額</th>
                  <th className="px-2 py-2 text-right font-medium">納付見込み</th>
                </tr>
              </thead>
              <tbody>
                {(
                  [
                    {
                      id: 'general',
                      label: '本則課税',
                      deduction: summary.deductibleTax,
                      pay: summary.payGeneral,
                    },
                    {
                      id: 'simplified',
                      label: `簡易課税(第${settings.simplifiedType}種・みなし仕入率${DEEMED_PURCHASE_RATES[settings.simplifiedType]}%)`,
                      deduction: summary.salesTax - summary.paySimplified,
                      pay: summary.paySimplified,
                    },
                    {
                      id: 'special20',
                      label: '2割特例',
                      deduction: summary.salesTax - summary.paySpecial20,
                      pay: summary.paySpecial20,
                    },
                  ] as const
                ).map((row) => {
                  const expired = row.id === 'special20' && !summary.special20Available;
                  return (
                    <tr
                      key={row.id}
                      className={`border-b border-slate-100 ${row.id === settings.method && !expired ? 'bg-blue-50/60 font-medium' : ''} ${expired ? 'text-slate-500' : ''}`}
                    >
                      <td className="py-2 pr-2">
                        {row.label}
                        {row.id === settings.method && !expired && (
                          <span className="ml-2 rounded bg-blue-100 px-1.5 py-0.5 text-[10px] font-medium text-blue-700">
                            選択中
                          </span>
                        )}
                      </td>
                      {expired ? (
                        <td className="px-2 py-2 text-right text-xs" colSpan={3}>
                          この年分は対象外(個人は2026年分まで)
                        </td>
                      ) : (
                        <>
                          <td className="tabular px-2 py-2 text-right">{yen(summary.salesTax)}</td>
                          <td className="tabular px-2 py-2 text-right">{yen(row.deduction)}</td>
                          <td className="tabular px-2 py-2 text-right font-semibold">
                            {row.pay < 0 ? `還付 ${yen(-row.pay)}` : yen(row.pay)}
                          </td>
                        </>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {settings.method === 'general' && summary.nonQualifiedCount > 0 && (
            <div className="mt-4">
              <Alert tone="warning">
                適格請求書<strong>なし</strong>の課税仕入が{summary.nonQualifiedCount}
                件あります。経過措置(2026年9月まで80%・2029年9月まで50%)適用後、
                <strong>{yen(summary.nonQualifiedLostTax)}</strong> が控除できません。
              </Alert>
            </div>
          )}

          <ul className="mt-4 list-disc space-y-1.5 pl-5 text-xs leading-relaxed text-slate-500">
            <li>
              帳簿は<strong>税込経理方式</strong>を前提に、税込金額から消費税額を割り戻した
              <strong>概算</strong>です。申告書の様式どおり(国税7.8%/6.24%と地方消費税の分離・法定の端数処理)の金額は、下の
              <strong>「申告書ベースの計算」</strong>をご覧ください。
            </li>
            <li>
              <strong>2割特例</strong>は、インボイス登録がなければ免税事業者だった小規模事業者(基準期間の課税売上高1,000万円以下など)が対象です(2026年9月30日を含む課税期間まで)。
            </li>
            <li>
              軽減税率(8%)の売上・仕入がある場合は、取引一覧の税区分で「課税
              8%(軽減)」に変更してください。飲食料品・定期購読の新聞などが対象です。
            </li>
            <li>
              自宅家賃の按分は<strong>住宅の貸付け(非課税)</strong>
              のため、該当する地代家賃の取引は税区分を「非課税」に変更してください(事務所・コワーキングは課税のままで構いません)。
            </li>
            <li>納付見込みには所得税・住民税は含まれません。最終判断は税理士等にご確認ください。</li>
          </ul>
        </Card>

        <Card
          title={`申告書ベースの計算(${year}年分・${
            taxReturn.applied === 'general'
              ? '本則課税'
              : taxReturn.applied === 'simplified'
                ? `簡易課税 第${settings.simplifiedType}種`
                : '2割特例'
          }・割戻し計算)`}
        >
          <p className="mb-3 text-xs leading-relaxed text-slate-500">
            消費税及び地方消費税の確定申告書(一般用/簡易課税用)の計算順に、法定の端数処理で計算した金額です。
            上の試算(10%割り戻しの概算)と数百円〜数千円ずれるのは端数処理と国税/地方の分離によるものです。
          </p>
          <table className="w-full max-w-2xl text-sm">
            <tbody>
              <tr className="border-b border-slate-100">
                <td className="py-1.5 pr-2">課税標準額(千円未満切捨て)</td>
                <td className="tabular px-2 py-1.5 text-right">{yen(taxReturn.baseTotal)}</td>
                <td className="py-1.5 pl-2 text-xs text-slate-500">
                  10%分: {yen(taxReturn.base10)}
                  {taxReturn.base8 > 0 ? ` / 軽減8%分: ${yen(taxReturn.base8)}` : ''}
                </td>
              </tr>
              <tr className="border-b border-slate-100">
                <td className="py-1.5 pr-2">消費税額(国税 7.8%・6.24%)</td>
                <td className="tabular px-2 py-1.5 text-right">{yen(taxReturn.salesTaxNational)}</td>
                <td className="py-1.5 pl-2 text-xs text-slate-500">
                  10%分: {yen(taxReturn.tax10)}
                  {taxReturn.tax8 > 0 ? ` / 軽減8%分: ${yen(taxReturn.tax8)}` : ''}
                </td>
              </tr>
              <tr className="border-b border-slate-100">
                <td className="py-1.5 pr-2">控除対象仕入税額(国税)</td>
                <td className="tabular px-2 py-1.5 text-right">{yen(taxReturn.deductibleNational)}</td>
                <td className="py-1.5 pl-2 text-xs text-slate-500">
                  {taxReturn.applied === 'general'
                    ? '適格分は全額・適格なしは経過措置80%/50%'
                    : taxReturn.applied === 'simplified'
                      ? `売上の消費税 × みなし仕入率${DEEMED_PURCHASE_RATES[settings.simplifiedType]}%`
                      : '特別控除(売上の消費税 × 80%)'}
                </td>
              </tr>
              <tr className="border-b border-slate-100 font-medium">
                <td className="py-1.5 pr-2">
                  {taxReturn.netNational >= 0 ? '差引税額(百円未満切捨て)' : '控除不足還付税額'}
                </td>
                <td className="tabular px-2 py-1.5 text-right">
                  {taxReturn.netNational >= 0
                    ? yen(taxReturn.netNational)
                    : `還付 ${yen(-taxReturn.netNational)}`}
                </td>
                <td className="py-1.5 pl-2 text-xs font-normal text-slate-500">消費税(国税)の納付額</td>
              </tr>
              <tr className="border-b border-slate-100">
                <td className="py-1.5 pr-2">地方消費税(譲渡割額)</td>
                <td className="tabular px-2 py-1.5 text-right">
                  {taxReturn.localTax >= 0 ? yen(taxReturn.localTax) : `還付 ${yen(-taxReturn.localTax)}`}
                </td>
                <td className="py-1.5 pl-2 text-xs text-slate-500">差引税額 × 22/78(百円未満切捨て)</td>
              </tr>
              <tr className="bg-slate-50 font-semibold">
                <td className="py-2 pr-2">消費税及び地方消費税の合計{taxReturn.totalDue >= 0 ? '(納付)' : '(還付)'}</td>
                <td className="tabular px-2 py-2 text-right">{yen(Math.abs(taxReturn.totalDue))}</td>
                <td className="py-2 pl-2 text-xs font-normal text-slate-500">申告書に転記する最終額の目安</td>
              </tr>
            </tbody>
          </table>
          <ul className="mt-3 list-disc space-y-1 pl-5 text-xs leading-relaxed text-slate-500">
            <li>税込経理・<strong>割戻し計算</strong>(総額計算)前提です。適格請求書の税額を1枚ずつ積み上げる「積上げ計算」を選んでいる場合は一致しません。</li>
            <li>売上対価の返還等・貸倒れ・中間納付額・簡易課税の複数事業区分には対応していません。該当がある場合は申告書上で調整してください。</li>
          </ul>
        </Card>
      </div>
    </>
  );
}
