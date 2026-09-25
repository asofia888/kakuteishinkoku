'use client';

import { useMemo, useState } from 'react';
import { Alert, btn, Card, input } from '@/components/ui';
import { yen } from '@/lib/format';
import { RENT_FORM_ROWS, rentBreakdown } from '@/lib/rent';
import { useStore } from '@/lib/store';
import { RentPayee } from '@/lib/types';

type Draft = Omit<RentPayee, 'id' | 'createdAt'>;
const EMPTY: Draft = { name: '', address: '', property: '', keyword: '' };

/**
 * 青色申告決算書2ページ「地代家賃の内訳」。
 * 支払先(大家・管理会社)を登録すると、科目「地代家賃」の取引から支払先ごとの
 * 本年中の賃借料(按分前)と必要経費算入額(按分後)を集計する。転記ガイドページで使用
 */
export function RentBreakdownCard({ year }: { year: number }) {
  const store = useStore();
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [editingId, setEditingId] = useState<string | null>(null);

  const breakdown = useMemo(
    () => rentBreakdown(store.transactions, year, store.rentPayees),
    [store.transactions, year, store.rentPayees],
  );
  const totalGross = breakdown.rows.reduce((s, r) => s + r.gross, 0) + breakdown.unassigned.gross;

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft.name.trim()) return;
    if (editingId) store.updateRentPayee(editingId, draft);
    else store.addRentPayee(draft);
    setDraft(EMPTY);
    setEditingId(null);
  };

  const field = (key: keyof Draft, label: string, placeholder: string, width: string, maxLength: number) => (
    <div>
      <label htmlFor={`rent-${key}`} className="mb-1 block text-xs font-medium text-slate-500">
        {label}
      </label>
      <input
        id={`rent-${key}`}
        type="text"
        className={`${input} ${width}`}
        maxLength={maxLength}
        placeholder={placeholder}
        value={draft[key]}
        onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
      />
    </div>
  );

  return (
    <Card title="青色申告決算書 2ページ目 ── 地代家賃の内訳">
      {totalGross > 0 && store.rentPayees.length === 0 && (
        <div className="mb-3">
          <Alert tone="warning">
            {year}年に地代家賃({yen(totalGross)})がありますが、支払先が未登録です。
            決算書の「地代家賃の内訳」には支払先の住所・氏名と賃借物件の記載が必要です。下のフォームで登録してください。
          </Alert>
        </div>
      )}

      {store.rentPayees.length > 0 && (
        <div className="mb-4 overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
                <th className="py-1.5 pr-2 font-medium">支払先の住所・氏名</th>
                <th className="px-2 py-1.5 font-medium">賃借物件</th>
                <th className="px-2 py-1.5 text-right font-medium">本年中の賃借料</th>
                <th className="px-2 py-1.5 text-right font-medium">左のうち必要経費算入額</th>
                <th className="px-2 py-1.5" />
              </tr>
            </thead>
            <tbody>
              {breakdown.rows.map((r, i) => (
                <tr key={r.payee.id} className="border-b border-slate-100 align-top">
                  <td className="py-1.5 pr-2">
                    <div className="text-xs text-slate-500">{r.payee.address || '(住所未入力)'}</div>
                    <div className="font-medium">{r.payee.name}</div>
                    {r.payee.keyword && (
                      <div className="text-[11px] text-slate-500">振り分け: 摘要に「{r.payee.keyword}」</div>
                    )}
                    {i >= RENT_FORM_ROWS && (
                      <div className="text-[11px] text-amber-700">※様式は{RENT_FORM_ROWS}行までのため、e-Tax出力には含まれません</div>
                    )}
                  </td>
                  <td className="px-2 py-1.5">{r.payee.property || '—'}</td>
                  <td className="tabular px-2 py-1.5 text-right">{r.gross > 0 ? yen(r.gross) : '—'}</td>
                  <td className="tabular px-2 py-1.5 text-right font-medium">
                    {r.gross > 0 ? yen(r.business) : '—'}
                  </td>
                  <td className="px-2 py-1.5 text-right whitespace-nowrap">
                    <button
                      type="button"
                      className={btn.small}
                      onClick={() => {
                        setEditingId(r.payee.id);
                        setDraft({
                          name: r.payee.name,
                          address: r.payee.address,
                          property: r.payee.property,
                          keyword: r.payee.keyword,
                        });
                      }}
                    >
                      編集
                    </button>
                    <button
                      type="button"
                      className={`${btn.danger} ml-1`}
                      onClick={() => {
                        if (confirm(`支払先「${r.payee.name}」を削除しますか?(取引は消えません)`)) {
                          store.deleteRentPayee(r.payee.id);
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
          {breakdown.unassigned.count > 0 && (
            <div className="mt-2">
              <Alert tone="warning">
                どの支払先にも振り分けられない地代家賃が{breakdown.unassigned.count}件({yen(breakdown.unassigned.gross)})あります。
                支払先の「振り分けキーワード」に、取引の摘要に含まれる語(例: 振込先名)を設定してください。
              </Alert>
            </div>
          )}
        </div>
      )}

      <form onSubmit={save} className="flex flex-wrap items-end gap-3">
        {field('name', '支払先の氏名・名称 *', '例: 山田不動産(株)', 'w-48', 60)}
        {field('address', '支払先の住所', '例: 東京都新宿区西新宿1-1-1', 'w-72', 120)}
        {field('property', '賃借物件(14字まで)', '例: 自宅兼事務所', 'w-40', 14)}
        {field('keyword', '振り分けキーワード(任意)', '例: ﾔﾏﾀﾞﾌﾄﾞｳｻﾝ', 'w-44', 30)}
        <button type="submit" className={btn.primary} disabled={!draft.name.trim()}>
          {editingId ? '更新' : '支払先を追加'}
        </button>
        {editingId && (
          <button
            type="button"
            className={btn.secondary}
            onClick={() => {
              setEditingId(null);
              setDraft(EMPTY);
            }}
          >
            キャンセル
          </button>
        )}
      </form>
      <p className="mt-3 text-xs leading-relaxed text-slate-500">
        本年中の賃借料は家事按分前の支払額、必要経費算入額は按分後の金額です(自宅兼事務所なら 家賃の全額 / 事業分)。
        支払先が1件なら、科目「地代家賃」の取引はすべてその支払先として集計します。複数あるときは、摘要に振り分けキーワードを含む取引を
        その支払先へ、キーワードなしの支払先が1件だけならその他の家賃をそこへ集計します。権利金・更新料は e-Tax ソフト上で追記してください。
      </p>
    </Card>
  );
}
