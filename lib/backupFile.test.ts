import { describe, expect, it } from 'vitest';
import { buildBackupJson } from './backup';
import { buildBackupFile, readBackupFile } from './backupFile';
import { StoredFile } from './files';
import { foreignZip, ForeignZipEntry } from './testing/foreignZip';
import { AppData, Transaction } from './types';
import { buildZip, crc32, openZip } from './zip';

const tx = (id: string, over: Partial<Transaction> = {}): Transaction => ({
  id,
  date: '2026-05-10',
  amount: 3300,
  description: 'AMAZON 購入',
  type: 'expense',
  account: 'supplies',
  approved: true,
  anbunApplied: false,
  businessAmount: 3300,
  source: 'manual',
  createdAt: 1000,
  fund: 'bank',
  ...over,
});

/** 検証を通した形の帳簿データ(読み込み結果と toEqual で比べられるようにする) */
async function bookOf(transactions: Transaction[]): Promise<AppData> {
  const raw = buildBackupJson({ transactions, rules: [], anbunSettings: [] } as unknown as AppData);
  return (await readBackupFile(new Blob([raw])))!.data;
}

const stored = (id: string, txId: string, name: string, content: Uint8Array<ArrayBuffer> | string, type = 'application/pdf'): StoredFile => {
  const blob = new Blob([content], { type });
  return { id, txId, name, type, size: blob.size, createdAt: 1_780_000_000_000, blob };
};

const bytesOf = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer());
/** 中身が同じか(大きなバイト列を toEqual で比べると遅いため) */
const sameBytes = async (blob: Blob, expected: Uint8Array) => Buffer.from(await blob.arrayBuffer()).equals(expected);
const pdfBytes = new Uint8Array(50_000).map((_, i) => (i * 13 + 5) & 0xff);

describe('buildBackupFile → readBackupFile の往復', () => {
  it('証憑があれば ZIP になり、帳簿と証憑(中身・名前・種類・紐づく取引)が元どおり戻る', async () => {
    const data = await bookOf([tx('tx-1'), tx('tx-2', { date: '2026-06-01', description: '家賃', amount: 80000 })]);
    const files = [
      stored('f-1', 'tx-1', '領収書.pdf', pdfBytes),
      stored('f-2', 'tx-2', 'レシート 写真.jpg', new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), 'image/jpeg'),
    ];
    const backup = await buildBackupFile(data, files);
    expect(backup.extension).toBe('zip');
    expect(backup.skipped).toEqual([]);

    const loaded = (await readBackupFile(backup.blob))!;
    expect(loaded.data).toEqual(data);
    expect(loaded).toMatchObject({ newer: false, broken: 0, missing: 0 });
    expect(loaded.files).toHaveLength(2);
    expect(loaded.files!.map(({ blob: _blob, ...meta }) => meta)).toEqual(
      files.map(({ blob: _blob, ...meta }) => meta),
    );
    expect(await sameBytes(loaded.files![0].blob, pdfBytes)).toBe(true);
    expect(loaded.files![0].blob.type).toBe('application/pdf');
    expect(loaded.files![1].blob.type).toBe('image/jpeg');
  });

  it('ZIP の中では、証憑が取引ごとのフォルダ(取引日_摘要_金額)に入る', async () => {
    const data = await bookOf([tx('tx-1'), tx('tx-2', { description: 'A/B:C*D?"E"<F>|G.', amount: 500 })]);
    const backup = await buildBackupFile(data, [
      stored('f-1', 'tx-1', '領収書.pdf', 'a'),
      stored('f-2', 'tx-1', '領収書.pdf', 'b'), // 同じ名前 → 番号を付ける
      stored('f-3', 'tx-1', '領収書.PDF', 'c'), // 大文字小文字だけの違いも同じ名前として扱う
      stored('f-4', 'tx-2', '見積/2026:05.pdf', 'd'), // 使えない文字は置き換える
      stored('f-5', '削除済みの取引', 'メモ', 'e'),
    ]);
    const paths = (await openZip(backup.blob)).map((e) => e.path);
    expect(paths).toEqual([
      'backup.json',
      'はじめにお読みください.txt',
      '証憑/2026-05-10_AMAZON 購入_3300円/領収書.pdf',
      '証憑/2026-05-10_AMAZON 購入_3300円/領収書 (2).pdf',
      '証憑/2026-05-10_AMAZON 購入_3300円/領収書 (3).PDF',
      '証憑/2026-05-10_A_B_C_D__E__F__G_500円/見積_2026_05.pdf',
      '証憑/取引なし/メモ',
    ]);
    // 名前を変えて格納しても、復元されるファイル名は元のまま
    const loaded = (await readBackupFile(backup.blob))!;
    expect(loaded.files!.map((f) => f.name)).toEqual(['領収書.pdf', '領収書.pdf', '領収書.PDF', '見積/2026:05.pdf', 'メモ']);
    expect(await loaded.files![1].blob.text()).toBe('b');
  });

  it('証憑がなければ JSON になり、復元すると端末の証憑は空に置き換わる', async () => {
    const data = await bookOf([tx('tx-1')]);
    const backup = await buildBackupFile(data, []);
    expect(backup.extension).toBe('json');
    expect(JSON.parse(await backup.blob.text())).toMatchObject({ app: 'shinkoku-snap', version: 8, attachments: [] });
    expect(await readBackupFile(backup.blob)).toMatchObject({ data, files: [], broken: 0, missing: 0 });
  });

  it('証憑を読み出せなかった(null)ときは帳簿だけになり、復元しても端末の証憑に触れない', async () => {
    const data = await bookOf([tx('tx-1')]);
    const backup = await buildBackupFile(data, null);
    expect(backup.extension).toBe('json');
    expect(await readBackupFile(backup.blob)).toMatchObject({ data, files: null });
  });

  it('中身を読み出せない証憑は飛ばして、残りでバックアップを作る', async () => {
    const data = await bookOf([tx('tx-1')]);
    const lost = stored('f-1', 'tx-1', '消えた.pdf', 'x');
    lost.blob = { size: 1, type: 'application/pdf', arrayBuffer: () => Promise.reject(new Error('NotFoundError')) } as unknown as Blob;
    const backup = await buildBackupFile(data, [lost, stored('f-2', 'tx-1', '残った.pdf', 'ok')]);
    expect(backup.skipped).toEqual(['消えた.pdf']);
    const loaded = (await readBackupFile(backup.blob))!;
    expect(loaded.files!.map((f) => f.name)).toEqual(['残った.pdf']);
  });

  it('数百件・合計100MB超でも作れて、すべて戻る(v7 の JSON 埋め込みでは作れなかった規模)', async () => {
    const data = await bookOf([tx('tx-1')]);
    const big = new Uint8Array(1024 * 1024);
    for (let i = 0; i < big.length; i++) big[i] = (i * 7) & 0xff;
    const files = Array.from({ length: 120 }, (_, i) => stored(`f-${i}`, 'tx-1', `領収書${i}.pdf`, big));
    const backup = await buildBackupFile(data, files);
    expect(backup.blob.size).toBeGreaterThan(120 * 1024 * 1024);
    const loaded = (await readBackupFile(backup.blob))!;
    expect(loaded.broken).toBe(0);
    expect(loaded.files).toHaveLength(120);
    expect(await sameBytes(loaded.files![119].blob, big)).toBe(true);
  }, 60_000);
});

