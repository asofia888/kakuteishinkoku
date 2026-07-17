'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, btn, Card, EmptyState, input, ModalShell, PageHeader, selectCls } from '@/components/ui';
import {
  accountLabel,
  accountsOf,
  EXCLUDED_ACCOUNT,
  EXCLUDED_LABEL,
  fundLabel,
  fundsOf,
  isExcluded,
  isSettlement,
  settlementsOf,
} from '@/lib/accounts';
import { availableYears, DEPRECIATION_MIN } from '@/lib/aggregate';
import {
  IMPORT_MODES,
  ImportMode,
  ParsedRow,
  parseCsv,
  readFileText,
  resolveTypeAndAmount,
} from '@/lib/csv';
import {
  addFiles,
  countsByTx,
  deleteFile,
  formatBytes,
  listFiles,
  StoredFile,
} from '@/lib/files';
import { dateLabel, today, yen } from '@/lib/format';
import { suggestAccount } from '@/lib/rules';
import { useStore } from '@/lib/store';
import { effectiveTaxCategory, TAX_CATEGORY_LABELS } from '@/lib/tax';
import { FundId, TaxCategory, Transaction, TxType } from '@/lib/types';

/** 取込プレビューの1行 */
interface PreviewRow {
  include: boolean;
  date: string;
  description: string;
  amount: number;
  type: TxType;
  account: string | null;
  /** 既存データと日付・金額・摘要が一致(重複の可能性) */
  dup: boolean;
  /** 「すべて支出/収入」モードで符号が逆の行(返金・キャンセルの可能性) */
  refund: boolean;
}

type StatusFilter = 'all' | 'unclassified' | 'unapproved' | 'approved' | 'excluded';

/** 取込時に選べる決済手段(明細の種類ごと) */
function importFundOptions(mode: ImportMode): FundId[] {
  if (mode === 'expense') return ['card', 'bank', 'cash', 'owner'];
  if (mode === 'income') return ['bank', 'cash', 'owner'];
  return ['bank', 'cash'];
}

