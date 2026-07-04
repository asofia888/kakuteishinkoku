'use client';

import React, { useMemo, useState } from 'react';
import { Alert, btn, Card, EmptyState, input, PageHeader, selectCls, StatCard } from '@/components/ui';
import { availableYears, DEPRECIATION_MIN, transactionsOfYear } from '@/lib/aggregate';
import {
  acquisitionsInYear,
  bookValueAtEnd,
  depreciationForYear,
  depreciationSchedule,
  depreciationTableCsv,
  METHOD_LABELS,
  straightLineRate,
  USEFUL_LIFE_PRESETS,
  yearDepreciationTotals,
} from '@/lib/assets';
import { downloadText } from '@/lib/csv';
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
  const registerCostTotal = useMemo(
    () => acquisitionsInYear(store.assets, year).reduce((s, a) => s + a.cost, 0),
    [store.assets, year],
  );

  const bookTotal = useMemo(
    () => store.assets.reduce((s, a) => s + bookValueAtEnd(a, year), 0),
    [store.assets, year],
  );

  if (!store.ready) {
    return <div className="py-24 text-center text-sm text-slate-400">読み込み中…</div>;
  }

  return (
    <>
      <PageHeader
        title="固定資産台帳(減価償却)"
        description="10万円以上の備品・車両などを登録すると、耐用年数から減価償却費を自動計算し、経費・仕訳帳・貸借対照表へ反映します。青色申告決算書「減価償却費の計算」欄のCSVも出力できます。"
      />

      <div className="space-y-6">
        <div className="flex flex-wrap items-center gap-3">
          <select className={selectCls} value={year} onChange={(e) => setYear(Number(e.target.value))}>
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

        {registerCostTotal !== purchaseTxTotal && (registerCostTotal > 0 || purchaseTxTotal > 0) && (
          <Alert tone="warning">
            {year}年の台帳の取得価額合計は <strong>{yen(registerCostTotal)}</strong>
            、取引一覧の「固定資産の取得(振替)」は <strong>{yen(purchaseTxTotal)}</strong>{' '}
            で一致していません。購入の支払い行の科目を「固定資産の取得(振替)」にする(またはその金額で台帳に登録する)と、貸借対照表がぴったり一致します。
            ※開業前から保有する資産を登録した場合など、支払いが帳簿外のときはこの差は問題ありません。
          </Alert>
        )}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <StatCard label={`${year}年の償却費(全額)`} value={yen(totals.total)} />
          <StatCard
            label={`${year}年の必要経費算入額`}
            value={yen(totals.business)}
            sub={totals.total > totals.business ? `家事分 ${yen(totals.total - totals.business)} は事業主貸` : undefined}
            tone="primary"
          />
          <StatCard label={`${year}年末の未償却残高合計`} value={yen(bookTotal)} sub="貸借対照表の「減価償却資産」" />
        </div>

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
                usefulLife: Math.min(100, Math.max(2, Math.round(draft.usefulLife))),
                businessRatio: Math.min(100, Math.max(1, Math.round(draft.businessRatio))),
                ...(draft.memo?.trim() ? { memo: draft.memo.trim() } : {}),
                ...(draft.disposedDate ? { disposedDate: draft.disposedDate } : {}),
              };
              if (!clean.name || !clean.acquiredDate || clean.cost <= 0) return;
              if (draft.id) {
                store.updateAsset(draft.id, { ...clean, memo: clean.memo ?? '', disposedDate: clean.disposedDate ?? '' });
                setMessage(`「${clean.name}」を更新しました。償却費は自動で再計算されています。`);
              } else {
                store.addAsset(clean);
                setMessage(
                  `「${clean.name}」を登録しました。購入の支払い行は科目を「固定資産の取得(振替)」にしてください(経費との二重計上を防ぎます)。`,
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
                            <span className="ml-1 text-[10px] text-slate-400">
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
                                <span className="ml-1 text-[10px] text-slate-400">/全{yen(d.total)}</span>
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
          <p className="mt-3 text-xs leading-relaxed text-slate-400">
            償却費は毎年12月31日付の決算整理仕訳(借方: 減価償却費 / 貸方: 減価償却資産)として帳簿・貸借対照表に自動反映されます。
            事業割合が100%未満の場合、家事分は事業主貸になります。除却・売却した資産は除却日を登録すると償却が止まります
            (売却損益・除却損は自動計上しません。事業用資産の売却は譲渡所得になるため、税理士等にご確認ください)。
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
        ? '10万〜20万円未満: 一括償却(3年均等)か、青色申告なら少額特例(全額)も選べます。'
        : cost < 300000
          ? '20万〜30万円未満: 定額法か、青色申告なら少額特例(全額・年合計300万円まで)を選べます。'
          : '30万円以上: 定額法で耐用年数にわたって償却します。';

  return (
    <Card title={draft.id ? `「${draft.name}」を編集` : '固定資産を登録'}>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <label className="mb-1 block text-xs font-medium text-slate-500">名称 *</label>
          <input
            type="text"
            className={`${input} w-full`}
            placeholder="例: ノートPC MacBook Pro 14インチ"
            value={draft.name}
            onChange={(e) => set({ name: e.target.value })}
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-slate-500">取得日(事業供用日)*</label>
          <input
            type="date"
            className={`${input} w-full`}
            value={draft.acquiredDate}
            onChange={(e) => set({ acquiredDate: e.target.value })}
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-slate-500">取得価額(円)*</label>
          <input
            type="number"
            min={1}
            className={`${input} w-full text-right`}
            value={draft.cost || ''}
            onChange={(e) => set({ cost: Number(e.target.value) })}
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-slate-500">償却方法</label>
          <select
            className={`${selectCls} w-full`}
            value={draft.method}
            onChange={(e) => set({ method: e.target.value as DepreciationMethod })}
          >
            <option value="straight">定額法(原則)</option>
            <option value="lump3">一括償却(3年均等・10〜20万円未満)</option>
            <option value="immediate">少額特例(全額その年の経費・30万円未満)</option>
          </select>
        </div>
        {draft.method === 'straight' && (
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-500">
              耐用年数(償却率 {straightLineRate(Math.min(100, Math.max(2, draft.usefulLife))).toFixed(3)})
            </label>
            <div className="flex gap-2">
              <input
                type="number"
                min={2}
                max={100}
                className={`${input} w-20 text-right`}
                value={draft.usefulLife}
                onChange={(e) => set({ usefulLife: Number(e.target.value) })}
              />
              <select
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
          <label className="mb-1 block text-xs font-medium text-slate-500">事業専用割合(%)</label>
          <input
            type="number"
            min={1}
            max={100}
            className={`${input} w-24 text-right`}
            value={draft.businessRatio}
            onChange={(e) => set({ businessRatio: Number(e.target.value) })}
          />
        </div>
        <div className="sm:col-span-2">
          <label className="mb-1 block text-xs font-medium text-slate-500">メモ(型番・耐用年数の根拠など)</label>
          <input
            type="text"
            className={`${input} w-full`}
            value={draft.memo ?? ''}
            onChange={(e) => set({ memo: e.target.value })}
          />
        </div>
        {draft.id && (
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-500">除却・売却日(任意)</label>
            <input
              type="date"
              className={`${input} w-full`}
              value={draft.disposedDate ?? ''}
              onChange={(e) => set({ disposedDate: e.target.value })}
            />
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

/** 償却予定表モーダル */
function ScheduleModal({ asset, onClose }: { asset: FixedAsset; onClose: () => void }) {
  const rows = depreciationSchedule(asset);
  return (
    <div className="fixed inset-0 z-50 overflow-auto bg-slate-900/60 p-4 md:p-8" onClick={onClose}>
      <div className="mx-auto max-w-2xl rounded-xl bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
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
        <p className="mt-3 text-xs text-slate-400">
          ※定額法は帳簿価額1円(備忘価額)まで償却します。経費算入額 = 償却費 × 事業専用割合(
          {asset.businessRatio}%)。
        </p>
      </div>
    </div>
  );
}