describe('readBackupFile: 壊れた・欠けたバックアップ', () => {
  it('ZIP の中で壊れた証憑は数えて飛ばし、ほかは復元する', async () => {
    const data = await bookOf([tx('tx-1')]);
    const backup = await buildBackupFile(data, [
      stored('f-1', 'tx-1', '壊れる.pdf', 'AAAAAAAAAAAAAAAA-marker-AAAA'),
      stored('f-2', 'tx-1', '無事.pdf', 'ok'),
    ]);
    const zip = await bytesOf(backup.blob);
    // 1件目の中身を1バイト書き換える(保存媒体の劣化などを想定)
    const marker = new TextEncoder().encode('-marker-');
    const at = zip.findIndex((_, i) => marker.every((b, j) => zip[i + j] === b));
    zip[at] ^= 0xff;

    const loaded = (await readBackupFile(new Blob([zip])))!;
    expect(loaded.broken).toBe(1);
    expect(loaded.files!.map((f) => f.name)).toEqual(['無事.pdf']);
  });

  it('一覧にあるのに ZIP に入っていない証憑・上限(10MB)を超える証憑は壊れている扱い', async () => {
    const data = await bookOf([tx('tx-1')]);
    const meta = { txId: 'tx-1', type: 'application/pdf', size: 1, createdAt: 1 };
    const json = buildBackupJson(data, [
      { ...meta, id: 'f-1', name: 'ない.pdf', path: '証憑/ない.pdf' },
      { ...meta, id: 'f-2', name: '大きすぎ.pdf', path: '証憑/大きすぎ.pdf' },
      { ...meta, id: 'f-3', name: 'ある.pdf', path: '証憑/ある.pdf' },
    ]);
    const zip = await buildZip([
      { path: 'backup.json', data: new Blob([json]) },
      { path: '証憑/大きすぎ.pdf', data: new Blob([new Uint8Array(10 * 1024 * 1024 + 1)]) },
      { path: '証憑/ある.pdf', data: new Blob(['ok']) },
    ]);
    const loaded = (await readBackupFile(zip))!;
    expect(loaded.broken).toBe(2);
    expect(loaded.files!.map((f) => f.id)).toEqual(['f-3']);
  });

  it('ZIP から取り出した backup.json だけを指定したら、帳簿だけ復元して端末の証憑には触れない', async () => {
    const data = await bookOf([tx('tx-1')]);
    const backup = await buildBackupFile(data, [stored('f-1', 'tx-1', 'a.pdf', 'a'), stored('f-2', 'tx-1', 'b.pdf', 'b')]);
    const [book] = await openZip(backup.blob);
    const loaded = (await readBackupFile(await book.blob()))!;
    expect(loaded).toMatchObject({ data, files: null, missing: 2, broken: 0 });
  });

  it('バックアップでない ZIP・帳簿データが壊れた ZIP・JSON でないファイルは null', async () => {
    expect(await readBackupFile(await buildZip([{ path: '写真.jpg', data: new Blob(['x']) }]))).toBeNull();
    expect(await readBackupFile(await buildZip([{ path: 'backup.json', data: new Blob(['{}']) }]))).toBeNull();
    expect(await readBackupFile(new Blob(['こんにちは']))).toBeNull();
    expect(await readBackupFile(new Blob([]))).toBeNull();

    // backup.json の中身が書き換わっている(検査値が合わない)ZIP は、帳簿ごと信用しない
    const data = await bookOf([tx('tx-1')]);
    const zip = await bytesOf((await buildBackupFile(data, [stored('f-1', 'tx-1', 'a.pdf', 'a')])).blob);
    const at = zip.findIndex((_, i) => zip[i] === 0x33 && zip[i + 1] === 0x33 && zip[i + 2] === 0x30); // "3300" の先頭
    zip[at] = 0x39;
    expect(await readBackupFile(new Blob([zip]))).toBeNull();
  });

  it('途中で切れた ZIP は null(復元を始めない)', async () => {
    const data = await bookOf([tx('tx-1')]);
    const backup = await buildBackupFile(data, [stored('f-1', 'tx-1', 'a.pdf', pdfBytes)]);
    expect(await readBackupFile(backup.blob.slice(0, backup.blob.size - 100))).toBeNull();
  });
});