export default function TransactionsPage() {
  const store = useStore();

  // ── CSV取込 ──
  const fileRef = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<ImportMode>('auto');
  /** 取込明細の決済手段(銀行明細=普通預金 / カード明細=クレジットカード未払金) */
  const [importFund, setImportFund] = useState<FundId>('bank');
  const [rawRows, setRawRows] = useState<ParsedRow[] | null>(null);
  const [preview, setPreview] = useState<PreviewRow[] | null>(null);
  /** CSV取込パネル内に表示するメッセージ */
  const [message, setMessage] = useState<string | null>(null);
  /** 取引一覧カード内に表示するメッセージ(ルール適用・手入力の結果) */
  const [listMessage, setListMessage] = useState<string | null>(null);
  /** 削除した取引の履歴(「元に戻す」で新しい順に1回ずつ復元する。直近20回分) */
  const [deletedStack, setDeletedStack] = useState<Transaction[][]>([]);
  const lastDeleted = deletedStack.length > 0 ? deletedStack[deletedStack.length - 1] : null;

  // ── 証憑(添付ファイル)──
  const [fileCounts, setFileCounts] = useState<Map<string, number>>(new Map());
  const [attachTx, setAttachTx] = useState<Transaction | null>(null);
  useEffect(() => {
    void countsByTx().then(setFileCounts);
  }, []);
  const refreshFileCounts = () => void countsByTx().then(setFileCounts);

  // ── フィルタ ──
  const [yearFilter, setYearFilter] = useState<string>('all');
  const [monthFilter, setMonthFilter] = useState<string>('all');
  const [typeFilter, setTypeFilter] = useState<'all' | TxType>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [q, setQ] = useState('');
  /** 金額の範囲絞り込み(電子帳簿保存法の検索要件: 金額は範囲指定で探せること) */
  const [amountMin, setAmountMin] = useState('');
  const [amountMax, setAmountMax] = useState('');
  const [visible, setVisible] = useState(200);

  // ── 手入力フォーム ──
  const [showForm, setShowForm] = useState(false);

  const years = useMemo(
    () => availableYears(store.transactions, new Date().getFullYear()),
    [store.transactions],
  );

  const buildPreview = (rows: ParsedRow[], m: ImportMode): PreviewRow[] => {
    const existing = new Set(
      store.transactions.map((t) => `${t.date}|${t.amount}|${t.description}`),
    );
    return rows.map((row) => {
      const { type, amount } = resolveTypeAndAmount(row, m);
      const dup = existing.has(`${row.date}|${amount}|${row.description}`);
      // 「すべて支出」モードのマイナス行は返金・キャンセルの可能性が高く、
      // そのまま正の経費にすると過大計上になるため既定で取込対象から外す
      const refund = (m === 'expense' || m === 'income') && row.amount < 0;
      return {
        include: !dup && !refund,
        date: row.date,
        description: row.description,
        amount,
        type,
        account: suggestAccount(row.description, type, store.rules),
        dup,
        refund,
      };
    });
  };

  const onFile = async (file: File) => {
    setMessage(null);
    const text = await readFileText(file);
    const { rows, skipped, guessed } = parseCsv(text);
    if (rows.length === 0) {
      setMessage('CSVから明細を読み取れませんでした。日付・金額・摘要を含むCSVかご確認ください。');
      setRawRows(null);
      setPreview(null);
      // クリアしないと同じファイルを選び直しても onChange が発火しない
      if (fileRef.current) fileRef.current.value = '';
      return;
    }
    setRawRows(rows);
    setPreview(buildPreview(rows, mode));
    setPreviewEdited(false);
    const notices: string[] = [];
    // 明細行が静かに欠落すると帳簿が誤るため、読み飛ばした行数を必ず知らせる
    if (skipped > 0) {
      notices.push(
        `明細として認識できない${skipped}行(前置き・集計行など)は読み飛ばしています。件数が明細と合わない場合はCSVの内容をご確認ください。`,
      );
    }
    // 列名を確認できなかったCSVは出金列の正値を収入と誤判定しうる
    if (guessed) {
      notices.push(
        '列名ヘッダーを確認できないCSVのため、各行から日付・金額・摘要を推測して読み取っています。特に収入/支出の判定が正しいか、プレビューでご確認ください。',
      );
    }
    if (notices.length > 0) {
      setMessage(`${rows.length}件の明細を読み取りました。${notices.join('')}`);
    }
  };

  const [previewEdited, setPreviewEdited] = useState(false);

  const changeMode = (m: ImportMode) => {
    if (
      rawRows &&
      previewEdited &&
      !confirm('判定モードを変更するとプレビューの修正内容(科目・種別・選択)は作り直されます。よろしいですか?')
    ) {
      return;
    }
    setMode(m);
    // 明細の種類に合わせた既定の決済手段(カード明細なら未払金経由の発生主義になる)
    setImportFund(m === 'expense' ? 'card' : 'bank');
    if (rawRows) {
      setPreview(buildPreview(rawRows, m));
      setPreviewEdited(false);
    }
  };

  const confirmImport = () => {
    if (!preview) return;
    const rows = preview.filter((r) => r.include);
    if (rows.length === 0) return;
    const autoCount = rows.filter((r) => r.account !== null).length;
    store.addTransactions(
      rows.map((r) => ({
        date: r.date,
        amount: r.amount,
        description: r.description,
        type: r.type,
        account: r.account,
        approved: false,
        source: 'csv' as const,
        fund: importFund,
      })),
    );
    setPreview(null);
    setRawRows(null);
    if (fileRef.current) fileRef.current.value = '';
    setMessage(
      `${rows.length}件を取り込みました(自動仕訳 ${autoCount}件 / 未仕訳 ${rows.length - autoCount}件)。内容を確認して承認してください。`,
    );
  };

  const updatePreviewRow = (i: number, patch: Partial<PreviewRow>) => {
    setPreviewEdited(true);
    setPreview((prev) => {
      if (!prev) return prev;
      const next = [...prev];
      const merged = { ...next[i], ...patch };
      // 種別を変えたら科目を提案し直す
      if (patch.type && patch.type !== prev[i].type) {
        merged.account = suggestAccount(merged.description, patch.type, store.rules);
      }
      next[i] = merged;
      return next;
    });
  };

  // ── 一覧のフィルタリング ──
  const filtered = useMemo(() => {
    const qq = q.trim().toLowerCase();
    const min = amountMin === '' ? null : Number(amountMin);
    const max = amountMax === '' ? null : Number(amountMax);
    return [...store.transactions]
      .filter((t) => {
        if (yearFilter !== 'all' && !t.date.startsWith(`${yearFilter}-`)) return false;
        if (monthFilter !== 'all' && t.date.slice(5, 7) !== monthFilter) return false;
        if (typeFilter !== 'all' && t.type !== typeFilter) return false;
        if (statusFilter === 'unclassified' && t.account !== null) return false;
        if (
          statusFilter === 'unapproved' &&
          (t.approved || t.account === null || isExcluded(t.account))
        )
          return false;
        if (statusFilter === 'approved' && !t.approved) return false;
        if (statusFilter === 'excluded' && !isExcluded(t.account)) return false;
        if (qq && !t.description.toLowerCase().includes(qq)) return false;
        if (min !== null && Number.isFinite(min) && t.amount < min) return false;
        if (max !== null && Number.isFinite(max) && t.amount > max) return false;
        return true;
      })
      .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt);
  }, [store.transactions, yearFilter, monthFilter, typeFilter, statusFilter, q, amountMin, amountMax]);

  // 対象外(プライベート)は承認の概念の外なので一括承認からも除く
  const unapprovedInView = filtered.filter(
    (t) => t.account !== null && !isExcluded(t.account) && !t.approved,
  );

  const undoDelete = () => {
    if (!lastDeleted) return;
    store.restoreTransactions(lastDeleted);
    setDeletedStack((prev) => prev.slice(0, -1));
    setListMessage(
      lastDeleted.length === 1
        ? `「${lastDeleted[0].description}」を元に戻しました。`
        : `${lastDeleted.length}件の取引を元に戻しました。`,
    );
  };

  if (!store.ready) {
    return <div className="py-24 text-center text-sm text-slate-500">読み込み中…</div>;
  }

  return (
    <>
      <PageHeader
        title="取引一覧"
        description="銀行・クレジットカードのCSV明細を取り込み、自動仕訳の結果を確認・修正・承認します。"
      />

      <div className="space-y-6">
        {/* ── CSV取込パネル ── */}
        <Card title="CSV明細の取り込み">
          <div className="flex flex-wrap items-end gap-4">
            <div>
              <label htmlFor="tx-import-mode" className="mb-1 block text-xs font-medium text-slate-500">
                明細の種類(収入/支出の判定)
              </label>
              <select
                id="tx-import-mode"
                className={selectCls}
                value={mode}
                onChange={(e) => changeMode(e.target.value as ImportMode)}
              >
                {IMPORT_MODES.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-slate-500">
                {IMPORT_MODES.find((m) => m.id === mode)?.hint}
              </p>
            </div>
            <div>
              <label htmlFor="tx-import-fund" className="mb-1 block text-xs font-medium text-slate-500">
                決済手段(複式仕訳の相手勘定)
              </label>
              <select
                id="tx-import-fund"
                className={selectCls}
                value={importFund}
                onChange={(e) => setImportFund(e.target.value as FundId)}
              >
                {importFundOptions(mode).map((f) => (
                  <option key={f} value={f}>
                    {fundLabel(f)}
                  </option>
                ))}
              </select>
              <p className="mt-1 max-w-56 text-xs text-slate-500">
                カード明細は「クレジットカード(未払金)」のまま取り込むと、購入時に経費・引落し時に未払金の決済として二重計上なく記帳されます。
              </p>
            </div>
            <div>
              <label htmlFor="tx-csv-file" className="mb-1 block text-xs font-medium text-slate-500">
                CSVファイル(Shift_JIS / UTF-8 自動判定)
              </label>
              <input
                id="tx-csv-file"
                ref={fileRef}
                type="file"
                accept=".csv,text/csv"
                className="block text-sm text-slate-600 file:mr-3 file:rounded-lg file:border-0 file:bg-blue-50 file:px-4 file:py-2 file:text-sm file:font-medium file:text-blue-700 hover:file:bg-blue-100"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void onFile(f);
                }}
              />
            </div>
          </div>

          {message && (
            <div className="mt-4">
              <Alert tone="info">{message}</Alert>
            </div>
          )}

          {preview && (
            <div className="mt-5">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-semibold text-slate-700">
                  取込プレビュー({preview.filter((r) => r.include).length}/{preview.length}件を取込)
                  ── 自動仕訳の結果を確認し、必要なら修正してください
                </h3>
                <div className="flex gap-2">
                  <button
                    type="button"
                    className={btn.secondary}
                    onClick={() => {
                      setPreview(null);
                      setRawRows(null);
                      if (fileRef.current) fileRef.current.value = '';
                    }}
                  >
                    キャンセル
                  </button>
                  <button
                    type="button"
                    className={btn.primary}
                    disabled={preview.every((r) => !r.include)}
                    onClick={confirmImport}
                  >
                    この内容で取り込む
                  </button>
                </div>
              </div>
              <div className="max-h-96 overflow-auto rounded-lg border border-slate-200">
                <table className="w-full min-w-[760px] text-sm">
                  <thead className="sticky top-0 bg-slate-50">
                    <tr className="text-left text-xs text-slate-500">
                      <th className="px-3 py-2 font-medium">
                        <input
                          type="checkbox"
                          aria-label="すべて選択"
                          checked={preview.every((r) => r.include)}
                          onChange={(e) => {
                            setPreviewEdited(true);
                            setPreview((prev) =>
                              prev ? prev.map((r) => ({ ...r, include: e.target.checked })) : prev,
                            );
                          }}
                        />
                      </th>
                      <th className="px-3 py-2 font-medium">日付</th>
                      <th className="px-3 py-2 font-medium">摘要</th>
                      <th className="px-3 py-2 text-right font-medium">金額</th>
                      <th className="px-3 py-2 font-medium">種別</th>
                      <th className="px-3 py-2 font-medium">勘定科目(自動仕訳)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.map((r, i) => (
                      <tr
                        key={i}
                        className={`border-t border-slate-100 ${r.include ? '' : 'opacity-45'}`}
                      >
                        <td className="px-3 py-1.5">
                          <input
                            type="checkbox"
                            aria-label={`${r.description} を取込対象にする`}
                            checked={r.include}
                            onChange={(e) => updatePreviewRow(i, { include: e.target.checked })}
                          />
                        </td>
                        <td className="tabular px-3 py-1.5 whitespace-nowrap">{dateLabel(r.date)}</td>
                        <td className="max-w-[240px] truncate px-3 py-1.5" title={r.description}>
                          {r.description}
                          {r.dup && (
                            <span className="ml-2 rounded bg-rose-100 px-1.5 py-0.5 text-[10px] font-medium text-rose-700">
                              重複の可能性
                            </span>
                          )}
                          {r.refund && (
                            <span
                              className="ml-2 rounded bg-violet-100 px-1.5 py-0.5 text-[10px] font-medium text-violet-700"
                              title="マイナス金額の行です。返金・キャンセルの場合はそのまま除外するか、種別を切り替えて取り込んでください"
                            >
                              返金・ｷｬﾝｾﾙ?
                            </span>
                          )}
                        </td>
                        <td className="tabular px-3 py-1.5 text-right whitespace-nowrap">
                          {yen(r.amount)}
                        </td>
                        <td className="px-3 py-1.5">
                          <select
                            aria-label={`${r.description} の種別`}
                            className={selectCls}
                            value={r.type}
                            onChange={(e) => updatePreviewRow(i, { type: e.target.value as TxType })}
                          >
                            <option value="income">収入</option>
                            <option value="expense">支出</option>
                          </select>
                        </td>
                        <td className="px-3 py-1.5">
                          <AccountSelect
                            type={r.type}
                            value={r.account}
                            aria-label={`${r.description} の勘定科目`}
                            onChange={(v) => updatePreviewRow(i, { account: v })}
                          />
                          <DepreciationHint account={r.account} amount={r.amount} type={r.type} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </Card>

        {/* ── 取引一覧 ── */}
        <Card
          title={`取引一覧(${filtered.length}件)`}
          action={
            <div className="flex flex-wrap gap-2">
              <button type="button" className={btn.small} onClick={() => setShowForm((v) => !v)}>
                ＋ 手入力で追加
              </button>
              <button
                type="button"
                className={btn.small}
                onClick={() => {
                  const n = store.reapplyRules();
                  setListMessage(
                    n > 0
                      ? `自動仕訳ルールを適用し、${n}件の未仕訳取引に勘定科目を割り当てました。`
                      : '未仕訳の取引に一致するルールはありませんでした。',
                  );
                }}
              >
                🤖 未仕訳にルール適用
              </button>
              <button
                type="button"
                className={btn.small}
                disabled={unapprovedInView.length === 0}
                onClick={() =>
                  store.approveTransactions(
                    unapprovedInView.map((t) => t.id),
                    true,
                  )
                }
              >
                ✓ 絞り込み結果を一括承認({unapprovedInView.length})
              </button>
            </div>
          }
        >
          {showForm && (
            <ManualForm
              onDone={(msg) => {
                setShowForm(false);
                setListMessage(msg);
              }}
            />
          )}

          {lastDeleted && (
            <div className="mb-4">
              <Alert tone="info">
                {lastDeleted.length === 1
                  ? `「${lastDeleted[0].description}」(${yen(lastDeleted[0].amount)})を削除しました。`
                  : `${lastDeleted.length}件の取引を削除しました。`}
                <button
                  type="button"
                  className="ml-2 font-semibold text-blue-700 underline hover:text-blue-800"
                  onClick={undoDelete}
                >
                  元に戻す{deletedStack.length > 1 ? `(あと${deletedStack.length}回)` : ''}
                </button>
              </Alert>
            </div>
          )}

          {listMessage && (
            <div className="mb-4">
              <Alert tone="info">{listMessage}</Alert>
            </div>
          )}

          <div className="mb-4 flex flex-wrap items-center gap-2">
            <select
              aria-label="年で絞り込み"
              className={selectCls}
              value={yearFilter}
              onChange={(e) => setYearFilter(e.target.value)}
            >
              <option value="all">すべての年</option>
              {years.map((y) => (
                <option key={y} value={y}>
                  {y}年
                </option>
              ))}
            </select>
            <select
              aria-label="月で絞り込み"
              className={selectCls}
              value={monthFilter}
              onChange={(e) => setMonthFilter(e.target.value)}
            >
              <option value="all">すべての月</option>
              {Array.from({ length: 12 }, (_, i) => {
                const mm = String(i + 1).padStart(2, '0');
                return (
                  <option key={mm} value={mm}>
                    {i + 1}月
                  </option>
                );
              })}
            </select>
            <select
              aria-label="収支で絞り込み"
              className={selectCls}
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value as 'all' | TxType)}
            >
              <option value="all">収支: すべて</option>
              <option value="income">収入のみ</option>
              <option value="expense">支出のみ</option>
            </select>
            <select
              aria-label="状態で絞り込み"
              className={selectCls}
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
            >
              <option value="all">状態: すべて</option>
              <option value="unclassified">未仕訳のみ</option>
              <option value="unapproved">未承認のみ</option>
              <option value="approved">承認済みのみ</option>
              <option value="excluded">対象外のみ</option>
            </select>
            <input
              type="search"
              aria-label="摘要で検索"
              className={`${input} flex-1 min-w-40`}
              placeholder="摘要で検索…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <input
              type="number"
              inputMode="numeric"
              aria-label="金額の下限で絞り込み"
              className={`${input} w-28`}
              placeholder="金額 下限"
              value={amountMin}
              onChange={(e) => setAmountMin(e.target.value)}
            />
            <span className="text-xs text-slate-500" aria-hidden>
              〜
            </span>
            <input
              type="number"
              inputMode="numeric"
              aria-label="金額の上限で絞り込み"
              className={`${input} w-28`}
              placeholder="金額 上限"
              value={amountMax}
              onChange={(e) => setAmountMax(e.target.value)}
            />
          </div>

          {filtered.length === 0 ? (
            <EmptyState>条件に一致する取引がありません。</EmptyState>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[980px] text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
                    <th className="py-2 pr-2 font-medium">日付</th>
                    <th className="px-2 py-2 font-medium">種別</th>
                    <th className="px-2 py-2 font-medium">摘要</th>
                    <th className="px-2 py-2 text-right font-medium">金額</th>
                    <th className="px-2 py-2 font-medium">決済</th>
                    <th className="px-2 py-2 font-medium">勘定科目</th>
                    <th className="px-2 py-2 text-right font-medium">経費計上額</th>
                    <th className="px-2 py-2 font-medium">状態</th>
                    <th className="px-2 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {filtered.slice(0, visible).map((t) => (
                    <TxRow
                      key={t.id}
                      t={t}
                      fileCount={fileCounts.get(t.id) ?? 0}
                      onAttach={setAttachTx}
                      onDeleted={(tx) => {
                        // 連続削除に備えて履歴として積む(直近20回分だけ保持)
                        setDeletedStack((prev) => [...prev.slice(-19), [tx]]);
                        setListMessage(null);
                      }}
                    />
                  ))}
                </tbody>
              </table>
              {filtered.length > visible && (
                <div className="mt-3 text-center">
                  <button
                    type="button"
                    className={btn.secondary}
                    onClick={() => setVisible((v) => v + 200)}
                  >
                    さらに表示({filtered.length - visible}件)
                  </button>
                </div>
              )}
            </div>
          )}
        </Card>
      </div>

      {attachTx && (
        <AttachmentsModal
          t={attachTx}
          onClose={() => {
            setAttachTx(null);
            refreshFileCounts();
          }}
        />
      )}
    </>
  );
}

