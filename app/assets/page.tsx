'use client';

import React, { useMemo, useState } from 'react';
import { Alert, btn, Card, EmptyState, input, ModalShell, PageHeader, selectCls, StatCard } from '@/components/ui';
import { availableYears, DEPRECIATION_MIN, transactionsOfYear } from '@/lib/aggregate';
import {
  acquisitionsInYear,
  bookValueAtEnd,
  depreciationForYear,
  depreciationSchedule,
  depreciationTableCsv,
  isDeferred,
  METHOD_LABELS,
  straightLineRate,
  USEFUL_LIFE_PRESETS,
  yearDepreciationTotals,
} from '@/lib/assets';
import { downloadText } from '@/lib/csv';
import { SMALL_ASSET } from '@/lib/taxparams';
import { dateLabel, today, yen } from '@/lib/format';
import { useStore } from '@/lib/store';
import { DepreciationMethod, FixedAsset } from '@/lib/types';

type AssetDraft = Omit<FixedAsset, 'id' | 'createdAt'> & { id?: string };

function newDraft(): AssetDraft {
  return {
    name: '',
    acquiredDate: today(),
    cost: 0,
    method: 'straight',
    usefulLife: 4,
    businessRatio: 100,
    memo: '',
    disposedDate: '',
  };
}

