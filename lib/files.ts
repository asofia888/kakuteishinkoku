import { uid } from './types';

/**
 * 証憑ファイル(領収書・請求書PDF等)の保存。
 * 画像・PDFは localStorage(約5MB)に入らないため IndexedDB に保存する。
 * 取引ID(txId)に紐づけ、電子帳簿保存法の検索要件(日付・金額・取引先)は
 * 取引一覧の検索・フィルタで満たす。
 * バックアップには ZIP の中の別ファイルとして同梱・復元できる(v8〜。lib/backupFile.ts)。
 * v7 のバックアップ(JSON に base64 で埋め込む形式)も復元だけはできる。
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

/** 書き込みトランザクションの完了を待つ(中断もエラーとして扱う) */
function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('保存が中断されました'));
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
  await transactionDone(tx);
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
  await transactionDone(tx);
  db.close();
}

/**
 * 取引IDごとの添付件数(一覧のバッジ表示用)。
 * 取引ID の索引のキーだけを走査し、ファイル本体のレコードは読み出さない
 */
export async function countsByTx(): Promise<Map<string, number>> {
  const db = await openDb();
  const index = db.transaction(STORE, 'readonly').objectStore(STORE).index('txId');
  const counts = new Map<string, number>();
  await new Promise<void>((resolve, reject) => {
    const req = index.openKeyCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return resolve();
      const txId = String(cursor.key);
      counts.set(txId, (counts.get(txId) ?? 0) + 1);
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
  db.close();
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

// ── バックアップへの同梱・復元 ──

/** 全証憑(バックアップ用)。Blob は中身への参照で、読むまでメモリには載らない */
export async function listAllFiles(): Promise<StoredFile[]> {
  const db = await openDb();
  const store = db.transaction(STORE, 'readonly').objectStore(STORE);
  const rows = (await requestToPromise(store.getAll())) as StoredFile[];
  db.close();
  return rows.sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * 証憑を渡されたもので全置き換えする(既存の証憑は削除)。
 * 帳簿(AppData)を丸ごと置き換える復元とセットで使う前提。
 * 削除と保存は1つのトランザクションなので、失敗したときは元の証憑が残る
 */
export async function replaceAllFiles(files: StoredFile[]): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  store.clear();
  for (const f of files) store.put(f);
  await transactionDone(tx);
  db.close();
}

/** 証憑をすべて削除する(「全データを削除」用) */
export async function clearAllFiles(): Promise<void> {
  await replaceAllFiles([]);
}

/** v7 のバックアップJSONに埋め込まれていた形の証憑1件(Blob を base64 文字列にしたもの) */
export interface PortableFile {
  id: string;
  txId: string;
  name: string;
  type: string;
  size: number;
  createdAt: number;
  /** ファイル内容(base64) */
  data: string;
}

/** base64 の証憑(v7 のバックアップ)を保存用の形に戻す。base64 が壊れていれば null */
export function portableToStored(f: PortableFile): StoredFile | null {
  try {
    const bin = atob(f.data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const blob = new Blob([bytes], { type: f.type });
    return { id: f.id, txId: f.txId, name: f.name, type: f.type, size: blob.size, createdAt: f.createdAt, blob };
  } catch {
    return null;
  }
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
  await transactionDone(tx);
  db.close();
  return removed;
}

/** バイト数の表示用フォーマット */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