/** 勘定科目セレクト(未仕訳 + 種別に合う科目 + 決済・振替 + 対象外) */
function AccountSelect({
  type,
  value,
  onChange,
  id,
  'aria-label': ariaLabel,
}: {
  type: TxType;
  value: string | null;
  onChange: (v: string | null) => void;
  id?: string;
  'aria-label'?: string;
}) {
  return (
    <select
      id={id}
      aria-label={ariaLabel}
      className={`${selectCls} ${value === null ? 'border-amber-400 bg-amber-50' : ''}`}
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
    >
      <option value="">未仕訳</option>
      <optgroup label="事業の科目">
        {accountsOf(type).map((a) => (
          <option key={a.id} value={a.id}>
            {a.label}
          </option>
        ))}
      </optgroup>
      {/* 売掛金の入金・カード引落しは損益でなく資産・負債の決済として仕訳される */}
      <optgroup label="決済・振替(売上・経費に入らない)">
        {settlementsOf(type).map((a) => (
          <option key={a.id} value={a.id}>
            {a.label}
          </option>
        ))}
      </optgroup>
      {/* 事業と無関係な取引は「対象外」にすると集計・アラートから除外される */}
      <option value={EXCLUDED_ACCOUNT}>{EXCLUDED_LABEL}</option>
    </select>
  );
}