describe('readBackupFile: 展開してから OS の機能で圧縮し直した ZIP', () => {
  /** バックアップの ZIP を展開した中身(圧縮し直す材料) */
  async function unpack(backup: Blob): Promise<{ path: string; data: Uint8Array<ArrayBuffer> }[]> {
    const out: { path: string; data: Uint8Array<ArrayBuffer> }[] = [];
    for (const e of await openZip(backup)) out.push({ path: e.path, data: await bytesOf(await e.blob()) });
    return out;
  }
  const metaOf = (files: StoredFile[]) => files.map(({ blob: _blob, ...meta }) => meta);

  it('macOS: フォルダごと圧縮し直した ZIP(Deflate・濁点が分かれたファイル名・管理用ファイルつき)から、帳簿と証憑が戻る', async () => {
    // Mac の Safari はダウンロードした ZIP を自動で展開し、元の ZIP をゴミ箱に入れる
    const data = await bookOf([tx('tx-1', { description: 'ガソリン代 プリンタ' })]);
    const files = [
      stored('f-1', 'tx-1', 'レシート ガ.pdf', pdfBytes),
      stored('f-2', 'tx-1', '写真.jpg', new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), 'image/jpeg'),
    ];
    const folder = '申告スナップ_バックアップ_2026-11-11';
    const unpacked = await unpack((await buildBackupFile(data, files)).blob);
    const rezipped: ForeignZipEntry[] = [
      // macOS が足す管理用のファイル。帳簿データと同じ名前で終わっていても取り違えない
      { path: `__MACOSX/${folder}/backup.json`, data: new Uint8Array([0, 5, 22, 7]) },
      { path: `__MACOSX/${folder}/._backup.json`, data: new Uint8Array([0, 5, 22, 7]) },
      { path: `${folder}/.DS_Store`, data: new Uint8Array([0, 0, 0, 1]) },
      // 濁点・半濁点が分かれた形(NFD)のファイル名になる
      ...unpacked.map((e) => ({ path: `${folder}/${e.path}`.normalize('NFD'), data: e.data })),
    ];
    // 再現できていること: 元のパスのままでは見つからない名前に変わっている
    const receiptPath = unpacked.find((e) => e.path.endsWith('レシート ガ.pdf'))!.path;
    expect(receiptPath.normalize('NFD')).not.toBe(receiptPath);

    const loaded = (await readBackupFile(foreignZip(rezipped, { descriptor: true })))!;
    expect(loaded.data).toEqual(data);
    expect(loaded).toMatchObject({ newer: false, broken: 0, missing: 0 });
    expect(metaOf(loaded.files!)).toEqual(metaOf(files));
    expect(await sameBytes(loaded.files![0].blob, pdfBytes)).toBe(true);
    expect(loaded.files![0].blob.type).toBe('application/pdf');
    expect(loaded.files![1].blob.type).toBe('image/jpeg');
  });

  it('フォルダの中身だけを選んで圧縮した ZIP・区切りが \\ の ZIP からも戻る', async () => {
    const data = await bookOf([tx('tx-1')]);
    const files = [stored('f-1', 'tx-1', '領収書.pdf', pdfBytes)];
    const unpacked = await unpack((await buildBackupFile(data, files)).blob);

    const flat = (await readBackupFile(foreignZip(unpacked, { utf8Flag: true })))!;
    expect(flat).toMatchObject({ data, broken: 0 });
    expect(metaOf(flat.files!)).toEqual(metaOf(files));

    const backslash = unpacked.map((e) => ({ ...e, path: `backup\\${e.path.replace(/\//g, '\\')}` }));
    const loaded = (await readBackupFile(foreignZip(backslash, { utf8Flag: true })))!;
    expect(loaded).toMatchObject({ data, broken: 0 });
    expect(await sameBytes(loaded.files![0].blob, pdfBytes)).toBe(true);
  });

  it('圧縮し直した ZIP の中で壊れた証憑は数えて飛ばし、帳簿が壊れていれば null', async () => {
    const data = await bookOf([tx('tx-1')]);
    const unpacked = await unpack(
      (await buildBackupFile(data, [stored('f-1', 'tx-1', '壊れる.pdf', pdfBytes), stored('f-2', 'tx-1', '無事.pdf', 'ok')])).blob,
    );
    // 圧縮し直した後に中身が1バイト変わった状態(記録された検査値は元のまま)
    const damaged = (name: string): ForeignZipEntry[] =>
      unpacked.map((e) =>
        e.path.endsWith(name)
          ? { path: e.path, data: e.data.map((b, i) => (i === 100 ? b ^ 0xff : b)), crc: crc32(e.data) }
          : e,
      );

    const loaded = (await readBackupFile(foreignZip(damaged('壊れる.pdf'))))!;
    expect(loaded.broken).toBe(1);
    expect(loaded.files!.map((f) => f.name)).toEqual(['無事.pdf']);
    expect(await readBackupFile(foreignZip(damaged('backup.json')))).toBeNull();
  });

  it('対応していない圧縮方式(Deflate64 など)で圧縮し直した ZIP は null(復元を始めない)', async () => {
    const data = await bookOf([tx('tx-1')]);
    const unpacked = await unpack((await buildBackupFile(data, [stored('f-1', 'tx-1', 'a.pdf', 'a')])).blob);
    expect(await readBackupFile(foreignZip(unpacked))).not.toBeNull();
    expect(await readBackupFile(foreignZip(unpacked.map((e) => ({ ...e, method: 9 }))))).toBeNull();
  });
});

