'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { Alert, btn, Card, EmptyState, input, PageHeader, selectCls } from '@/components/ui';
import { accountLabel, EXPENSE_ACCOUNTS } from '@/lib/accounts';
import { availableYears, transactionsOfYear } from '@/lib/aggregate';
import { yen } from '@/lib/format';
import { useStore } from '@/lib/store';
import { AnbunType } from '@/lib/types';

export default function AnbunPage() {
  const store = useStore();
  const [account, setAccount] = useState('rent');
  const [type, setType] = useState<AnbunType>('percent');
  const [value, setValue] = useState('');
  const [memo, setMemo] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [year, setYear] = useState(() => new Date().getFullYear());

  const years = useMemo(
    () => availableYears(store.transactions, new Date().getFullYear()),
    [store.transactions],
  );

  // 科目を切り替えたら既存設定の根拠メモを引き継ぐ(上書き保存でメモが消えないように)
  useEffect(() => {
    setMemo(store.anbunSettings.find((s) => s.account === account)?.memo ?? '');
  }, [account, store.anbunSettings]);

  /** 選択年の科目別実績(設定の効果プレビュー用) */
  const preview = useMemo(() => {
    const txs = transactionsOfYear(store.transactions, year).filter(
      (t) => t.type === 'expense' && t.account !== null,
    );
    const byAccount = new Map<string, { gross: number; business: number; count: number }>();
    for (const t of txs) {
      const cur = byAccount.get(t.account!) ?? { gross: 0, business: 0, count: 0 };
      cur.gross += t.amount;
      cur.business += t.businessAmount;
      cur.count++;
      byAccount.set(t.account!, cur);
    }
    return byAccount;
  }, [store.transactions, year]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return;
    if (type === 'percent' && n > 100) {
      setMessage('事業割合は100%以下で入力してください。');
      return;
    }
    store.addAnbunSetting({
      account,
      type,
      value: Math.round(n),
      ...(memo.trim() ? { memo: memo.trim() } : {}),
    });
    setValue('');
    setMemo('');
    setMessage(
      `「${accountLabel(account)}」の按分設定を保存しました(${
        type === 'percent' ? `事業割合 ${Math.round(n)}%` : `毎月 ${yen(Math.round(n))} まで経費計上`
      })。全取引へ自動で再適用されています。`,
    );
  };

  if (!store.ready) {
    return <div className="py-24 text-center text-sm text-slate-500">読み込み中…</div>;
  }

  const existingForAccount = store.anbunSettings.find((s) => s.account === account);

  return (
    <>
      <PageHeader
        title="家事按分設定"
        description="家賃・電気代・通信費など、プライベートと事業が混ざる支出を按分します。設定は登録済みの全取引へ自動で適用され、経費計上されない残額は「事業主貸」として扱われます。"
      />

      <div className="space-y-6">
        <Card title="按分ルールを登録(科目ごとに1件)">
          <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
            <div>
              <label htmlFor="anbun-account" className="mb-1 block text-xs font-medium text-slate-500">
                対象の勘定科目
              </label>
              <select
                id="anbun-account"
                className={selectCls}
                value={account}
                onChange={(e) => setAccount(e.target.value)}
              >
                {EXPENSE_ACCOUNTS.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-500">計算方法</label>
              <div className="flex overflow-hidden rounded-lg border border-slate-300">
                <button
                  type="button"
                  className={`px-3 py-2 text-sm font-medium ${
                    type === 'percent' ? 'bg-blue-600 text-white' : 'bg-white text-slate-600'
                  }`}
                  onClick={() => setType('percent')}
                >
                  パーセント指定
                </button>
                <button
                  type="button"
                  className={`px-3 py-2 text-sm font-medium ${
                    type === 'fixed' ? 'bg-blue-600 text-white' : 'bg-white text-slate-600'
                  }`}
                  onClick={() => setType('fixed')}
                >
                  固定金額指定
                </button>
              </div>
            </div>
            <div>
              <label htmlFor="anbun-value" className="mb-1 block text-xs font-medium text-slate-500">
                {type === 'percent' ? '事業割合(%)' : '毎月の経費計上額(円)'}
              </label>
              <div className="flex items-center gap-1">
                <input
                  id="anbun-value"
                  type="number"
                  className={`${input} w-32`}
                  min={1}
                  max={type === 'percent' ? 100 : undefined}
                  placeholder={type === 'percent' ? '例: 40' : '例: 30000'}
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  required
                />
                <span className="text-sm text-slate-500">
                  {type === 'percent' ? '%' : '円/月'}
                </span>
              </div>
            </div>
            <div className="min-w-56 flex-1">
              <label htmlFor="anbun-memo" className="mb-1 block text-xs font-medium text-slate-500">
                根拠メモ(任意・税務調査で説明できるように)
              </label>
              <input
                id="anbun-memo"
                type="text"
                className={`${input} w-full`}
                maxLength={100}
                placeholder="例: 仕事部屋の床面積 20㎡ / 全体 50㎡ = 40%"
                value={memo}
                onChange={(e) => setMemo(e.target.value)}
              />
            </div>
            <button type="submit" className={btn.primary}>
              {existingForAccount ? '上書き保存' : '保存'}
            </button>
          </form>
          {existingForAccount && (
            <p className="mt-2 text-xs text-amber-700">
              ※「{accountLabel(account)}」には既に按分設定があります。保存すると置き換えられます。
            </p>
          )}
          <div className="mt-4 grid gap-2 text-xs leading-relaxed text-slate-500 sm:grid-cols-2">
            <div className="rounded-lg bg-slate-50 p-3">
              <strong className="text-slate-600">パーセント指定</strong> ──
              各取引の金額 × 事業割合を経費計上します。
              例: 電気代10,000円 × 事業割合40% → 経費4,000円 / 事業主貸6,000円
            </div>
            <div className="rounded-lg bg-slate-50 p-3">
              <strong className="text-slate-600">固定金額指定</strong> ──
              月ごとに指定額まで経費計上し、超えた分は事業主貸にします。
              例: 家賃80,000円・固定30,000円 → 経費30,000円 / 事業主貸50,000円
            </div>
          </div>
        </Card>

        {message && <Alert tone="success">{message}</Alert>}

        <Card
          title={`登録済みの按分設定(${store.anbunSettings.length}件)`}
          action={
            <div className="flex items-center gap-2">
              <select
                aria-label="試算する年"
                className={selectCls}
                value={year}
                onChange={(e) => setYear(Number(e.target.value))}
              >
                {years.map((y) => (
                  <option key={y} value={y}>
                    {y}年で試算
                  </option>
                ))}
              </select>
              <button
                type="button"
                className={btn.small}
                onClick={() => {
                  store.recalcAnbun();
                  setMessage('全取引へ按分を再計算しました。');
                }}
              >
                ↻ 一括再計算
              </button>
            </div>
          }
        >
          {store.anbunSettings.length === 0 ? (
            <EmptyState>
              按分設定がありません。上のフォームから登録すると、該当科目の全取引に自動で適用されます。
            </EmptyState>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[820px] text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
                    <th className="py-2 pr-2 font-medium">勘定科目</th>
                    <th className="px-2 py-2 font-medium">計算方法</th>
                    <th className="px-2 py-2 text-right font-medium">設定値</th>
                    <th className="px-2 py-2 font-medium">根拠メモ</th>
                    <th className="px-2 py-2 text-right font-medium">{year}年 支払額</th>
                    <th className="px-2 py-2 text-right font-medium">経費計上額</th>
                    <th className="px-2 py-2 text-right font-medium">事業主貸</th>
                    <th className="w-20 px-2 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {store.anbunSettings.map((s) => {
                    const p = preview.get(s.account);
                    return (
                      <tr key={s.id} className="border-b border-slate-100 hover:bg-slate-50/60">
                        <td className="py-2 pr-2 font-medium">{accountLabel(s.account)}</td>
                        <td className="px-2 py-2">
                          <span
                            className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${
                              s.type === 'percent'
                                ? 'bg-blue-100 text-blue-700'
                                : 'bg-violet-100 text-violet-700'
                            }`}
                          >
                            {s.type === 'percent' ? 'パーセント' : '固定金額/月'}
                          </span>
                        </td>
                        <td className="tabular px-2 py-2 text-right">
                          {s.type === 'percent' ? `${s.value}%` : yen(s.value)}
                        </td>
                        <td className="max-w-56 px-2 py-2 text-xs text-slate-500">
                          {s.memo ? <span className="break-words">{s.memo}</span> : '—'}
                        </td>
                        <td className="tabular px-2 py-2 text-right text-slate-500">
                          {p ? yen(p.gross) : '—'}
                        </td>
                        <td className="tabular px-2 py-2 text-right font-medium">
                          {p ? yen(p.business) : '—'}
                        </td>
                        <td className="tabular px-2 py-2 text-right text-slate-500">
                          {p ? yen(p.gross - p.business) : '—'}
                        </td>
                        <td className="px-2 py-2 text-right">
                          <button
                            type="button"
                            className={btn.danger}
                            onClick={() => {
                              if (
                                confirm(
                                  `「${accountLabel(s.account)}」の按分設定を削除しますか?\n削除すると該当科目は全額経費計上に戻ります。`,
                                )
                              ) {
                                store.deleteAnbunSetting(s.id);
                              }
                            }}
                          >
                            削除
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-3 text-xs text-slate-500">
            ※按分は取引の取込・編集・設定変更のたびに自動で全取引へ再適用されます(按分適用済みフラグ付き)。
            試算列は選択した年の仕訳済み取引が対象です。
          </p>
        </Card>
      </div>
    </>
  );
}