/** 決済手段セレクト(取引一覧の行用) */
function FundSelect({ t }: { t: Transaction }) {
  const store = useStore();
  const options = fundsOf(t.type);
  const known = options.some((f) => f.id === t.fund);
  return (
    <select
      aria-label={`${t.description} の決済手段`}
      className={selectCls}
      value={t.fund}
      title="この取引で動いた資金(複式仕訳の相手勘定)"
      onChange={(e) => store.updateTransaction(t.id, { fund: e.target.value as FundId })}
    >
      {!known && <option value={t.fund}>{fundLabel(t.fund)}</option>}
      {options.map((f) => (
        <option key={f.id} value={f.id}>
          {f.short}
        </option>
      ))}
    </select>
  );
}

/** 資金移動の相手側(移動先/移動元)セレクト */
function CounterFundControl({ t }: { t: Transaction }) {
  const store = useStore();
  if (t.account !== 'fund_transfer') return null;
  const counter = t.counterFund ?? (t.fund === 'cash' ? 'bank' : 'cash');
  const options = (['bank', 'cash'] as FundId[]).filter((f) => f !== t.fund);
  if (!options.includes(counter)) options.unshift(counter);
  return (
    <div className="mt-1 flex items-center gap-1 text-[11px] text-slate-500">
      <span>{t.type === 'expense' ? '移動先:' : '移動元:'}</span>
      <select
        aria-label={`${t.description} の${t.type === 'expense' ? '移動先' : '移動元'}`}
        className="rounded border border-slate-200 bg-white px-1 py-0.5 text-[11px] text-slate-600"
        value={counter}
        onChange={(e) => store.updateTransaction(t.id, { counterFund: e.target.value as FundId })}
      >
        {options.map((f) => (
          <option key={f} value={f}>
            {fundLabel(f)}
          </option>
        ))}
      </select>
    </div>
  );
}

