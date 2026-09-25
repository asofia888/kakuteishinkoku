import { buildBackupJson } from './backup';
import { downloadText } from './csv';
import { LAST_BACKUP_KEY, writeNumber } from './dataSafety';
import { exportAllFiles, PortableFile } from './files';
import { today } from './format';
import { AppData } from './types';

/** バックアップが済んだことを画面(催促バナー・データ管理)に知らせるイベント */
export const BACKUP_DONE_EVENT = 'shinkoku-snap:backup-done';

/**
 * バックアップJSON(証憑を同梱)をダウンロードし、実施日時を記録する。
 * 証憑(IndexedDB)が読み出せない環境でも帳簿だけはバックアップする
 */
export async function downloadBackupFile(data: AppData): Promise<void> {
  let files: PortableFile[] = [];
  try {
    files = await exportAllFiles();
  } catch {
    alert('証憑の読み出しに失敗したため、帳簿データのみのバックアップを作成します。');
  }
  downloadText(
    `申告スナップ_バックアップ_${today()}.json`,
    buildBackupJson(data, files),
    'application/json',
  );
  writeNumber(LAST_BACKUP_KEY, Date.now());
  window.dispatchEvent(new Event(BACKUP_DONE_EVENT));
}
