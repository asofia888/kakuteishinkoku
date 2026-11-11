import { buildBackupFile } from './backupFile';
import { downloadBlob } from './csv';
import { LAST_BACKUP_KEY, writeNumber } from './dataSafety';
import { listAllFiles, StoredFile } from './files';
import { today } from './format';
import { AppData } from './types';

/** バックアップが済んだことを画面(催促バナー・データ管理)に知らせるイベント */
export const BACKUP_DONE_EVENT = 'shinkoku-snap:backup-done';

/**
 * バックアップ(証憑があれば ZIP、なければ JSON)をダウンロードし、実施日時を記録する。
 * 証憑(IndexedDB)が読み出せない環境でも帳簿だけはバックアップする。
 * 作成に失敗したときは利用者に知らせ、実施日時は記録しない(戻り値 false)
 */
export async function downloadBackupFile(data: AppData): Promise<boolean> {
  try {
    let files: StoredFile[] | null = null;
    try {
      files = await listAllFiles();
    } catch {
      alert('証憑の読み出しに失敗したため、帳簿データのみのバックアップを作成します。');
    }
    const { blob, extension, skipped } = await buildBackupFile(data, files);
    downloadBlob(`申告スナップ_バックアップ_${today()}.${extension}`, blob);
    if (skipped.length > 0) {
      alert(
        `次の証憑${skipped.length}件は読み出せなかったため、バックアップに含まれていません。\n${skipped.slice(0, 10).join('\n')}${skipped.length > 10 ? '\nほか' : ''}`,
      );
    }
  } catch {
    alert('バックアップの作成に失敗しました。ブラウザを再読み込みしてから、もう一度お試しください。');
    return false;
  }
  writeNumber(LAST_BACKUP_KEY, Date.now());
  window.dispatchEvent(new Event(BACKUP_DONE_EVENT));
  return true;
}