/** 消費税の税区分と適格請求書チェック(課税事業者の設定時のみ表示) */
function TaxControls({ t }: { t: Transaction }) {
  const store = useStore();
  if (!store.taxSettings.taxable) return null;
  if (t.account === null || isExcluded(t.account) || isSettlement(t.account)) return null;
  const cat = effectiveTaxCategory(t);
  const taxable = cat === 'taxable10' || cat === 'taxable8';
  return (
    <div className="mt-1 flex flex-wrap items-center gap-2">
      <select
        aria-label={`${t.description} の税区分`}
        className="rounded border border-slate-200 bg-white px-1 py-0.5 text-[11px] text-slate-600"
        value={cat}
        title="消費税の税区分(科目から自動判定。住宅家賃の按分など必要に応じて変更)"
        onChange={(e) =>
          store.updateTransaction(t.id, { taxCategory: e.target.value as TaxCategory })
        }
      >
        {(Object.keys(TAX_CATEGORY_LABELS) as TaxCategory[]).map((c) => (
          <option key={c} value={c}>
            {TAX_CATEGORY_LABELS[c]}
          </option>
        ))}
      </select>
      {t.type === 'expense' && taxable && store.taxSettings.method === 'general' && (
        <label
          className="flex items-center gap-1 text-[11px] text-slate-500"
          title="適格請求書(インボイス)の有無。「なし」の仕入は経過措置分(2026/9まで80%・2029/9まで50%)のみ控除されます"
        >
          <input
            type="checkbox"
            checked={t.qualifiedInvoice !== false}
            onChange={(e) =>
              store.updateTransaction(t.id, {
                qualifiedInvoice: e.target.checked ? undefined : false,
              })
            }
          />
          適格請求書
        </label>
      )}
    </div>
  );
}

