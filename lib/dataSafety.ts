/**
 * 端末内だけに保存する帳簿を失わないための補助。
 * - バックアップの催促: 最後のバックアップから一定日数が経つとお知らせを出す
 * - 永続ストレージの要求: ブラウザが容量不足時や一定期間未使用で自動削除しないよう頼む
 *   (Safari はホーム画面に追加していないサイトのデータを7日間の未使用で消すことがある)
 * 記録はこの端末の localStorage に置く(帳簿データとは別。端末ごとに意味がある値のため)。
 */

export const LAST_BACKUP_KEY = 'shinkoku-snap:lastBackupAt';
export const REMINDER_SNOOZE_KEY = 'shinkoku-snap:backupReminderSnoozeUntil';
export const PERSIST_ASKED_KEY = 'shinkoku-snap:persistAsked';

/** 最後のバックアップからこの日数を過ぎたら催促する */
export const BACKUP_REMIND_DAYS = 30;
/** 「あとで」を押したら催促を止める日数 */
export const BACKUP_SNOOZE_DAYS = 7;

const DAY = 24 * 60 * 60 * 1000;

/**
 * バックアップを催促するか。帳簿に取引がなければ催促しない。
 * 一度もバックアップしていなければ、データがある限り催促する(スヌーズ中を除く)
 */
export function shouldRemindBackup(opts: {
  now: number;
  hasData: boolean;
  lastBackupAt: number | null;
  snoozeUntil: number | null;
}): boolean {
  if (!opts.hasData) return false;
  if (opts.snoozeUntil !== null && opts.now < opts.snoozeUntil) return false;
  if (opts.lastBackupAt === null) return true;
  return opts.now - opts.lastBackupAt >= BACKUP_REMIND_DAYS * DAY;
}

/** 最後のバックアップからの経過日数(未実施は null) */
export function daysSince(now: number, at: number | null): number | null {
  return at === null ? null : Math.floor((now - at) / DAY);
}

/** localStorage の数値(読めない環境・壊れた値は null) */
export function readNumber(key: string): number | null {
  try {
    const v = localStorage.getItem(key);
    const n = v === null ? NaN : Number(v);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export function writeNumber(key: string, value: number): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // 保存できない環境では催促が出続けるだけで、帳簿には影響しない
  }
}

export function snoozeBackupReminder(now: number): void {
  writeNumber(REMINDER_SNOOZE_KEY, now + BACKUP_SNOOZE_DAYS * DAY);
}

/** ブラウザの保存領域が永続化されているか(API がない環境は null) */
export async function storagePersisted(): Promise<boolean | null> {
  try {
    if (typeof navigator === 'undefined' || !navigator.storage?.persisted) return null;
    return await navigator.storage.persisted();
  } catch {
    return null;
  }
}

/**
 * 永続ストレージを頼む(帳簿にデータが入ってから1回だけ)。
 * Chrome・Edge・Safari は条件を満たせば黙って許可し、Firefox は許可の確認を出す
 */
export async function requestPersistentStorage(): Promise<boolean | null> {
  try {
    if (typeof navigator === 'undefined' || !navigator.storage?.persist) return null;
    if (await navigator.storage.persisted()) return true;
    if (readNumber(PERSIST_ASKED_KEY) !== null) return false;
    writeNumber(PERSIST_ASKED_KEY, Date.now());
    return await navigator.storage.persist();
  } catch {
    return null;
  }
}
