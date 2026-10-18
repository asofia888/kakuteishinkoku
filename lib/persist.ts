/**
 * 帳簿データ(AppData)の保存先。
 * 本体は IndexedDB に保存する。localStorage は1サイトあたり約5MBが上限で、
 * 年3,000件の取引を7年分(帳簿の保存期間)ためると上限に達してしまうため
 * (IndexedDB の上限は端末の空き容量に応じて数百MB〜)。
 * - v3.10.0 以前が localStorage に保存したデータは、起動時に IndexedDB へ移して localStorage から消す
 * - IndexedDB を開けない環境では、従来どおり localStorage に保存する
 * - 他のタブへの変更の通知は BroadcastChannel で行う(localStorage の storage イベントの代わり)
 */

/** v3.10.0 以前の保存先(localStorage のキー)。IndexedDB を使えない環境では今も使う */
export const LEGACY_STORAGE_KEY = 'shinkoku-snap:v2';
/**
 * 起動時に読み取れなかった保存データの退避先(localStorage)。
 * 空の状態で起動した直後に操作すると保存が原本を上書きするため、その前に生データを写しておく
 */
export const BROKEN_STORAGE_KEY = `${LEGACY_STORAGE_KEY}:broken`;

const DB_NAME = 'shinkoku-snap-data';
const DB_VERSION = 1;
const STORE = 'kv';
/** 帳簿データ本体 */
const DATA_KEY = 'appdata';
/** 読み取れなかったデータの退避(localStorage に入らない大きさのとき) */
const BROKEN_KEY = 'broken';
/** localStorage の旧データで置き換える前の IndexedDB のデータ(手動復旧用) */
const REPLACED_KEY = 'appdata:replaced';
const CHANNEL_NAME = 'shinkoku-snap:data';

/** 保存済みのデータ。値の検証(sanitize)は呼び出し側で行う */
export interface StoredData {
  /** 保存されている値(IndexedDB はオブジェクト、localStorage は JSON 文字列) */
  value: unknown;
  /** localStorage に残っていた旧形式のデータか(IndexedDB へ移す必要がある) */
  legacy: boolean;
}

export interface Persistence {
  readonly backend: 'indexeddb' | 'localstorage';
  /**
   * 保存済みのデータを読む(なければ null)。
   * localStorage に旧データがあればそれを返す(IndexedDB へ移した後に localStorage へ書けるのは
   * 更新前の版を開いたままのタブだけなので、残っていればそれが最後の変更)
   */
  load(): Promise<StoredData | null>;
  /** 読み込んだ旧データを IndexedDB へ移し、localStorage から消す */
  migrate(data: unknown): Promise<void>;
  /** 保存する。続けて呼ばれたときは最新の値だけを書く。失敗すると reject */
  save(data: unknown): Promise<void>;
  /**
   * 読み取れなかったデータを退避する。fromLegacy(localStorage の旧データ)なら、
   * 退避できた後に旧データを消す(残すと次の起動でまた読み取れずに空で起動するため)
   */
  salvage(raw: unknown, fromLegacy: boolean): Promise<void>;
  /** 他のタブが保存したときに呼ばれる(受け取る値は load と同じ形式)。購読解除の関数を返す */
  subscribe(onChange: (value: unknown) => void): () => void;
  /** 全データ削除のとき、手動復旧用に残した写しも消す */
  discardRecoveryCopies(): Promise<void>;
  /** 使わなくなった接続を閉じる */
  close(): void;
}

function requestToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not available'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    // 別タブが古い版の DB を開いたままでも、待ち続けずに localStorage へ切り替える
    req.onblocked = () => reject(new Error('IndexedDB open is blocked'));
  });
}

function readLocal(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function removeLocal(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // 消せなくても、次回の起動で同じ内容をもう一度移すだけ
  }
}

/** 読み取れなかったデータを localStorage の退避キーへ写す(入らなければ false) */
function salvageToLocal(raw: unknown): boolean {
  try {
    localStorage.setItem(BROKEN_STORAGE_KEY, typeof raw === 'string' ? raw : JSON.stringify(raw));
    return true;
  } catch {
    return false;
  }
}

function createBroadcast(): BroadcastChannel | null {
  try {
    return typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(CHANNEL_NAME);
  } catch {
    return null;
  }
}

/**
 * 続けて呼ばれた保存をまとめる書き込み係。書き込み中に来た値は最新の1つだけを次に書く
 * (変更のたびに全データを書くため、古い値を順に全部書くのは無駄で、順序の入れ替わりも防ぐ)
 */
function coalescingWriter(write: (data: unknown) => Promise<void>): (data: unknown) => Promise<void> {
  let pending: { data: unknown } | null = null;
  let running: Promise<void> | null = null;
  const flush = async () => {
    let error: unknown = null;
    while (pending) {
      const { data } = pending;
      pending = null;
      try {
        await write(data);
        error = null;
      } catch (e) {
        // 後に新しい値があればそれで再試行される。最後の書き込みの結果だけを返す
        error = e;
      }
    }
    if (error) throw error;
  };
  return (data) => {
    pending = { data };
    if (!running) running = flush().finally(() => (running = null));
    return running;
  };
}