/** 10万円以上の消耗品費に出す減価償却の注意(取引一覧・取込プレビュー共用) */
function DepreciationHint({ account, amount, type }: { account: string | null; amount: number; type: TxType }) {
  if (type !== 'expense' || account !== 'supplies' || amount < DEPRECIATION_MIN) return null;
  return (
    <div
      className="mt-1 text-[10px] font-medium text-amber-700"
      title="10万円以上の備品等は原則、減価償却資産です。科目を「固定資産の取得(振替)」に変更し、固定資産台帳ページに登録すると、償却費(定額法・一括償却・少額特例)が自動計算されます。"
    >
      ⚠ 10万円以上 — 科目を「固定資産の取得」にして台帳へ
    </div>
  );
}

function TxRow({
  t,
  fileCount,
  onAttach,
  onDeleted,
}: {
  t: Transaction;
  fileCount: number;
  onAttach: (t: Transaction) => void;
  onDeleted: (t: Transaction) => void;
}) {
  const store = useStore();
  const anbunNote = t.type === 'expense' && t.anbunApplied && t.businessAmount !== t.amount;

  return (
    <tr className="border-b border-slate-100 hover:bg-slate-50/60">
      <td className="tabular py-2 pr-2 whitespace-nowrap">{dateLabel(t.date)}</td>
      <td className="px-2 py-2">
        <button
          type="button"
          className={`rounded px-1.5 py-0.5 text-[11px] font-medium transition-colors ${
            t.type === 'income'
              ? 'bg-blue-100 text-blue-700 hover:bg-blue-200'
              : 'bg-slate-200 text-slate-600 hover:bg-slate-300'
          }`}
          title="クリックで収入/支出を切り替え(勘定科目はリセットされます)"
          onClick={() => {
            const to = t.type === 'income' ? '支出' : '収入';
            if (confirm(`この取引を「${to}」に変更しますか?\n勘定科目は未仕訳に戻ります。`)) {
              store.updateTransaction(t.id, {
                type: t.type === 'income' ? 'expense' : 'income',
                account: null,
                approved: false,
              });
            }
          }}
        >
          {t.type === 'income' ? '収入' : '支出'}
        </button>
      </td>
      <td className="max-w-[260px] truncate px-2 py-2" title={t.description}>
        {t.description}
      </td>
      <td className="tabular px-2 py-2 text-right whitespace-nowrap">{yen(t.amount)}</td>
      <td className="px-2 py-2">
        <FundSelect t={t} />
      </td>
      <td className="px-2 py-2">
        <AccountSelect
          type={t.type}
          value={t.account}
          aria-label={`${t.description} の勘定科目`}
          onChange={(v) => store.updateTransaction(t.id, { account: v, approved: false })}
        />
        <DepreciationHint account={t.account} amount={t.amount} type={t.type} />
        <CounterFundControl t={t} />
        <TaxControls t={t} />
      </td>
      <td className="tabular px-2 py-2 text-right whitespace-nowrap">
        {t.type === 'expense' && !isExcluded(t.account) && !isSettlement(t.account) ? (
          <>
            {yen(t.businessAmount)}
            {anbunNote && (
              <span className="ml-1 rounded bg-amber-100 px-1 py-0.5 text-[10px] font-medium text-amber-800">
                按分
              </span>
            )}
          </>
        ) : (
          <span className="text-slate-300">—</span>
        )}
      </td>
      <td className="px-2 py-2 whitespace-nowrap">
        {t.account === null ? (
          <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-800">
            未仕訳
          </span>
        ) : isExcluded(t.account) ? (
          <span
            className="rounded bg-slate-200 px-1.5 py-0.5 text-[11px] font-medium text-slate-600"
            title="事業対象外として集計・アラートから除外されています"
          >
            対象外
          </span>
        ) : t.approved ? (
          <button
            type="button"
            className="rounded bg-emerald-100 px-1.5 py-0.5 text-[11px] font-medium text-emerald-700 hover:bg-emerald-200"
            title="クリックで承認を取り消す"
            onClick={() => store.approveTransactions([t.id], false)}
          >
            ✓ 承認済
          </button>
        ) : (
          <button
            type="button"
            className={btn.small}
            onClick={() => store.approveTransactions([t.id], true)}
          >
            承認する
          </button>
        )}
      </td>
      <td className="px-2 py-2 text-right whitespace-nowrap">
        <div className="flex justify-end gap-1">
          <button
            type="button"
            className={`${btn.small} ${fileCount > 0 ? 'border-blue-300 text-blue-700' : ''}`}
            title="証憑(領収書・請求書PDF)を添付・表示"
            onClick={() => onAttach(t)}
          >
            📎{fileCount > 0 ? fileCount : ''}
          </button>
          <button
            type="button"
            className={btn.danger}
            onClick={() => {
              if (confirm(`「${t.description}」(${yen(t.amount)})を削除しますか?`)) {
                store.deleteTransaction(t.id);
                // 削除直後に「元に戻す」を出す(誤削除からの復旧用)
                onDeleted(t);
              }
            }}
          >
            削除
          </button>
        </div>
      </td>
    </tr>
  );
}

