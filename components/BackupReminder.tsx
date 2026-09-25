'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { BACKUP_DONE_EVENT, downloadBackupFile } from '@/lib/backupDownload';
import {
  daysSince,
  LAST_BACKUP_KEY,
  readNumber,
  REMINDER_SNOOZE_KEY,
  requestPersistentStorage,
  shouldRemindBackup,
  snoozeBackupReminder,
} from '@/lib/dataSafety';
import { useStore } from '@/lib/store';

/**
 * バックアップの催促バナー。帳簿は端末のブラウザ内にしかないため、
 * 最後のバックアップから30日経つ(または一度もない)とお知らせする。
 * 帳簿にデータが入ったら、ブラウザに永続ストレージも1回だけ頼む。
 */
export default function BackupReminder() {
  const store = useStore();
  const hasData = store.transactions.length > 0;
  const [state, setState] = useState<{ remind: boolean; days: number | null }>({
    remind: false,
    days: null,
  });

  useEffect(() => {
    if (!store.ready) return;
    const check = () => {
      const now = Date.now();
      const last = readNumber(LAST_BACKUP_KEY);
      setState({
        days: daysSince(now, last),
        remind: shouldRemindBackup({
          now,
          hasData,
          lastBackupAt: last,
          snoozeUntil: readNumber(REMINDER_SNOOZE_KEY),
        }),
      });
    };
    check();
    if (hasData) void requestPersistentStorage();
    window.addEventListener(BACKUP_DONE_EVENT, check);
    return () => window.removeEventListener(BACKUP_DONE_EVENT, check);
  }, [store.ready, hasData]);

  if (!state.remind) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900">
      <span className="font-medium">
        💾{' '}
        {state.days === null
          ? 'まだ一度もバックアップしていません。'
          : `最後のバックアップから${state.days}日経っています。`}
      </span>
      <span className="text-xs">
        帳簿はこの端末のブラウザ内だけに保存されています(端末の故障・ブラウザのデータ消去で失われます)。
      </span>
      <span className="ml-auto flex gap-2">
        <button
          type="button"
          className="rounded border border-amber-400 bg-white px-2 py-0.5 text-xs font-medium hover:bg-amber-100"
          onClick={() => void downloadBackupFile(store.exportData())}
        >
          今すぐバックアップ
        </button>
        <Link href="/" className="rounded px-2 py-0.5 text-xs text-amber-800 underline">
          データ管理
        </Link>
        <button
          type="button"
          className="rounded px-2 py-0.5 text-xs text-amber-700 hover:bg-amber-100"
          onClick={() => {
            snoozeBackupReminder(Date.now());
            setState((s) => ({ ...s, remind: false }));
          }}
        >
          あとで(7日後)
        </button>
      </span>
    </div>
  );
}