export default function AssetsPage() {
  const store = useStore();
  const [year, setYear] = useState(() => new Date().getFullYear());
  const [draft, setDraft] = useState<AssetDraft | null>(null);
  const [scheduleFor, setScheduleFor] = useState<FixedAsset | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const years = useMemo(
    () => availableYears(store.transactions, new Date().getFullYear()),
    [store.transactions],
  );

  const totals = useMemo(() => yearDepreciationTotals(store.assets, year), [store.assets, year]);

  // 「固定資産の取得」取引と台帳の当年取得額の照合(不一致だと貸借対照表が合わない)
  const purchaseTxTotal = useMemo(
    () =>
      transactionsOfYear(store.transactions, year)
        .filter((t) => t.account === 'asset_purchase')
        .reduce((s, t) => s + t.amount, 0),
    [store.transactions, year],
  );
  // 開業費(繰延資産)は計上仕訳が自動起票されるため、取得取引との照合対象から外す
  const registerCostTotal = useMemo(
    () =>
      acquisitionsInYear(store.assets, year)
        .filter((a) => !isDeferred(a))
        .reduce((s, a) => s + a.cost, 0),
    [store.assets, year],
  );

  const bookTotal = useMemo(
    () => store.assets.reduce((s, a) => s + bookValueAtEnd(a, year), 0),
    [store.assets, year],
  );

  // 少額減価償却資産の特例は年合計300万円まで(超過分は適用不可)
  const immediateTotal = useMemo(
    () =>
      acquisitionsInYear(store.assets, year)
        .filter((a) => a.method === 'immediate')
        .reduce((s, a) => s + a.cost, 0),
    [store.assets, year],
  );

  // 償却資産税(固定資産税)の申告対象になりうる資産の取得価額合計(目安)。
  // 定額法・少額特例は対象、一括償却資産(3年均等)と繰延資産は対象外
  const shokyakuShisanCost = useMemo(
    () =>
      store.assets
        .filter((a) => (a.method === 'straight' || a.method === 'immediate') && !a.disposedDate)
        .reduce((s, a) => s + a.cost, 0),
    [store.assets],
  );

  if (!store.ready) {
    return <div className="py-24 text-center text-sm text-slate-500">読み込み中…</div>;
  }

  return (
    <>
      <PageHeader
        title="固定資産台帳(減価償却)"
        description="10万円以上の備品・車両などを登録すると、耐用年数から減価償却費を自動計算し、経費・仕訳帳・貸借対照表へ反映します。青色申告決算書「減価償却費の計算」欄のCSVも出力できます。"
      />

      <div className="space-y-6">
        <div className="flex flex-wrap items-center gap-3">
          <select aria-label="年分を選択" className={selectCls} value={year} onChange={(e) => setYear(Number(e.target.value))}>
            {years.map((y) => (
              <option key={y} value={y}>
                {y}年分
              </option>
            ))}
          </select>
          {!draft && (
            <button type="button" className={btn.primary} onClick={() => setDraft(newDraft())}>
              ＋ 資産を登録
            </button>
          )}
        </div>

        {message && <Alert tone="success">{message}</Alert>}

        {immediateTotal > SMALL_ASSET.immediateYearCap && (
          <Alert tone="warning">
            {year}年の<strong>少額減価償却資産の特例(全額計上)の合計が {yen(immediateTotal)}</strong>{' '}
            になり、上限の<strong>年300万円を超えています</strong>。超過分の資産には特例を適用できません。
            300万円に収まるよう資産を選び、超過分は「定額法」(取得価額20万円未満なら「一括償却」も可)に変更してください。
          </Alert>
        )}

        {registerCostTotal !== purchaseTxTotal && (registerCostTotal > 0 || purchaseTxTotal > 0) && (
          <Alert tone="warning">
            {year}年の台帳の取得価額合計は <strong>{yen(registerCostTotal)}</strong>
            、取引一覧の「固定資産の取得(振替)」は <strong>{yen(purchaseTxTotal)}</strong>{' '}
            で一致していません。購入の支払い行の科目を「固定資産の取得(振替)」にする(またはその金額で台帳に登録する)と、貸借対照表がぴったり一致します。
            ※開業前から保有する資産を登録した場合など、支払いが帳簿外のときはこの差は問題ありません。
          </Alert>
        )}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard label={`${year}年の償却費(全額)`} value={yen(totals.total)} />
          <StatCard
            label={`${year}年の必要経費算入額`}
            value={yen(totals.business)}
            sub={totals.total > totals.business ? `家事分 ${yen(totals.total - totals.business)} は事業主貸` : undefined}
            tone="primary"
          />
          <StatCard label={`${year}年末の未償却残高合計`} value={yen(bookTotal)} sub="貸借対照表の「減価償却資産」" />
          <StatCard
            label={`${year}年の少額特例 合計(上限300万円)`}
            value={yen(immediateTotal)}
            sub={immediateTotal > SMALL_ASSET.immediateYearCap ? '⚠ 上限超過 — 超過分は適用不可' : '青色申告の少額減価償却資産の特例'}
            tone={immediateTotal > SMALL_ASSET.immediateYearCap ? 'default' : 'muted'}
          />
        </div>

        {shokyakuShisanCost >= SMALL_ASSET.shokyakuShisanExemption && (
          <Alert tone="info">
            償却資産税の対象になりうる資産(定額法・少額特例)の取得価額合計が{' '}
            <strong>{yen(shokyakuShisanCost)}</strong> です。課税標準(評価額)が
            <strong>150万円以上</strong>になると固定資産税(償却資産)が課税されます(毎年1月末までに市区町村へ
            償却資産申告)。評価額は取得価額より小さくなるためこの金額は目安ですが、申告の要否をご確認ください。
            ※一括償却資産(3年均等)と繰延資産は償却資産税の対象外です。
          </Alert>
        )}

        {draft && (
          <AssetForm
            draft={draft}
            onChange={setDraft}
            onCancel={() => setDraft(null)}
            onSave={() => {
              const clean: Omit<FixedAsset, 'id' | 'createdAt'> = {
                name: draft.name.trim(),
                acquiredDate: draft.acquiredDate,
                cost: Math.round(draft.cost),
                method: draft.method,
                usefulLife: Math.min(100, Math.max(2, Math.round(draft.usefulLife || 4))),
                businessRatio: Math.min(100, Math.max(1, Math.round(draft.businessRatio))),
                ...(draft.memo?.trim() ? { memo: draft.memo.trim() } : {}),
                ...(draft.method !== 'deferred' && draft.disposedDate
                  ? { disposedDate: draft.disposedDate }
                  : {}),
                ...(draft.method === 'deferred' && draft.deferredDep?.length
                  ? { deferredDep: draft.deferredDep }
                  : {}),
              };
              if (!clean.name || !clean.acquiredDate || clean.cost <= 0) return;
              if (draft.id) {
                store.updateAsset(draft.id, {
                  ...clean,
                  memo: clean.memo ?? '',
                  disposedDate: clean.disposedDate ?? '',
                  deferredDep: clean.deferredDep ?? [],
                });
                setMessage(`「${clean.name}」を更新しました。償却費は自動で再計算されています。`);
              } else {
                store.addAsset(clean);
                setMessage(
                  clean.method === 'deferred'
                    ? `「${clean.name}」を登録しました。開業日付で「(借)繰延資産 / (貸)事業主借」が自動起票されます。償却額は編集画面でいつでも設定できます。`
                    : `「${clean.name}」を登録しました。購入の支払い行は科目を「固定資産の取得(振替)」にしてください(経費との二重計上を防ぎます)。`,
                );
              }
              setDraft(null);
            }}
          />
        )}

        <Card
          title={`固定資産台帳(${store.assets.length}件)`}
          action={
            <button
              type="button"
              className={btn.small}
              disabled={totals.total === 0}
              onClick={() => downloadText(`減価償却費の計算_${year}.csv`, depreciationTableCsv(store.assets, year))}
            >
              ⬇ 決算書「減価償却費の計算」CSV
            </button>
          }
        >
          {store.assets.length === 0 ? (
            <EmptyState>
              固定資産がありません。{yen(DEPRECIATION_MIN)}
              以上の備品・車両などを購入したら「資産を登録」してください。償却費は自動計算されます。
            </EmptyState>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[960px] text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
                    <th className="py-2 pr-2 font-medium">名称</th>
                    <th className="px-2 py-2 font-medium">取得日</th>
                    <th className="px-2 py-2 text-right font-medium">取得価額</th>
                    <th className="px-2 py-2 font-medium">償却方法</th>
                    <th className="px-2 py-2 text-right font-medium">耐用年数</th>
                    <th className="px-2 py-2 text-right font-medium">事業割合</th>
                    <th className="px-2 py-2 text-right font-medium">{year}年償却費(経費)</th>
                    <th className="px-2 py-2 text-right font-medium">期末簿価</th>
                    <th className="px-2 py-2 text-right font-medium">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {store.assets.map((a) => {
                    const d = depreciationForYear(a, year);
                    const disposed = !!a.disposedDate;
                    return (
                      <tr key={a.id} className="border-b border-slate-100 hover:bg-slate-50/60">
                        <td className="max-w-[220px] truncate py-2 pr-2 font-medium" title={a.memo || a.name}>
                          {a.name}
                          {disposed && (
                            <span className="ml-2 rounded bg-slate-200 px-1.5 py-0.5 text-[10px] font-medium text-slate-600">
                              除却 {a.disposedDate}
                            </span>
                          )}
                        </td>
                        <td className="tabular px-2 py-2 whitespace-nowrap">{dateLabel(a.acquiredDate)}</td>
                        <td className="tabular px-2 py-2 text-right">{yen(a.cost)}</td>
                        <td className="px-2 py-2 whitespace-nowrap">
                          {METHOD_LABELS[a.method]}
                          {a.method === 'straight' && (
                            <span className="ml-1 text-[10px] text-slate-500">
                              率{straightLineRate(a.usefulLife).toFixed(3)}
                            </span>
                          )}
                        </td>
                        <td className="tabular px-2 py-2 text-right">
                          {a.method === 'straight' ? `${a.usefulLife}年` : a.method === 'lump3' ? '3年' : '—'}
                        </td>
                        <td className="tabular px-2 py-2 text-right">{a.businessRatio}%</td>
                        <td className="tabular px-2 py-2 text-right">
                          {d.total === 0 ? (
                            <span className="text-slate-300">—</span>
                          ) : (
                            <>
                              <span className="font-medium">{yen(d.business)}</span>
                              {d.ownerPart > 0 && (
                                <span className="ml-1 text-[10px] text-slate-500">/全{yen(d.total)}</span>
                              )}
                            </>
                          )}
                        </td>
                        <td className="tabular px-2 py-2 text-right">{yen(bookValueAtEnd(a, year))}</td>
                        <td className="px-2 py-2 text-right whitespace-nowrap">
                          <div className="flex justify-end gap-1">
                            <button type="button" className={btn.small} onClick={() => setScheduleFor(a)}>
                              予定表
                            </button>
                            <button
                              type="button"
                              className={btn.small}
                              onClick={() =>
                                setDraft({
                                  id: a.id,
                                  name: a.name,
                                  acquiredDate: a.acquiredDate,
                                  cost: a.cost,
                                  method: a.method,
                                  usefulLife: a.usefulLife,
                                  businessRatio: a.businessRatio,
                                  memo: a.memo ?? '',
                                  disposedDate: a.disposedDate ?? '',
                                  deferredDep: a.deferredDep ?? [],
                                })
                              }
                            >
                              編集
                            </button>
                            <button
                              type="button"
                              className={btn.danger}
                              onClick={() => {
                                if (
                                  confirm(
                                    `「${a.name}」を台帳から削除しますか?\n過去の年の償却費・貸借対照表からも消えます(誤登録の訂正用)。`,
                                  )
                                ) {
                                  store.deleteAsset(a.id);
                                }
                              }}
                            >
                              削除
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-3 text-xs leading-relaxed text-slate-500">
            償却費は毎年12月31日付の決算整理仕訳(借方: 減価償却費 / 貸方: 減価償却資産)として帳簿・貸借対照表に自動反映されます。
            事業割合が100%未満の場合、家事分は事業主貸になります。除却・売却した資産は除却日を登録すると償却が止まります
            (売却損益・除却損は自動計上しません。事業用資産の売却は譲渡所得になるため、税理士等にご確認ください)。
            <br />
            ※<strong className="text-slate-500">少額特例は年合計300万円まで</strong>。また、定額法・少額特例の資産は
            <strong className="text-slate-500">償却資産税(固定資産税)の申告対象</strong>
            です(毎年1月末・市区町村へ。課税標準150万円未満は課税されません)。一括償却資産(3年均等)は対象外のため、
            10〜20万円の資産は一括償却を選ぶと償却資産税がかかりません。
          </p>
        </Card>
      </div>

      {scheduleFor && <ScheduleModal asset={scheduleFor} onClose={() => setScheduleFor(null)} />}
    </>
  );
}

/** 資産の登録・編集フォーム */
function AssetForm({
  draft,
  onChange,
  onSave,
  onCancel,
}: {
  draft: AssetDraft;
  onChange: (d: AssetDraft) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const set = (patch: Partial<AssetDraft>) => onChange({ ...draft, ...patch });
  const cost = draft.cost;

  // 取得価額に応じて選べる償却方法のヒント
  const hint =
    cost > 0 && cost < DEPRECIATION_MIN
      ? '10万円未満は台帳への登録は不要です(消耗品費などでそのまま経費にできます)。'
      : cost < 200000
        ? '10万〜20万円未満: 一括償却(3年均等・償却資産税の対象外)か、青色申告なら少額特例(全額・年合計300万円まで)を選べます。'
        : cost < 300000
          ? '20万〜30万円未満: 定額法か、青色申告なら少額特例(全額・年合計300万円まで)を選べます。'
          : '30万円以上: 定額法で耐用年数にわたって償却します。';

  return (
    <Card title={draft.id ? `「${draft.name}」を編集` : '固定資産を登録'}>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <label htmlFor="asset-name" className="mb-1 block text-xs font-medium text-slate-500">名称 *</label>
          <input
            id="asset-name"
            type="text"
            className={`${input} w-full`}
            placeholder="例: ノートPC MacBook Pro 14インチ"
            value={draft.name}
            onChange={(e) => set({ name: e.target.value })}
          />
        </div>
        <div>
          <label htmlFor="asset-acquired-date" className="mb-1 block text-xs font-medium text-slate-500">取得日(事業供用日)*</label>
          <input
            id="asset-acquired-date"
            type="date"
            className={`${input} w-full`}
            value={draft.acquiredDate}
            onChange={(e) => set({ acquiredDate: e.target.value })}
          />
        </div>
        <div>
          <label htmlFor="asset-cost" className="mb-1 block text-xs font-medium text-slate-500">取得価額(円)*</label>
          <input
            id="asset-cost"
            type="number"
            min={1}
            className={`${input} w-full text-right`}
            value={draft.cost || ''}
            onChange={(e) => set({ cost: Number(e.target.value) })}
          />
        </div>
        <div>
          <label htmlFor="asset-method" className="mb-1 block text-xs font-medium text-slate-500">償却方法</label>
          <select
            id="asset-method"
            className={`${selectCls} w-full`}
            value={draft.method}
            onChange={(e) => set({ method: e.target.value as DepreciationMethod })}
          >
            <option value="straight">定額法(原則)</option>
            <option value="lump3">一括償却(3年均等・10〜20万円未満)</option>
            <option value="immediate">少額特例(全額その年の経費・30万円未満)</option>
            <option value="deferred">開業費・繰延資産(任意償却)</option>
          </select>
        </div>
        {draft.method === 'straight' && (
          <div>
            <label htmlFor="asset-useful-life" className="mb-1 block text-xs font-medium text-slate-500">
              耐用年数(償却率{' '}
              {straightLineRate(Math.min(100, Math.max(2, draft.usefulLife || 2))).toFixed(3)})
            </label>
            <div className="flex gap-2">
              <input
                id="asset-useful-life"
                type="number"
                min={2}
                max={100}
                className={`${input} w-20 text-right`}
                value={draft.usefulLife}
                onChange={(e) => set({ usefulLife: Number(e.target.value) })}
              />
              <select
                aria-label="耐用年数の例から選択"
                className={selectCls}
                value=""
                onChange={(e) => {
                  if (e.target.value) set({ usefulLife: Number(e.target.value) });
                }}
              >
                <option value="">主な例から選ぶ…</option>
                {USEFUL_LIFE_PRESETS.map((p) => (
                  <option key={p.label} value={p.years}>
                    {p.label}({p.years}年)
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}
        <div>
          <label htmlFor="asset-business-ratio" className="mb-1 block text-xs font-medium text-slate-500">事業専用割合(%)</label>
          <input
            id="asset-business-ratio"
            type="number"
            min={1}
            max={100}
            className={`${input} w-24 text-right`}
            value={draft.businessRatio}
            onChange={(e) => set({ businessRatio: Number(e.target.value) })}
          />
        </div>
        <div className="sm:col-span-2">
          <label htmlFor="asset-memo" className="mb-1 block text-xs font-medium text-slate-500">メモ(型番・耐用年数の根拠など)</label>
          <input
            id="asset-memo"
            type="text"
            className={`${input} w-full`}
            value={draft.memo ?? ''}
            onChange={(e) => set({ memo: e.target.value })}
          />
        </div>
        {draft.id && draft.method !== 'deferred' && (
          <div>
            <label htmlFor="asset-disposed-date" className="mb-1 block text-xs font-medium text-slate-500">除却・売却日(任意)</label>
            <input
              id="asset-disposed-date"
              type="date"
              className={`${input} w-full`}
              value={draft.disposedDate ?? ''}
              onChange={(e) => set({ disposedDate: e.target.value })}
            />
          </div>
        )}
        {draft.method === 'deferred' && (
          <div className="sm:col-span-2 lg:col-span-3">
            <label className="mb-1 block text-xs font-medium text-slate-500">
              任意償却の履歴(年ごとの償却額。合計は取得価額まで)
            </label>
            <DeferredDepEditor
              deferredDep={draft.deferredDep ?? []}
              cost={draft.cost}
              acquiredYear={Number(draft.acquiredDate.slice(0, 4)) || new Date().getFullYear()}
              onChange={(deferredDep) => set({ deferredDep })}
            />
            <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
              開業費は登録すると開業日付で「(借)繰延資産 /
              (貸)事業主借」が自動起票されます(取得取引の登録は不要)。償却額は好きな年に自由に決められます(利益が出た年に多く償却するのが定石)。
            </p>
          </div>
        )}
      </div>

      {cost > 0 && <p className="mt-3 text-xs text-slate-500">{hint}</p>}

      <div className="mt-4 flex gap-2">
        <button
          type="button"
          className={btn.primary}
          disabled={!draft.name.trim() || !draft.acquiredDate || draft.cost <= 0}
          onClick={onSave}
        >
          {draft.id ? '更新する' : '登録する'}
        </button>
        <button type="button" className={btn.secondary} onClick={onCancel}>
          キャンセル
        </button>
      </div>
    </Card>
  );
}

/** 繰延資産(開業費)の任意償却額エディタ */
function DeferredDepEditor({
  deferredDep,
  cost,
  acquiredYear,
  onChange,
}: {
  deferredDep: { year: number; amount: number }[];
  cost: number;
  acquiredYear: number;
  onChange: (rows: { year: number; amount: number }[]) => void;
}) {
  const currentYear = new Date().getFullYear();
  const [year, setYear] = useState(currentYear);
  const [amount, setAmount] = useState('');
  const used = deferredDep.reduce((s, d) => s + d.amount, 0);
  const remaining = Math.max(0, Math.round(cost) - used);
  const yearOptions: number[] = [];
  for (let y = acquiredYear; y <= Math.max(currentYear + 1, acquiredYear); y++) yearOptions.push(y);

  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
      {deferredDep.length > 0 && (
        <table className="mb-2 w-full max-w-md text-sm">
          <tbody>
            {[...deferredDep]
              .sort((a, b) => a.year - b.year)
              .map((d) => (
                <tr key={d.year} className="border-b border-slate-200/60">
                  <td className="py-1 pr-2">{d.year}年</td>
                  <td className="tabular px-2 py-1 text-right">{yen(d.amount)}</td>
                  <td className="py-1 pl-2 text-right">
                    <button
                      type="button"
                      className={btn.danger}
                      onClick={() => onChange(deferredDep.filter((x) => x.year !== d.year))}
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <select aria-label="償却する年" className={selectCls} value={year} onChange={(e) => setYear(Number(e.target.value))}>
          {yearOptions.map((y) => (
            <option key={y} value={y}>
              {y}年
            </option>
          ))}
        </select>
        <input
          aria-label="この年の償却額"
          type="number"
          min={1}
          max={remaining || undefined}
          className={`${input} w-36 text-right`}
          placeholder={`残り ${yen(remaining)}`}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
        <button
          type="button"
          className={btn.small}
          disabled={remaining <= 0}
          onClick={() => {
            const n = Math.round(Number(amount));
            if (!Number.isFinite(n) || n <= 0) return;
            const others = deferredDep.filter((x) => x.year !== year);
            const usedOthers = others.reduce((s, d) => s + d.amount, 0);
            const capped = Math.min(n, Math.max(0, Math.round(cost) - usedOthers));
            if (capped <= 0) return;
            onChange([...others, { year, amount: capped }].sort((a, b) => a.year - b.year));
            setAmount('');
          }}
        >
          ＋ この年の償却額を設定
        </button>
        <span className="text-xs text-slate-500">未償却残高: {yen(remaining)}</span>
      </div>
    </div>
  );
}

/** 償却予定表モーダル */
function ScheduleModal({ asset, onClose }: { asset: FixedAsset; onClose: () => void }) {
  const rows = depreciationSchedule(asset);
  return (
    <ModalShell
      label={`償却予定表 ${asset.name}`}
      onClose={onClose}
      className="mx-auto max-w-2xl rounded-xl bg-white p-6 shadow-xl"
    >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-800">
            償却予定表 ── {asset.name}({METHOD_LABELS[asset.method]}
            {asset.method === 'straight' ? `・${asset.usefulLife}年` : ''})
          </h2>
          <button type="button" className={btn.secondary} onClick={onClose}>
            閉じる
          </button>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
              <th className="py-1.5 pr-2 font-medium">年分</th>
              <th className="px-2 py-1.5 text-right font-medium">償却期間</th>
              <th className="px-2 py-1.5 text-right font-medium">期首簿価</th>
              <th className="px-2 py-1.5 text-right font-medium">償却費(全額)</th>
              <th className="px-2 py-1.5 text-right font-medium">経費算入額</th>
              <th className="px-2 py-1.5 text-right font-medium">期末簿価</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.year} className="tabular border-b border-slate-100">
                <td className="py-1.5 pr-2">{r.year}年</td>
                <td className="px-2 py-1.5 text-right">{r.months}ヶ月</td>
                <td className="px-2 py-1.5 text-right">{yen(r.opening)}</td>
                <td className="px-2 py-1.5 text-right">{yen(r.dep)}</td>
                <td className="px-2 py-1.5 text-right font-medium">
                  {yen(Math.floor((r.dep * asset.businessRatio) / 100))}
                </td>
                <td className="px-2 py-1.5 text-right">{yen(r.closing)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-3 text-xs text-slate-500">
          ※定額法は帳簿価額1円(備忘価額)まで償却します。経費算入額 = 償却費 × 事業専用割合(
          {asset.businessRatio}%)。
        </p>
    </ModalShell>
  );
}