function indexedDbPersistence(db: IDBDatabase): Persistence {
  const channel = createBroadcast();
  // 将来の版が DB を更新するとき、開いたままの接続が更新を止めないようにする
  db.onversionchange = () => db.close();
  // localStorage の旧データを読んだが、まだ IndexedDB へ移せていない(移すまでは消さない)
  let legacyPending = false;
  const settleLegacy = () => {
    if (!legacyPending) return;
    removeLocal(LEGACY_STORAGE_KEY);
    legacyPending = false;
  };

  const get = async (key: string): Promise<unknown> =>
    requestToPromise(db.transaction(STORE, 'readonly').objectStore(STORE).get(key));

  /** 複数のキーを1つのトランザクションで書く(完了 = ディスクへの書き込みまで待つ) */
  const putAll = (entries: [string, unknown][], deletes: string[] = []): Promise<void> =>
    new Promise((resolve, reject) => {
      // 帳簿は消えると困るデータのため、OS のバッファではなくディスクへの書き込み完了を待つ
      const tx = db.transaction(STORE, 'readwrite', { durability: 'strict' });
      const store = tx.objectStore(STORE);
      for (const [key, value] of entries) store.put(value, key);
      for (const key of deletes) store.delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    });

  const write = coalescingWriter(async (data) => {
    await putAll([[DATA_KEY, data]]);
    // 起動時に旧データを移せなかった場合も、IndexedDB に書けた時点で旧データは不要になる
    // (残すと次の起動で古い旧データが優先される)
    settleLegacy();
    channel?.postMessage({ type: 'saved' });
  });

  return {
    backend: 'indexeddb',
    async load() {
      const legacy = readLocal(LEGACY_STORAGE_KEY);
      if (legacy !== null) {
        legacyPending = true;
        return { value: legacy, legacy: true };
      }
      const value = await get(DATA_KEY);
      return value === undefined ? null : { value, legacy: false };
    },
    async migrate(data) {
      const current = await get(DATA_KEY);
      // IndexedDB 側にもデータがあれば(更新前の版のタブで書かれた旧データで置き換える場合)、写しを残す
      await putAll(current === undefined ? [[DATA_KEY, data]] : [[DATA_KEY, data], [REPLACED_KEY, current]]);
      settleLegacy();
      channel?.postMessage({ type: 'saved' });
    },
    save: write,
    async salvage(raw, fromLegacy) {
      if (!salvageToLocal(raw)) {
        await putAll([[BROKEN_KEY, typeof raw === 'string' ? raw : JSON.stringify(raw)]]);
      }
      if (fromLegacy) settleLegacy();
    },
    subscribe(onChange) {
      if (!channel) return () => {};
      const onMessage = () => {
        void get(DATA_KEY).then(
          (value) => {
            if (value !== undefined) onChange(value);
          },
          () => {
            // 読めなければ自タブのデータを守る(次の通知で取り込む)
          },
        );
      };
      channel.addEventListener('message', onMessage);
      return () => channel.removeEventListener('message', onMessage);
    },
    async discardRecoveryCopies() {
      await putAll([], [REPLACED_KEY, BROKEN_KEY]);
      removeLocal(BROKEN_STORAGE_KEY);
    },
    close() {
      channel?.close();
      db.close();
    },
  };
}

/** IndexedDB を使えない環境(一部のプライベートブラウズ等)向け。v3.10.0 以前と同じ保存方法 */
function localStoragePersistence(): Persistence {
  return {
    backend: 'localstorage',
    async load() {
      const raw = readLocal(LEGACY_STORAGE_KEY);
      return raw === null ? null : { value: raw, legacy: false };
    },
    async migrate() {
      // 保存先が同じなので移すものはない
    },
    async save(data) {
      localStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify(data));
    },
    async salvage(raw) {
      salvageToLocal(raw);
    },
    subscribe(onChange) {
      // storage イベントは変更を行った本人のタブでは発火しない
      const onStorage = (e: StorageEvent) => {
        if (e.key === LEGACY_STORAGE_KEY && e.newValue !== null) onChange(e.newValue);
      };
      window.addEventListener('storage', onStorage);
      return () => window.removeEventListener('storage', onStorage);
    },
    async discardRecoveryCopies() {
      removeLocal(BROKEN_STORAGE_KEY);
    },
    close() {
      // 閉じる接続はない
    },
  };
}

/** 保存先を開く。IndexedDB を開けなければ localStorage を使う */
export async function openPersistence(): Promise<Persistence> {
  try {
    return indexedDbPersistence(await openDb());
  } catch {
    return localStoragePersistence();
  }
}

/** 退避したデータ(読み取れなかった保存データ)を読む。なければ null */
export async function readSalvaged(): Promise<string | null> {
  const local = readLocal(BROKEN_STORAGE_KEY);
  if (local !== null) return local;
  try {
    const db = await openDb();
    const value = await requestToPromise(db.transaction(STORE, 'readonly').objectStore(STORE).get(BROKEN_KEY));
    db.close();
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}
