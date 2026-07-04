'use client';

import React, { useMemo, useState } from 'react';
import { Alert, btn, Card, EmptyState, input, PageHeader, selectCls } from '@/components/ui';
import { dateLabel, today, yen } from '@/lib/format';
import {
  computeInvoiceTotals,
  itemAmount,
  suggestInvoiceNumber,
} from '@/lib/invoice';
import { useStore } from '@/lib/store';
import { Invoice, InvoiceItem, IssuerProfile, uid } from '@/lib/types';

/** フォームで編集する請求書(保存前の下書き) */
type InvoiceDraft = Omit<Invoice, 'id' | 'createdAt'> & { id?: string };

function emptyItem(): InvoiceItem {
  return { id: uid(), description: '', quantity: 1, unitPrice: 0, taxRate: 10 };
}

function newDraft(invoices: Invoice[]): InvoiceDraft {
  const issueDate = today();
  return {
    number: suggestInvoiceNumber(invoices, issueDate),
    issueDate,
    dueDate: '',
    client: '',
    clientSuffix: '御中',
    title: '',
    items: [emptyItem()],
    taxIncluded: false,
    withholding: false,
    notes: '',
  };
}

export default function InvoicesPage() {
  const store = useStore();
  const [draft, setDraft] = useState<InvoiceDraft | null>(null);
  const [preview, setPreview] = useState<Invoice | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const invoices = useMemo(
    () =>
      [...store.invoices].sort(
        (a, b) => b.issueDate.localeCompare(a.issueDate) || b.createdAt - a.createdAt,
      ),
    [store.invoices],
  );

  const txIds = useMemo(() => new Set(store.transactions.map((t) => t.id)), [store.transactions]);
  /** 売掛計上済みか(紐付いた取引が現存するか) */
  const isRegistered = (inv: Invoice) => (inv.linkedTxIds ?? []).some((id) => txIds.has(id));

  const register = (inv: Invoice) => {
    const totals = computeInvoiceTotals(inv);
    if (
      !confirm(
        `請求書 ${inv.number} を${inv.issueDate.slice(0, 4)}年の売上として売掛金計上します(税込 ${yen(totals.grossTotal)}${totals.withholdingTax > 0 ? `・源泉 ${yen(totals.withholdingTax)} 差引` : ''})。よろしいですか?`,
      )
    ) {
      return;
    }
    const n = store.registerInvoiceSales(inv.id);
    setMessage(
      n > 0
        ? `売掛金として計上しました(取引${n}件)。入金時は銀行明細の入金行を「売掛金の回収」にしてください。`
        : '計上できませんでした。発行日と明細をご確認ください。',
    );
  };

  if (!store.ready) {
    return <div className="py-24 text-center text-sm text-slate-400">読み込み中…</div>;
  }

  return (
    <>
      <PageHeader
        title="請求書発行"
        description="適格請求書(インボイス)の要件に対応した請求書を作成・印刷(PDF保存)できます。発行した請求書はワンクリックで売掛金として売上計上され、帳簿・貸借対照表とつながります。"
      />

      <div className="space-y-6">
        <IssuerCard issuer={store.issuer} onSave={(p) => {
          store.updateIssuer(p);
          setMessage('請求元情報を保存しました。以後の請求書に印字されます。');
        }} />

        {message && <Alert tone="success">{message}</Alert>}

        {draft ? (
          <InvoiceForm
            draft={draft}
            onChange={setDraft}
            onCancel={() => setDraft(null)}
            onSave={() => {
              if (!draft.client.trim() || !draft.number.trim() || draft.items.length === 0) return;
              const clean = {
                ...draft,
                client: draft.client.trim(),
                number: draft.number.trim(),
                items: draft.items.filter((i) => itemAmount(i) !== 0 || i.description.trim() !== ''),
              };
              if (clean.id) {
                const { id, ...patch } = clean;
                store.updateInvoice(id, patch);
                setMessage(`請求書 ${clean.number} を更新しました。`);
              } else {
                store.addInvoice(clean);
                setMessage(`請求書 ${clean.number} を作成しました。「表示・印刷」からPDF保存できます。`);
              }
              setDraft(null);
            }}
          />
        ) : (
          <div>
            <button type="button" className={btn.primary} onClick={() => setDraft(newDraft(store.invoices))}>
              ＋ 新しい請求書を作成
            </button>
          </div>
        )}

        <Card title={`請求書一覧(${invoices.length}件)`}>
          {invoices.length === 0 ? (
            <EmptyState>
              請求書がありません。「新しい請求書を作成」から作成してください。
              請求元情報(氏名・登録番号・振込先)を先に登録しておくと便利です。
            </EmptyState>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[860px] text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
                    <th className="py-2 pr-2 font-medium">番号</th>
                    <th className="px-2 py-2 font-medium">発行日</th>
                    <th className="px-2 py-2 font-medium">請求先</th>
                    <th className="px-2 py-2 text-right font-medium">請求額</th>
                    <th className="px-2 py-2 font-medium">状態</th>
                    <th className="px-2 py-2 text-right font-medium">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {invoices.map((inv) => {
                    const totals = computeInvoiceTotals(inv);
                    const registered = isRegistered(inv);
                    return (
                      <tr key={inv.id} className="border-b border-slate-100 hover:bg-slate-50/60">
                        <td className="tabular py-2 pr-2 font-medium whitespace-nowrap">{inv.number}</td>
                        <td className="tabular px-2 py-2 whitespace-nowrap">
                          {inv.issueDate ? dateLabel(inv.issueDate) : '—'}
                        </td>
                        <td className="max-w-[200px] truncate px-2 py-2" title={inv.client}>
                          {inv.client} {inv.clientSuffix}
                        </td>
                        <td className="tabular px-2 py-2 text-right whitespace-nowrap">
                          {yen(totals.billedAmount)}
                          {totals.withholdingTax > 0 && (
                            <span className="ml-1 text-[10px] text-slate-400">源泉後</span>
                          )}
                        </td>
                        <td className="px-2 py-2 whitespace-nowrap">
                          {registered ? (
                            <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[11px] font-medium text-emerald-700">
                              ✓ 売掛計上済み
                            </span>
                          ) : (
                            <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-500">
                              未計上
                            </span>
                          )}
                        </td>
                        <td className="px-2 py-2 text-right whitespace-nowrap">
                          <div className="flex justify-end gap-1">
                            <button type="button" className={btn.small} onClick={() => setPreview(inv)}>
                              表示・印刷
                            </button>
                            {!registered && (
                              <button
                                type="button"
                                className={btn.small}
                                title="発生主義で売上計上します(借方: 売掛金 / 貸方: 売上)"
                                onClick={() => register(inv)}
                              >
                                売掛計上
                              </button>
                            )}
                            <button
                              type="button"
                              className={btn.small}
                              onClick={() => {
                                const { id, ...rest } = inv;
                                setDraft({ ...rest, id });
                              }}
                            >
                              編集
                            </button>
                            <button
                              type="button"
                              className={btn.small}
                              title="この内容を元に新しい請求書を作る"
                              onClick={() => {
                                const issueDate = today();
                                setDraft({
                                  ...inv,
                                  id: undefined,
                                  number: suggestInvoiceNumber(store.invoices, issueDate),
                                  issueDate,
                                  dueDate: '',
                                  items: inv.items.map((i) => ({ ...i, id: uid() })),
                                  linkedTxIds: undefined,
                                });
                              }}
                            >
                              複製
                            </button>
                            <button
                              type="button"
                              className={btn.danger}
                              onClick={() => {
                                if (
                                  confirm(
                                    `請求書 ${inv.number} を削除しますか?${registered ? '\n※計上済みの売掛金取引は削除されません(取引一覧から操作してください)。' : ''}`,
                                  )
                                ) {
                                  store.deleteInvoice(inv.id);
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
            「売掛計上」すると発行日付で売上(決済手段: 売掛金)が登録されます。入金があったら、取引一覧で銀行明細の入金行の科目を「売掛金の回収」にすると消し込まれます。
            源泉徴収ありの請求書は、源泉分が「事業主貸」として自動で差し引かれ、売掛金残高が実際の入金予定額と一致します。
          </p>
        </Card>
      </div>

      {preview && (
        <InvoicePreview
          invoice={preview}
          issuer={store.issuer}
          onClose={() => setPreview(null)}
        />
      )}
    </>
  );
}

/** 請求元(自分)の情報カード */
function IssuerCard({ issuer, onSave }: { issuer: IssuerProfile; onSave: (p: IssuerProfile) => void }) {
  const [open, setOpen] = useState(issuer.name === '');
  const [form, setForm] = useState<IssuerProfile>(issuer);
  const set = (patch: Partial<IssuerProfile>) => setForm((prev) => ({ ...prev, ...patch }));

  return (
    <Card
      title="請求元情報(自分の情報・請求書に印字されます)"
      action={
        <button type="button" className={btn.small} onClick={() => setOpen((v) => !v)}>
          {open ? '閉じる' : issuer.name ? '編集' : '登録する'}
        </button>
      }
    >
      {!open ? (
        issuer.name ? (
          <p className="text-sm text-slate-600">
            {issuer.name}
            {issuer.invoiceRegNumber && (
              <span className="ml-2 text-xs text-slate-400">登録番号: {issuer.invoiceRegNumber}</span>
            )}
          </p>
        ) : (
          <p className="text-sm text-slate-400">
            未登録です。氏名・登録番号・振込先を登録すると請求書に自動で印字されます。
          </p>
        )
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSave(form);
            setOpen(false);
          }}
          className="grid gap-3 sm:grid-cols-2"
        >
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-500">氏名・屋号 *</label>
            <input
              type="text"
              className={`${input} w-full`}
              value={form.name}
              onChange={(e) => set({ name: e.target.value })}
              required
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-500">
              インボイス登録番号(T+13桁・未登録なら空欄)
            </label>
            <input
              type="text"
              className={`${input} w-full`}
              placeholder="T1234567890123"
              value={form.invoiceRegNumber}
              onChange={(e) => set({ invoiceRegNumber: e.target.value.trim() })}
            />
            {form.invoiceRegNumber && !/^T\d{13}$/.test(form.invoiceRegNumber) && (
              <p className="mt-1 text-[11px] text-amber-700">
                ⚠ 登録番号は「T+数字13桁」の形式です(このままでも保存できます)
              </p>
            )}
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-500">住所</label>
            <input
              type="text"
              className={`${input} w-full`}
              value={form.address}
              onChange={(e) => set({ address: e.target.value })}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-500">電話番号</label>
              <input
                type="text"
                className={`${input} w-full`}
                value={form.tel}
                onChange={(e) => set({ tel: e.target.value })}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-500">メール</label>
              <input
                type="text"
                className={`${input} w-full`}
                value={form.email}
                onChange={(e) => set({ email: e.target.value })}
              />
            </div>
          </div>
          <div className="sm:col-span-2">
            <label className="mb-1 block text-xs font-medium text-slate-500">
              振込先(銀行名・支店・口座番号・名義)
            </label>
            <textarea
              className={`${input} w-full`}
              rows={2}
              placeholder={'○○銀行 △△支店(普通)1234567\nヤマダ タロウ'}
              value={form.bankInfo}
              onChange={(e) => set({ bankInfo: e.target.value })}
            />
          </div>
          <div className="sm:col-span-2">
            <button type="submit" className={btn.primary}>
              保存
            </button>
          </div>
        </form>
      )}
    </Card>
  );
}

/** 請求書の作成・編集フォーム */
function InvoiceForm({
  draft,
  onChange,
  onSave,
  onCancel,
}: {
  draft: InvoiceDraft;
  onChange: (d: InvoiceDraft) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const set = (patch: Partial<InvoiceDraft>) => onChange({ ...draft, ...patch });
  const setItem = (id: string, patch: Partial<InvoiceItem>) =>
    set({ items: draft.items.map((i) => (i.id === id ? { ...i, ...patch } : i)) });
  const totals = computeInvoiceTotals(draft);

  return (
    <Card title={draft.id ? `請求書 ${draft.number} を編集` : '新しい請求書'}>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <label className="mb-1 block text-xs font-medium text-slate-500">請求書番号 *</label>
          <input
            type="text"
            className={`${input} w-full`}
            value={draft.number}
            onChange={(e) => set({ number: e.target.value })}
            required
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-slate-500">発行日 *</label>
          <input
            type="date"
            className={`${input} w-full`}
            value={draft.issueDate}
            onChange={(e) => set({ issueDate: e.target.value })}
            required
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-slate-500">支払期限</label>
          <input
            type="date"
            className={`${input} w-full`}
            value={draft.dueDate}
            onChange={(e) => set({ dueDate: e.target.value })}
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-slate-500">敬称</label>
          <select
            className={selectCls}
            value={draft.clientSuffix}
            onChange={(e) => set({ clientSuffix: e.target.value })}
          >
            <option value="御中">御中(会社宛)</option>
            <option value="様">様(個人宛)</option>
          </select>
        </div>
        <div className="sm:col-span-2">
          <label className="mb-1 block text-xs font-medium text-slate-500">請求先名 *</label>
          <input
            type="text"
            className={`${input} w-full`}
            placeholder="株式会社ABC"
            value={draft.client}
            onChange={(e) => set({ client: e.target.value })}
            required
          />
        </div>
        <div className="sm:col-span-2">
          <label className="mb-1 block text-xs font-medium text-slate-500">件名</label>
          <input
            type="text"
            className={`${input} w-full`}
            placeholder="12月分 業務委託"
            value={draft.title}
            onChange={(e) => set({ title: e.target.value })}
          />
        </div>
      </div>

      {/* 明細 */}
      <div className="mt-5 overflow-x-auto">
        <table className="w-full min-w-[720px] text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
              <th className="py-2 pr-2 font-medium">品目・内容</th>
              <th className="w-24 px-2 py-2 text-right font-medium">数量</th>
              <th className="w-32 px-2 py-2 text-right font-medium">
                単価({draft.taxIncluded ? '税込' : '税抜'})
              </th>
              <th className="w-32 px-2 py-2 font-medium">税率</th>
              <th className="w-28 px-2 py-2 text-right font-medium">金額</th>
              <th className="w-12 px-2 py-2" />
            </tr>
          </thead>
          <tbody>
            {draft.items.map((item) => (
              <tr key={item.id} className="border-b border-slate-100">
                <td className="py-1.5 pr-2">
                  <input
                    type="text"
                    className={`${input} w-full`}
                    placeholder="デザイン制作(12月分)"
                    value={item.description}
                    onChange={(e) => setItem(item.id, { description: e.target.value })}
                  />
                </td>
                <td className="px-2 py-1.5">
                  <input
                    type="number"
                    className={`${input} w-full text-right`}
                    min={0}
                    step="any"
                    value={item.quantity}
                    onChange={(e) => setItem(item.id, { quantity: Number(e.target.value) })}
                  />
                </td>
                <td className="px-2 py-1.5">
                  <input
                    type="number"
                    className={`${input} w-full text-right`}
                    min={0}
                    value={item.unitPrice}
                    onChange={(e) => setItem(item.id, { unitPrice: Number(e.target.value) })}
                  />
                </td>
                <td className="px-2 py-1.5">
                  <select
                    className={selectCls}
                    value={item.taxRate}
                    onChange={(e) => setItem(item.id, { taxRate: Number(e.target.value) as 10 | 8 | 0 })}
                  >
                    <option value={10}>10%</option>
                    <option value={8}>8%(軽減)※</option>
                    <option value={0}>対象外</option>
                  </select>
                </td>
                <td className="tabular px-2 py-1.5 text-right whitespace-nowrap">{yen(itemAmount(item))}</td>
                <td className="px-2 py-1.5 text-right">
                  <button
                    type="button"
                    className={btn.danger}
                    disabled={draft.items.length === 1}
                    onClick={() => set({ items: draft.items.filter((i) => i.id !== item.id) })}
                  >
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-2">
        <button
          type="button"
          className={btn.small}
          onClick={() => set({ items: [...draft.items, emptyItem()] })}
        >
          ＋ 行を追加
        </button>
      </div>

      {/* オプションと合計 */}
      <div className="mt-4 flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-2 text-sm text-slate-700">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={draft.taxIncluded}
              onChange={(e) => set({ taxIncluded: e.target.checked })}
            />
            単価は税込で入力する
          </label>
          <label className="flex items-center gap-2" title="原稿料・デザイン料など、支払側が源泉徴収する報酬の場合">
            <input
              type="checkbox"
              checked={draft.withholding}
              onChange={(e) => set({ withholding: e.target.checked })}
            />
            源泉徴収(10.21%)を差し引いて請求する
          </label>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-500">備考</label>
            <textarea
              className={`${input} w-80 max-w-full`}
              rows={2}
              placeholder="いつもお世話になっております。"
              value={draft.notes}
              onChange={(e) => set({ notes: e.target.value })}
            />
          </div>
        </div>
        <div className="tabular min-w-64 space-y-1 rounded-lg bg-slate-50 p-4 text-sm">
          <div className="flex justify-between text-slate-500">
            <span>小計(税抜)</span>
            <span>{yen(totals.subtotal)}</span>
          </div>
          {totals.rates
            .filter((r) => r.rate !== 0)
            .map((r) => (
              <div key={r.rate} className="flex justify-between text-slate-500">
                <span>消費税({r.rate}%)</span>
                <span>{yen(r.tax)}</span>
              </div>
            ))}
          {totals.withholdingTax > 0 && (
            <div className="flex justify-between text-rose-600">
              <span>源泉徴収税額</span>
              <span>▲{yen(totals.withholdingTax)}</span>
            </div>
          )}
          <div className="flex justify-between border-t border-slate-200 pt-1 text-base font-bold text-slate-900">
            <span>ご請求金額</span>
            <span>{yen(totals.billedAmount)}</span>
          </div>
        </div>
      </div>

      <div className="mt-5 flex gap-2">
        <button
          type="button"
          className={btn.primary}
          disabled={!draft.client.trim() || !draft.number.trim() || !draft.issueDate}
          onClick={onSave}
        >
          {draft.id ? '更新する' : '作成する'}
        </button>
        <button type="button" className={btn.secondary} onClick={onCancel}>
          キャンセル
        </button>
      </div>
    </Card>
  );
}

/** 請求書プレビュー(印刷 = ブラウザの印刷ダイアログからPDF保存) */
function InvoicePreview({
  invoice,
  issuer,
  onClose,
}: {
  invoice: Invoice;
  issuer: IssuerProfile;
  onClose: () => void;
}) {
  const totals = computeInvoiceTotals(invoice);
  const hasReduced = invoice.items.some((i) => i.taxRate === 8);

  return (
    <div className="fixed inset-0 z-50 overflow-auto bg-slate-900/60 p-4 md:p-8" onClick={onClose}>
      <div className="mx-auto max-w-[820px]" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex justify-end gap-2 print:hidden">
          <button type="button" className={`${btn.primary} bg-slate-700 hover:bg-slate-800`} onClick={() => window.print()}>
            🖨 印刷 / PDF保存
          </button>
          <button type="button" className={btn.secondary} onClick={onClose}>
            閉じる
          </button>
        </div>

        {/* 請求書シート(印刷時はこの要素だけが出力される) */}
        <div className="invoice-sheet rounded-lg bg-white p-8 text-slate-900 shadow-xl md:p-12">
          <h1 className="text-center text-2xl font-bold tracking-[0.3em]">請求書</h1>

          <div className="mt-6 flex items-start justify-between gap-6">
            <div>
              <div className="border-b-2 border-slate-800 pb-1 text-lg font-semibold">
                {invoice.client} {invoice.clientSuffix}
              </div>
              {invoice.title && <div className="mt-3 text-sm">件名: {invoice.title}</div>}
              <div className="mt-4 text-sm">下記のとおりご請求申し上げます。</div>
              <div className="mt-3 inline-block rounded bg-slate-100 px-4 py-2">
                <span className="mr-4 text-sm">ご請求金額</span>
                <span className="tabular text-2xl font-bold">{yen(totals.billedAmount)}</span>
                <span className="ml-1 text-xs text-slate-500">(税込)</span>
              </div>
              {invoice.dueDate && (
                <div className="mt-2 text-sm">お支払期限: {dateLabel(invoice.dueDate)}</div>
              )}
            </div>
            <div className="shrink-0 text-right text-sm leading-relaxed">
              <div className="tabular">請求書番号: {invoice.number}</div>
              <div className="tabular">発行日: {invoice.issueDate ? dateLabel(invoice.issueDate) : ''}</div>
              <div className="mt-4 font-semibold">{issuer.name || '(請求元未設定)'}</div>
              {issuer.invoiceRegNumber && <div>登録番号: {issuer.invoiceRegNumber}</div>}
              {issuer.address && <div>{issuer.address}</div>}
              {issuer.tel && <div>TEL: {issuer.tel}</div>}
              {issuer.email && <div>{issuer.email}</div>}
            </div>
          </div>

          <table className="mt-6 w-full text-sm">
            <thead>
              <tr className="border-y-2 border-slate-800 bg-slate-50 text-left text-xs">
                <th className="px-2 py-2 font-semibold">品目・内容</th>
                <th className="w-20 px-2 py-2 text-right font-semibold">数量</th>
                <th className="w-28 px-2 py-2 text-right font-semibold">
                  単価({invoice.taxIncluded ? '税込' : '税抜'})
                </th>
                <th className="w-16 px-2 py-2 text-right font-semibold">税率</th>
                <th className="w-28 px-2 py-2 text-right font-semibold">金額</th>
              </tr>
            </thead>
            <tbody>
              {invoice.items.map((item) => (
                <tr key={item.id} className="border-b border-slate-200">
                  <td className="px-2 py-2">
                    {item.description}
                    {item.taxRate === 8 && ' ※'}
                  </td>
                  <td className="tabular px-2 py-2 text-right">{item.quantity}</td>
                  <td className="tabular px-2 py-2 text-right">{yen(item.unitPrice)}</td>
                  <td className="tabular px-2 py-2 text-right">
                    {item.taxRate === 0 ? '—' : `${item.taxRate}%`}
                  </td>
                  <td className="tabular px-2 py-2 text-right">{yen(itemAmount(item))}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="mt-4 flex justify-end">
            <div className="tabular w-72 space-y-1 text-sm">
              {totals.rates.map((r) => (
                <div key={r.rate} className="flex justify-between text-slate-600">
                  <span>
                    {r.rate === 0 ? '対象外' : `${r.rate}%対象(税抜)`}
                    {r.rate === 8 && ' ※'}
                  </span>
                  <span>
                    {yen(r.base)}
                    {r.rate !== 0 && <span className="ml-2">消費税 {yen(r.tax)}</span>}
                  </span>
                </div>
              ))}
              <div className="flex justify-between border-t border-slate-300 pt-1">
                <span>合計(税込)</span>
                <span>{yen(totals.grossTotal)}</span>
              </div>
              {totals.withholdingTax > 0 && (
                <div className="flex justify-between">
                  <span>源泉徴収税額</span>
                  <span>▲{yen(totals.withholdingTax)}</span>
                </div>
              )}
              <div className="flex justify-between border-t-2 border-slate-800 pt-1 text-base font-bold">
                <span>ご請求金額</span>
                <span>{yen(totals.billedAmount)}</span>
              </div>
            </div>
          </div>

          {hasReduced && <div className="mt-3 text-xs text-slate-500">※は軽減税率(8%)対象</div>}

          {(issuer.bankInfo || invoice.notes) && (
            <div className="mt-6 space-y-3 text-sm">
              {issuer.bankInfo && (
                <div className="rounded border border-slate-300 p-3">
                  <div className="mb-1 text-xs font-semibold text-slate-500">お振込先</div>
                  <div className="whitespace-pre-wrap">{issuer.bankInfo}</div>
                  <div className="mt-1 text-xs text-slate-500">
                    ※恐れ入りますが振込手数料は貴社にてご負担ください。
                  </div>
                </div>
              )}
              {invoice.notes && (
                <div>
                  <div className="mb-1 text-xs font-semibold text-slate-500">備考</div>
                  <div className="whitespace-pre-wrap">{invoice.notes}</div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
