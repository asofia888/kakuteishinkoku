import { IDBFactory } from 'fake-indexeddb';
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  addFiles,
  clearAllFiles,
  countsByTx,
  deleteOrphans,
  listAllFiles,
  listFiles,
  MAX_FILE_SIZE,
  portableToStored,
  replaceAllFiles,
  StoredFile,
  totalUsage,
} from './files';

const file = (name: string, content: string, type = 'application/pdf') => new File([content], name, { type });

beforeEach(() => {
  // テストごとに空の IndexedDB から始める
  globalThis.indexedDB = new IDBFactory();
});

describe('証憑の保存と件数', () => {
  it('取引ごとの件数と合計容量を返す(上限を超えるファイルは保存しない)', async () => {
    expect(await countsByTx()).toEqual(new Map());
    await addFiles('tx-1', [file('a.pdf', 'aaa'), file('b.pdf', 'bb')]);
    await addFiles('tx-2', [file('c.jpg', 'c', 'image/jpeg')]);
    const result = await addFiles('tx-3', [new File([new Uint8Array(MAX_FILE_SIZE + 1)], '大きすぎ.pdf')]);
    expect(result).toEqual({ added: 0, skipped: ['大きすぎ.pdf'] });

    expect(await countsByTx()).toEqual(
      new Map([
        ['tx-1', 2],
        ['tx-2', 1],
      ]),
    );
    expect(await totalUsage()).toEqual({ count: 3, size: 6 });
  });

  it('取引に紐づかなくなった証憑だけを整理できる', async () => {
    await addFiles('tx-1', [file('a.pdf', 'a')]);
    await addFiles('削除した取引', [file('b.pdf', 'b'), file('c.pdf', 'c')]);
    expect(await deleteOrphans(new Set(['tx-1']))).toBe(2);
    expect(await countsByTx()).toEqual(new Map([['tx-1', 1]]));
  });
});

describe('バックアップ・復元・全削除', () => {
  const restored = (id: string, txId: string, content: string): StoredFile => {
    const blob = new Blob([content], { type: 'application/pdf' });
    return { id, txId, name: `${id}.pdf`, type: 'application/pdf', size: blob.size, createdAt: 1, blob };
  };

  it('listAllFiles は全取引の証憑を、中身を読める形で返す', async () => {
    await addFiles('tx-1', [file('a.pdf', 'あいう')]);
    await addFiles('tx-2', [file('b.pdf', 'えお')]);
    const all = await listAllFiles();
    expect(all.map((f) => [f.txId, f.name])).toEqual([
      ['tx-1', 'a.pdf'],
      ['tx-2', 'b.pdf'],
    ]);
    expect(await all[0].blob.text()).toBe('あいう');
  });

  it('replaceAllFiles は端末の証憑を渡したものだけにする(ID・紐づけ・中身を保つ)', async () => {
    await addFiles('古い取引', [file('old.pdf', 'old')]);
    await replaceAllFiles([restored('f-1', 'tx-1', 'one'), restored('f-2', 'tx-1', 'two')]);

    expect(await listFiles('古い取引')).toEqual([]);
    const files = await listFiles('tx-1');
    expect(files.map((f) => f.id).sort()).toEqual(['f-1', 'f-2']);
    expect(await files.find((f) => f.id === 'f-2')!.blob.text()).toBe('two');
    expect(await totalUsage()).toEqual({ count: 2, size: 6 });
  });

  it('clearAllFiles は証憑をすべて消す(「全データを削除」で端末に残さない)', async () => {
    await addFiles('tx-1', [file('a.pdf', 'a'), file('b.pdf', 'b')]);
    await clearAllFiles();
    expect(await totalUsage()).toEqual({ count: 0, size: 0 });
    expect(await countsByTx()).toEqual(new Map());
  });
});

describe('portableToStored: v7 のバックアップに埋め込まれた証憑', () => {
  const portable = { id: 'f-1', txId: 'tx-1', name: '領収書.pdf', type: 'application/pdf', size: 999, createdAt: 5 };

  it('base64 を元のファイルに戻す(サイズは実際の中身から取り直す)', async () => {
    const f = portableToStored({ ...portable, data: 'aGVsbG8=' })!;
    expect(f).toMatchObject({ id: 'f-1', txId: 'tx-1', name: '領収書.pdf', type: 'application/pdf', size: 5 });
    expect(await f.blob.text()).toBe('hello');
    expect(f.blob.type).toBe('application/pdf');
  });

  it('復号できない base64 は null', () => {
    expect(portableToStored({ ...portable, data: 'aGVsb' })).toBeNull();
  });
});