/** 証憑(領収書・請求書PDF)の添付モーダル */
function AttachmentsModal({ t, onClose }: { t: Transaction; onClose: () => void }) {
  const [files, setFiles] = useState<StoredFile[] | null>(null);
  const [busy, setBusy] = useState(false);
  // 保存の失敗・スキップは必ず表示する(「添付したつもりが保存されていない」を防ぐ)
  const [notice, setNotice] = useState<{ tone: 'error' | 'warning'; text: string } | null>(null);

  useEffect(() => {
    void listFiles(t.id)
      .then(setFiles)
      .catch(() => {
        setFiles([]);
        setNotice({
          tone: 'error',
          text: '証憑を読み込めませんでした(プライベートブラウズ等ではファイル保存を利用できない場合があります)。',
        });
      });
  }, [t.id]);

  const reload = () => void listFiles(t.id).then(setFiles).catch(() => setFiles([]));

  const openFile = (f: StoredFile) => {
    const url = URL.createObjectURL(f.blob);
    // SVG等はアプリと同一オリジンでスクリプトが実行され得るため、
    // ブラウザで安全に表示できる形式だけ新規タブで開き、それ以外はダウンロードにする
    const safeToPreview = /^(image\/(png|jpe?g|gif|webp|avif|bmp)|application\/pdf)$/.test(f.type);
    if (safeToPreview) {
      window.open(url, '_blank');
    } else {
      const a = document.createElement('a');
      a.href = url;
      a.download = f.name;
      a.click();
    }
    // 使い終わったObjectURLは解放する
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };

  return (
    <ModalShell
      label="証憑の添付"
      onClose={onClose}
      overlayClassName="p-4 md:p-10"
      className="mx-auto max-w-xl rounded-xl bg-white p-6 shadow-xl"
    >
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-800">証憑の添付</h2>
            <p className="mt-0.5 max-w-sm truncate text-xs text-slate-500" title={t.description}>
              {dateLabel(t.date)}・{yen(t.amount)}・{t.description}
            </p>
          </div>
          <button type="button" className={btn.secondary} onClick={onClose}>
            閉じる
          </button>
        </div>

        {files === null ? (
          <p className="py-6 text-center text-sm text-slate-500">読み込み中…</p>
        ) : files.length === 0 ? (
          <p className="py-6 text-center text-sm text-slate-500">
            まだ証憑がありません。領収書の写真や請求書PDFを追加してください。
          </p>
        ) : (
          <table className="w-full text-sm">
            <tbody>
              {files.map((f) => (
                <tr key={f.id} className="border-b border-slate-100">
                  <td className="max-w-[260px] truncate py-1.5 pr-2">
                    <button
                      type="button"
                      className="text-blue-700 underline hover:text-blue-800"
                      title="別タブで表示"
                      onClick={() => openFile(f)}
                    >
                      {f.name}
                    </button>
                  </td>
                  <td className="tabular px-2 py-1.5 text-right text-xs text-slate-500 whitespace-nowrap">
                    {formatBytes(f.size)}
                  </td>
                  <td className="py-1.5 pl-2 text-right">
                    <button
                      type="button"
                      className={btn.danger}
                      onClick={() => {
                        if (confirm(`「${f.name}」を削除しますか?`)) {
                          void deleteFile(f.id).then(reload);
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
        )}

        <div className="mt-4">
          <label htmlFor="tx-attach-file" className="mb-1 block text-xs font-medium text-slate-500">
            ファイルを追加(画像・PDF、1ファイル10MBまで)
          </label>
          <input
            id="tx-attach-file"
            type="file"
            multiple
            accept="image/*,.pdf"
            disabled={busy}
            className="block text-sm text-slate-600 file:mr-3 file:rounded-lg file:border-0 file:bg-blue-50 file:px-4 file:py-2 file:text-sm file:font-medium file:text-blue-700 hover:file:bg-blue-100"
            onChange={async (e) => {
              const list = Array.from(e.target.files ?? []);
              if (list.length === 0) return;
              setBusy(true);
              setNotice(null);
              try {
                const result = await addFiles(t.id, list);
                if (result.skipped.length > 0) {
                  setNotice({
                    tone: 'warning',
                    text: `10MBを超えるため保存しませんでした: ${result.skipped.join('、')}(縮小・分割してから追加してください)`,
                  });
                }
                reload();
              } catch {
                setNotice({
                  tone: 'error',
                  text: '証憑を保存できませんでした(ブラウザの保存容量不足やプライベートブラウズの可能性があります)。元ファイルを別途保管してください。',
                });
              } finally {
                setBusy(false);
                e.target.value = '';
              }
            }}
          />
          {notice && (
            <p
              role="alert"
              className={`mt-2 rounded-lg border px-3 py-2 text-xs leading-relaxed ${
                notice.tone === 'error'
                  ? 'border-rose-200 bg-rose-50 text-rose-800'
                  : 'border-amber-200 bg-amber-50 text-amber-900'
              }`}
            >
              ⚠ {notice.text}
            </p>
          )}
        </div>

        <p className="mt-4 text-[11px] leading-relaxed text-slate-500">
          証憑はこの端末のブラウザ(IndexedDB)に保存され、<strong>バックアップJSONにも同梱されます</strong>。
          電子帳簿保存法の検索(日付・金額・取引先)は取引一覧の検索・絞り込みで行えます。
          電子取引の原本データは、訂正削除防止の事務処理規程を整えた上で元ファイルも別途保管しておくと安全です。
        </p>
    </ModalShell>
  );
}

/** 手入力フォーム */
function ManualForm({ onDone }: { onDone: (msg: string) => void }) {
  const store = useStore();
  const [date, setDate] = useState(today());
  const [type, setType] = useState<TxType>('expense');
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [account, setAccount] = useState<string | null>(null);
  const [fund, setFund] = useState<FundId>('bank');

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const n = Number(amount);
    if (!date || !Number.isFinite(n) || n <= 0) return;
    // 科目未選択ならルールで自動仕訳を試みる
    const finalAccount = account ?? suggestAccount(description, type, store.rules);
    store.addTransactions([
      {
        date,
        amount: Math.round(n),
        description: description.trim() || '手入力取引',
        type,
        account: finalAccount,
        approved: false,
        source: 'manual',
        fund,
      },
    ]);
    onDone(
      `取引を追加しました(勘定科目: ${accountLabel(finalAccount)})。一覧で確認して承認してください。`,
    );
  };

  return (
    <form
      onSubmit={submit}
      className="mb-5 flex flex-wrap items-end gap-3 rounded-lg border border-slate-200 bg-slate-50 p-4"
    >
      <div>
        <label htmlFor="tx-manual-date" className="mb-1 block text-xs font-medium text-slate-500">日付</label>
        <input
          id="tx-manual-date"
          type="date"
          className={input}
          value={date}
          onChange={(e) => setDate(e.target.value)}
          required
        />
      </div>
      <div>
        <label htmlFor="tx-manual-type" className="mb-1 block text-xs font-medium text-slate-500">種別</label>
        <select
          id="tx-manual-type"
          className={selectCls}
          value={type}
          onChange={(e) => {
            setType(e.target.value as TxType);
            setAccount(null);
            setFund('bank');
          }}
        >
          <option value="expense">支出</option>
          <option value="income">収入</option>
        </select>
      </div>
      <div>
        <label htmlFor="tx-manual-fund" className="mb-1 block text-xs font-medium text-slate-500">決済手段</label>
        <select
          id="tx-manual-fund"
          className={selectCls}
          value={fund}
          onChange={(e) => setFund(e.target.value as FundId)}
        >
          {fundsOf(type).map((f) => (
            <option key={f.id} value={f.id}>
              {f.label}
            </option>
          ))}
        </select>
        {fund === 'receivable' && (
          <p className="mt-1 max-w-52 text-[11px] leading-relaxed text-slate-500">
            請求時の売上計上(発生主義)。後日の入金行は科目を「売掛金の回収」にしてください。
          </p>
        )}
      </div>
      <div>
        <label htmlFor="tx-manual-amount" className="mb-1 block text-xs font-medium text-slate-500">金額(円)</label>
        <input
          id="tx-manual-amount"
          type="number"
          className={`${input} w-32`}
          min={1}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          required
        />
      </div>
      <div className="min-w-52 flex-1">
        <label htmlFor="tx-manual-description" className="mb-1 block text-xs font-medium text-slate-500">摘要</label>
        <input
          id="tx-manual-description"
          type="text"
          className={`${input} w-full`}
          placeholder="例: ○○文具店 コピー用紙"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
      <div>
        <label htmlFor="tx-manual-account" className="mb-1 block text-xs font-medium text-slate-500">
          勘定科目(未選択なら自動仕訳)
        </label>
        <AccountSelect id="tx-manual-account" type={type} value={account} onChange={setAccount} />
      </div>
      <button type="submit" className={btn.primary}>
        追加
      </button>
    </form>
  );
}
