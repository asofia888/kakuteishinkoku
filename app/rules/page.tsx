'use client';

import React, { useMemo, useState } from 'react';
import { Alert, btn, Card, EmptyState, input, PageHeader, selectCls } from '@/components/ui';
import {
  ACCOUNTS,
  accountLabel,
  EXCLUDED_ACCOUNT,
  EXCLUDED_LABEL,
  SETTLEMENT_ACCOUNTS,
} from '@/lib/accounts';
import { matchRule } from '@/lib/rules';
import { useStore } from '@/lib/store';
import { TxType } from '@/lib/types';

export default function RulesPage() {
  const store = useStore();
  const [keyword, setKeyword] = useState('');
  const [account, setAccount] = useState('supplies');
  const [message, setMessage] = useState<string | null>(null);

  // ルールお試し欄
  const [testText, setTestText] = useState('');
  const [testType, setTestType] = useState<TxType>('expense');
  const testResult = useMemo(() => {
    if (!testText.trim()) return null;
    return matchRule(testText, testType, store.rules);
  }, [testText, testType, store.rules]);

  const unclassifiedCount = store.transactions.filter((t) => t.account === null).length;

  const addRule = (e: React.FormEvent) => {
    e.preventDefault();
    const k = keyword.trim();
    if (!k) return;
    store.addRule({ keyword: k, account });
    setKeyword('');
    setMessage(`ルール「${k} → ${accountLabel(account)}」を追加しました。`);
  };

  if (!store.ready) {
    return <div className="py-24 text-center text-sm text-slate-500">読み込み中…</div>;
  }

  return (
    <>
      <PageHeader
        title="自動仕訳ルール設定"
        description="摘要にキーワードが含まれる取引へ、勘定科目を自動で割り当てます。上にあるルールほど優先されます。私的な定期購入などは「対象外(プライベート)」を割り当てると集計から除外できます。"
      />

      <div className="space-y-6">
        <Card title="ルールを追加">
          <form onSubmit={addRule} className="flex flex-wrap items-end gap-3">
            <div className="min-w-52 flex-1">
              <label htmlFor="rule-keyword" className="mb-1 block text-xs font-medium text-slate-500">
                キーワード(摘要に含まれる文字。大文字小文字・全角半角・半角カナは区別しません)
              </label>
              <input
                id="rule-keyword"
                type="text"
                className={`${input} w-full`}
                placeholder="例: Amazon / 電力 / 家賃"
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
              />
            </div>
            <div>
              <label htmlFor="rule-account" className="mb-1 block text-xs font-medium text-slate-500">
                割り当てる勘定科目
              </label>
              <select
                id="rule-account"
                className={selectCls}
                value={account}
                onChange={(e) => setAccount(e.target.value)}
              >
                <optgroup label="経費">
                  {ACCOUNTS.filter((a) => a.type === 'expense').map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.label}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="収入">
                  {ACCOUNTS.filter((a) => a.type === 'income').map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.label}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="決済・振替(売上・経費に入らない)">
                  {SETTLEMENT_ACCOUNTS.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.label}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="その他">
                  <option value={EXCLUDED_ACCOUNT}>{EXCLUDED_LABEL} ── 集計から除外</option>
                </optgroup>
              </select>
            </div>
            <button type="submit" className={btn.primary} disabled={!keyword.trim()}>
              追加
            </button>
          </form>

          <div className="mt-4 rounded-lg bg-slate-50 p-4">
            <div className="mb-2 text-xs font-medium text-slate-500">
              🧪 お試し: 摘要を入力すると、どのルールに一致するか確認できます
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="text"
                aria-label="お試し判定の摘要"
                className={`${input} min-w-60 flex-1`}
                placeholder="例: AMAZON.CO.JP カイモノ"
                value={testText}
                onChange={(e) => setTestText(e.target.value)}
              />
              <select
                aria-label="お試し判定の取引種別"
                className={selectCls}
                value={testType}
                onChange={(e) => setTestType(e.target.value as TxType)}
              >
                <option value="expense">支出として</option>
                <option value="income">収入として</option>
              </select>
              {testText.trim() && (
                <span className="text-sm">
                  {testResult ? (
                    <>
                      →{' '}
                      <strong className="text-blue-700">{accountLabel(testResult.account)}</strong>
                      <span className="ml-1 text-xs text-slate-500">
                        (キーワード「{testResult.keyword}」に一致)
                      </span>
                    </>
                  ) : (
                    <span className="text-amber-700">→ 一致するルールなし(未仕訳)</span>
                  )}
                </span>
              )}
            </div>
          </div>
        </Card>

        {message && <Alert tone="success">{message}</Alert>}

        <Card
          title={`登録済みルール(${store.rules.length}件)`}
          action={
            <button
              type="button"
              className={btn.small}
              disabled={unclassifiedCount === 0}
              onClick={() => {
                const n = store.reapplyRules();
                setMessage(
                  n > 0
                    ? `${n}件の未仕訳取引に勘定科目を割り当てました。取引一覧で確認してください。`
                    : '未仕訳の取引に一致するルールはありませんでした。',
                );
              }}
            >
              🤖 未仕訳の取引({unclassifiedCount}件)にルールを適用
            </button>
          }
        >
          {store.rules.length === 0 ? (
            <EmptyState>ルールがありません。上のフォームから追加してください。</EmptyState>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
                    <th className="w-20 py-2 pr-2 font-medium">優先順位</th>
                    <th className="px-2 py-2 font-medium">キーワード</th>
                    <th className="px-2 py-2 font-medium">割り当てる勘定科目</th>
                    <th className="w-32 px-2 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {store.rules.map((r, i) => (
                    <tr key={r.id} className="border-b border-slate-100 hover:bg-slate-50/60">
                      <td className="py-1.5 pr-2">
                        <div className="flex items-center gap-1">
                          <span className="tabular w-6 text-right text-xs text-slate-500">
                            {i + 1}
                          </span>
                          <button
                            type="button"
                            className={btn.small}
                            disabled={i === 0}
                            aria-label="上へ"
                            onClick={() => store.moveRule(r.id, -1)}
                          >
                            ↑
                          </button>
                          <button
                            type="button"
                            className={btn.small}
                            disabled={i === store.rules.length - 1}
                            aria-label="下へ"
                            onClick={() => store.moveRule(r.id, 1)}
                          >
                            ↓
                          </button>
                        </div>
                      </td>
                      <td className="px-2 py-1.5">
                        <input
                          type="text"
                          aria-label={`ルール「${r.keyword}」のキーワード`}
                          className={`${input} w-full max-w-64 !py-1`}
                          defaultValue={r.keyword}
                          onBlur={(e) => {
                            const v = e.target.value.trim();
                            if (v && v !== r.keyword) store.updateRule(r.id, { keyword: v });
                            else e.target.value = r.keyword;
                          }}
                        />
                      </td>
                      <td className="px-2 py-1.5">
                        <select
                          aria-label={`ルール「${r.keyword}」の勘定科目`}
                          className={selectCls}
                          value={r.account}
                          onChange={(e) => store.updateRule(r.id, { account: e.target.value })}
                        >
                          <optgroup label="経費">
                            {ACCOUNTS.filter((a) => a.type === 'expense').map((a) => (
                              <option key={a.id} value={a.id}>
                                {a.label}
                              </option>
                            ))}
                          </optgroup>
                          <optgroup label="収入">
                            {ACCOUNTS.filter((a) => a.type === 'income').map((a) => (
                              <option key={a.id} value={a.id}>
                                {a.label}
                              </option>
                            ))}
                          </optgroup>
                          <optgroup label="決済・振替">
                            {SETTLEMENT_ACCOUNTS.map((a) => (
                              <option key={a.id} value={a.id}>
                                {a.label}
                              </option>
                            ))}
                          </optgroup>
                          <optgroup label="その他">
                            <option value={EXCLUDED_ACCOUNT}>{EXCLUDED_LABEL}</option>
                          </optgroup>
                        </select>
                      </td>
                      <td className="px-2 py-1.5 text-right">
                        <button
                          type="button"
                          className={btn.danger}
                          onClick={() => {
                            if (
                              confirm(
                                `ルール「${r.keyword} → ${accountLabel(r.account)}」を削除しますか?`,
                              )
                            ) {
                              store.deleteRule(r.id);
                            }
                          }}
                        >
                          削除
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
