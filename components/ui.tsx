'use client';

import React from 'react';

export function PageHeader({ title, description }: { title: string; description?: string }) {
  return (
    <header className="mb-6">
      <h1 className="text-2xl font-bold text-slate-900">{title}</h1>
      {description && <p className="mt-1 text-sm text-slate-500">{description}</p>}
    </header>
  );
}

export function Card({
  title,
  action,
  children,
  className = '',
}: {
  title?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-xl border border-slate-200 bg-white shadow-sm ${className}`}>
      {(title || action) && (
        <div className="flex items-center justify-between gap-2 border-b border-slate-100 px-5 py-3">
          {title && <h2 className="text-sm font-semibold text-slate-700">{title}</h2>}
          {action}
        </div>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}

export function StatCard({
  label,
  value,
  sub,
  tone = 'default',
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: 'default' | 'primary' | 'positive' | 'muted';
}) {
  const valueClass = {
    default: 'text-slate-900',
    primary: 'text-blue-700',
    positive: 'text-emerald-700',
    muted: 'text-slate-500',
  }[tone];
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="text-xs font-medium text-slate-500">{label}</div>
      <div className={`tabular mt-1 text-2xl font-bold ${valueClass}`}>{value}</div>
      {sub && <div className="mt-1 text-xs text-slate-500">{sub}</div>}
    </div>
  );
}

export function Alert({
  tone,
  children,
}: {
  tone: 'warning' | 'info' | 'success';
  children: React.ReactNode;
}) {
  const cls = {
    warning: 'border-amber-300 bg-amber-50 text-amber-900',
    info: 'border-blue-300 bg-blue-50 text-blue-900',
    success: 'border-emerald-300 bg-emerald-50 text-emerald-900',
  }[tone];
  return <div className={`rounded-lg border px-4 py-3 text-sm ${cls}`}>{children}</div>;
}

export function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-slate-300 bg-white px-6 py-12 text-center text-sm text-slate-500">
      {children}
    </div>
  );
}

/**
 * モーダルの共通シェル。ダイアログのアクセシビリティ要件をまとめて満たす:
 * - role="dialog" / aria-modal / aria-label
 * - Escape・背景クリックで閉じる
 * - 開いたらダイアログへフォーカスを移し、閉じたら元の要素へ戻す
 * - 表示中は背景のスクロールをロックする
 */
export function ModalShell({
  label,
  onClose,
  overlayClassName = 'p-4 md:p-8',
  className = '',
  children,
}: {
  /** スクリーンリーダー向けのダイアログ名(例: 「証憑の添付」) */
  label: string;
  onClose: () => void;
  /** 余白などオーバーレイ側の追加クラス */
  overlayClassName?: string;
  /** ダイアログ本体のクラス(幅・背景など) */
  className?: string;
  children: React.ReactNode;
}) {
  const dialogRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prevOverflow;
      opener?.focus?.();
    };
  }, []);
  return (
    <div
      className={`fixed inset-0 z-50 overflow-auto bg-slate-900/60 ${overlayClassName}`}
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        className={`focus:outline-none ${className}`}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
        }}
      >
        {children}
      </div>
    </div>
  );
}

/** ボタンの共通クラス */
export const btn = {
  primary:
    'inline-flex items-center gap-1 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors',
  secondary:
    'inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors',
  small:
    'inline-flex items-center rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-30 disabled:cursor-not-allowed transition-colors',
  danger:
    'inline-flex items-center rounded-md px-2 py-1 text-xs font-medium text-rose-600 hover:bg-rose-50 transition-colors',
};

/** 入力欄の共通クラス */
export const input =
  'rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100';

export const selectCls =
  'rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-800 focus:border-blue-500 focus:outline-none';
