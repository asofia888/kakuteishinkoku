'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { Card } from '@/components/ui';
import { BACKUP_DONE_EVENT } from '@/lib/backupDownload';
import { CheckStatus, yearEndChecklist } from '@/lib/checklist';
import { daysSince, LAST_BACKUP_KEY, readNumber } from '@/lib/dataSafety';
import { useStore } from '@/lib/store';

const ICON: Record<CheckStatus, { mark: string; cls: string }> = {
  done: { mark: '✓', cls: 'bg-emerald-100 text-emerald-700' },
  todo: { mark: '○', cls: 'bg-slate-100 text-slate-500' },
  warn: { mark: '!', cls: 'bg-amber-100 text-amber-800' },
  na: { mark: '—', cls: 'bg-slate-50 text-slate-300' },
};

/** 年分の決算・申告チェックリスト(ダッシュボードに表示) */
export function YearChecklist({ year }: { year: number }) {
  const store = useStore();
  const [lastBackupDays, setLastBackupDays] = useState<number | null>(null);
  useEffect(() => {
    const check = () => setLastBackupDays(daysSince(Date.now(), readNumber(LAST_BACKUP_KEY)));
    check();
    window.addEventListener(BACKUP_DONE_EVENT, check);
    return () => window.removeEventListener(BACKUP_DONE_EVENT, check);
  }, []);

  const data = store.exportData();
  const items = useMemo(
    () => yearEndChecklist(data, year, { lastBackupDays }),
    [data, year, lastBackupDays],
  );
  const applicable = items.filter((i) => i.status !== 'na');
  const done = applicable.filter((i) => i.status === 'done').length;

  return (
    <Card
      title={`${year}年分 決算・申告チェックリスト`}
      action={
        <span className="text-xs text-slate-500">
          完了 <strong className="text-slate-700">{done}</strong> / {applicable.length}
        </span>
      }
    >
      <ol className="divide-y divide-slate-100">
        {items.map((item) => (
          <li
            key={item.id}
            className={`flex items-start gap-3 py-2 text-sm ${item.status === 'na' ? 'text-slate-400' : ''}`}
          >
            <span
              className={`mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-bold ${ICON[item.status].cls}`}
              aria-label={{ done: '完了', todo: '未完了', warn: '要確認', na: '対象外' }[item.status]}
            >
              {ICON[item.status].mark}
            </span>
            <div className="min-w-0 flex-1">
              <div className={item.status === 'done' || item.status === 'na' ? '' : 'font-medium'}>{item.label}</div>
              <div className={`text-xs ${item.status === 'warn' ? 'text-amber-800' : 'text-slate-500'}`}>{item.detail}</div>
            </div>
            {item.status !== 'done' && item.status !== 'na' && (
              <Link href={item.href} className="shrink-0 text-xs font-medium text-blue-700 underline">
                開く
              </Link>
            )}
          </li>
        ))}
      </ol>
    </Card>
  );
}