describe('readBackupFile: 以前の版のバックアップ(JSON)', () => {
  it('v7(証憑を base64 で埋め込み)は証憑ごと復元でき、壊れた base64 は数えて飛ばす', async () => {
    const data = await bookOf([tx('tx-1')]);
    const meta = { txId: 'tx-1', name: '領収書.pdf', type: 'application/pdf', size: 5, createdAt: 5000 };
    const json = JSON.stringify({
      app: 'shinkoku-snap',
      version: 7,
      data,
      files: [
        { ...meta, id: 'f-1', data: 'aGVsbG8=' }, // "hello"
        { ...meta, id: 'f-2', data: 'aGVsb' }, // 文字は base64 だが長さが半端で復号できない
      ],
    });
    const loaded = (await readBackupFile(new Blob([json])))!;
    expect(loaded.data).toEqual(data);
    expect(loaded.broken).toBe(1);
    expect(loaded.files).toHaveLength(1);
    expect(loaded.files![0]).toMatchObject({ ...meta, id: 'f-1' });
    expect(await loaded.files![0].blob.text()).toBe('hello');
  });

  it('v6以前(証憑を含まない)・生データは、端末の証憑に触れない', async () => {
    const data = await bookOf([tx('tx-1')]);
    const v6 = new Blob([JSON.stringify({ app: 'shinkoku-snap', version: 6, data })]);
    expect(await readBackupFile(v6)).toMatchObject({ data, files: null, broken: 0, missing: 0 });
    expect(await readBackupFile(new Blob([JSON.stringify(data)]))).toMatchObject({ data, files: null });
  });

  it('新しい版のバックアップは newer で知らせる', async () => {
    const data = await bookOf([tx('tx-1')]);
    const future = new Blob([JSON.stringify({ app: 'shinkoku-snap', version: 999, data, attachments: [] })]);
    expect((await readBackupFile(future))!.newer).toBe(true);
  });
});
