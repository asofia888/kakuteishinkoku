import { IDBFactory } from 'fake-indexeddb';
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BROKEN_STORAGE_KEY,
  LEGACY_STORAGE_KEY,
  openPersistence,
  Persistence,
  readSalvaged,
} from './persist';

/** テスト用の localStorage(容量超過を再現できるよう、書けないキーを指定できる) */
class MemoryStorage {
  private map = new Map<string, string>();
  failKeys = new Set<string>();
  getItem(key: string) {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string) {
    if (this.failKeys.has(key)) throw new DOMException('quota', 'QuotaExceededError');
    this.map.set(key, String(value));
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
}

let storage: MemoryStorage;
const opened: Persistence[] = [];

async function open(): Promise<Persistence> {
  const p = await openPersistence();
  opened.push(p);
  return p;
}

/** IndexedDB の生の値を読む(写し・退避の確認用) */
function rawGet(key: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('shinkoku-snap-data', 1);
    req.onsuccess = () => {
      const db = req.result;
      const get = db.transaction('kv', 'readonly').objectStore('kv').get(key);
      get.onsuccess = () => {
        db.close();
        resolve(get.result);
      };
      get.onerror = () => reject(get.error);
    };
    req.onerror = () => reject(req.error);
  });
}

beforeEach(() => {
  // テストごとに空の IndexedDB と localStorage にする
  globalThis.indexedDB = new IDBFactory();
  storage = new MemoryStorage();
  (globalThis as { localStorage?: unknown }).localStorage = storage;
});

afterEach(() => {
  for (const p of opened.splice(0)) p.close();
});

const sample = { transactions: [{ id: 'tx-1', amount: 1000 }], rules: [] };

describe('openPersistence: IndexedDB への保存と読込', () => {
  it('保存したデータをそのまま読める(旧データ扱いにならない)', async () => {
    const p = await open();
    expect(p.backend).toBe('indexeddb');
    expect(await p.load()).toBeNull();
    await p.save(sample);
    expect(await p.load()).toEqual({ value: sample, legacy: false });
  });

  it('続けて保存すると最新の値だけが残る', async () => {
    const p = await open();
    const saves = [1, 2, 3, 4].map((n) => p.save({ ...sample, n }));
    await Promise.all(saves);
    expect((await p.load())?.value).toEqual({ ...sample, n: 4 });
  });

  it('IndexedDB がない環境では localStorage に保存する', async () => {
    const idb = globalThis.indexedDB;
    // @ts-expect-error IndexedDB のない環境を再現する
    delete globalThis.indexedDB;
    try {
      const p = await open();
      expect(p.backend).toBe('localstorage');
      await p.save(sample);
      expect(JSON.parse(storage.getItem(LEGACY_STORAGE_KEY)!)).toEqual(sample);
      expect(await p.load()).toEqual({ value: JSON.stringify(sample), legacy: false });
    } finally {
      globalThis.indexedDB = idb;
    }
  });
});

describe('localStorage の旧データ(v3.10.0 以前)の移行', () => {
  it('旧データを読んで IndexedDB へ移すと、localStorage から消える', async () => {
    storage.setItem(LEGACY_STORAGE_KEY, JSON.stringify(sample));
    const p = await open();
    const loaded = await p.load();
    expect(loaded).toEqual({ value: JSON.stringify(sample), legacy: true });
    await p.migrate(sample);
    expect(storage.getItem(LEGACY_STORAGE_KEY)).toBeNull();
    expect(await rawGet('appdata')).toEqual(sample);
    // 次の起動では IndexedDB から読む
    expect(await (await open()).load()).toEqual({ value: sample, legacy: false });
  });

  it('IndexedDB にもデータがあれば旧データを優先し、置き換えた側の写しを残す(全削除で消える)', async () => {
    const p = await open();
    await p.save({ ...sample, from: 'indexeddb' });
    // 更新前の版を開いたままのタブが、移行後に localStorage へ書いた
    storage.setItem(LEGACY_STORAGE_KEY, JSON.stringify({ ...sample, from: 'old-tab' }));
    const p2 = await open();
    const loaded = await p2.load();
    expect(loaded?.legacy).toBe(true);
    await p2.migrate({ ...sample, from: 'old-tab' });
    expect(await rawGet('appdata')).toEqual({ ...sample, from: 'old-tab' });
    expect(await rawGet('appdata:replaced')).toEqual({ ...sample, from: 'indexeddb' });
    await p2.discardRecoveryCopies();
    expect(await rawGet('appdata:replaced')).toBeUndefined();
  });

  it('移行に失敗していても、次に保存できた時点で旧データを消す(古い旧データが優先され続けない)', async () => {
    storage.setItem(LEGACY_STORAGE_KEY, JSON.stringify(sample));
    const p = await open();
    await p.load(); // migrate を呼ばない = 移行に失敗した状態
    expect(storage.getItem(LEGACY_STORAGE_KEY)).not.toBeNull();
    await p.save({ ...sample, edited: true });
    expect(storage.getItem(LEGACY_STORAGE_KEY)).toBeNull();
    expect(await (await open()).load()).toEqual({ value: { ...sample, edited: true }, legacy: false });
  });
});

describe('読み取れなかったデータの退避', () => {
  it('localStorage の退避キーへ写し、旧データなら元のキーを消す', async () => {
    storage.setItem(LEGACY_STORAGE_KEY, '{壊れたJSON');
    const p = await open();
    await p.load();
    await p.salvage('{壊れたJSON', true);
    expect(storage.getItem(BROKEN_STORAGE_KEY)).toBe('{壊れたJSON');
    expect(storage.getItem(LEGACY_STORAGE_KEY)).toBeNull();
    expect(await readSalvaged()).toBe('{壊れたJSON');
  });

  it('localStorage に入らなければ IndexedDB へ退避し、ダウンロード用に読める', async () => {
    storage.failKeys.add(BROKEN_STORAGE_KEY);
    const p = await open();
    await p.salvage({ transactions: 'not-array' }, false);
    expect(storage.getItem(BROKEN_STORAGE_KEY)).toBeNull();
    expect(await readSalvaged()).toBe('{"transactions":"not-array"}');
    await p.discardRecoveryCopies();
    expect(await readSalvaged()).toBeNull();
  });
});

describe('他のタブへの変更通知', () => {
  it('別のタブ(別の接続)が保存すると、保存された値を受け取る', async () => {
    const tabA = await open();
    const tabB = await open();
    const received = new Promise<unknown>((resolve) => {
      const unsubscribe = tabB.subscribe((value) => {
        unsubscribe();
        resolve(value);
      });
    });
    await tabA.save({ ...sample, by: 'tabA' });
    expect(await received).toEqual({ ...sample, by: 'tabA' });
  });
});
