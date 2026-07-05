import { uid } from './types';

/**
 * 証憑ファイル(領収書・請求書PDF等)の保存。
 * 画像・PDFは localStorage(約5MB)に入らないため IndexedDB に保存する。
 * 取引ID(txId)に紐づけ、電子帳簿保存法の検索要件(日付・金額・取引先)は
 * 取引一覧の検索・フィルタで満たす。
 * 注意: バックアップJSONには含まれない(元ファイルの別途保管を推奨)。
 */

const DB_NAME = 'shinkoku-snap-files';
const DB_VERSION = 1;
const STORE = 'files';

export interface StoredFile {
  id: string;
  /** 紐づく取引ID */
  txId: string;
  name: string;
  type: string;
  size: number;
  createdAt: number;
  blob: Blob;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('txId', 'txId', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function requestToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** 1ファイルあたりの保存上限(これ以上は保存せず、呼び出し側でユーザーに知らせる) */
export const MAX_FILE_SIZE = 10 * 1024 * 1024;

export interface AddFilesResult {
  /** 保存した件数 */
  added: number;
  /** サイズ超過で保存しなかったファイル名(呼び出し側で必ずユーザーに表示すること) */
  skipped: string[];
}

/** 取引にファイルを添付する(1ファイル最大10MB。超過分は保存せず skipped で返す) */
export async function addFiles(txId: string, files: File[]): Promise<AddFilesResult> {
  const skipped = files.filter((f) => f.size > MAX_FILE_SIZE).map((f) => f.name);
  const accepted = files.filter((f) => f.size <= MAX_FILE_SIZE);
  if (accepted.length === 0) return { added: 0, skipped };
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  for (const f of accepted) {
    store.put({
      id: uid(),
      txId,
      name: f.name,
      type: f.type,
      size: f.size,
      createdAt: Date.now(),
      blob: f,
    } satisfies StoredFile);
  }
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
  return { added: accepted.length, skipped };
}

/** 取引に紐づく証憑の一覧 */
export async function listFiles(txId: string): Promise<StoredFile[]> {
  const db = await openDb();
  const store = db.transaction(STORE, 'readonly').objectStore(STORE);
  const rows = await requestToPromise(store.index('txId').getAll(txId));
  db.close();
  return (rows as StoredFile[]).sort((a, b) => a.createdAt - b.createdAt);
}

export async function deleteFile(id: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  tx.objectStore(STORE).delete(id);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

/** 取引IDごとの添付件数(一覧のバッジ表示用) */
export async function countsByTx(): Promise<Map<string, number>> {
  const db = await openDb();
  const store = db.transaction(STORE, 'readonly').objectStore(STORE);
  const rows = (await requestToPromise(store.getAll())) as StoredFile[];
  db.close();
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.txId, (counts.get(r.txId) ?? 0) + 1);
  return counts;
}

/** 保存容量の合計 */
export async function totalUsage(): Promise<{ count: number; size: number }> {
  const db = await openDb();
  const store = db.transaction(STORE, 'readonly').objectStore(STORE);
  const rows = (await requestToPromise(store.getAll())) as StoredFile[];
  db.close();
  return { count: rows.length, size: rows.reduce((s, r) => s + r.size, 0) };
}

/** 存在しない取引に紐づく証憑(取引削除後の残骸)を削除し、削除件数を返す */
export async function deleteOrphans(validTxIds: Set<string>): Promise<number> {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  const rows = (await requestToPromise(store.getAll())) as StoredFile[];
  let removed = 0;
  for (const r of rows) {
    if (!validTxIds.has(r.txId)) {
      store.delete(r.id);
      removed++;
    }
  }
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
  return removed;
}

/** バイト数の表示用フォーマット */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
