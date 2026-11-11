import { describe, expect, it } from 'vitest';
import { foreignZip } from './testing/foreignZip';
import { blobCrc32, buildZip, crc32, isZip, openZip } from './zip';

const bytes = (...values: number[]) => new Uint8Array(values);
const text = (s: string) => new TextEncoder().encode(s);
const bytesOf = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer());
/** 中身が同じか(大きなバイト列を toEqual で比べると遅いため) */
const sameBytes = async (blob: Blob, expected: Uint8Array) => Buffer.from(await blob.arrayBuffer()).equals(expected);

/** バイト列の中から並びを探す(見つからなければ -1) */
function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
  outer: for (let i = from; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

describe('crc32', () => {
  it('標準の検査値と一致する', () => {
    // CRC-32(IEEE 802.3)の検査用の値
    expect(crc32(text('123456789'))).toBe(0xcbf43926);
    expect(crc32(bytes())).toBe(0);
  });

  it('1バイト変わると値が変わる', async () => {
    expect(await blobCrc32(new Blob([bytes(1, 2, 3)]))).not.toBe(await blobCrc32(new Blob([bytes(1, 2, 4)])));
  });
});

describe('buildZip → openZip の往復', () => {
  const binary = new Uint8Array(70_000).map((_, i) => (i * 31 + 7) & 0xff);
  const inputs = [
    { path: 'backup.json', data: new Blob(['{"取引":[]}']) },
    { path: '証憑/2026-05-10_AMAZON_3300円/領収書.pdf', data: new Blob([binary], { type: 'application/pdf' }) },
    { path: '証憑/空のファイル.txt', data: new Blob([]) },
  ];

  it('日本語のパス・バイナリ・空ファイルを、中身を変えずに取り出せる', async () => {
    const zip = await buildZip(inputs);
    expect(zip.type).toBe('application/zip');
    expect(await isZip(zip)).toBe(true);

    const entries = await openZip(zip);
    expect(entries.map((e) => e.path)).toEqual(inputs.map((i) => i.path));
    expect(entries.map((e) => e.size)).toEqual([text('{"取引":[]}').length, 70_000, 0]);
    expect(await (await entries[0].blob()).text()).toBe('{"取引":[]}');

    const pdf = await entries[1].blob('application/pdf');
    expect(pdf.type).toBe('application/pdf');
    expect(await sameBytes(pdf, binary)).toBe(true);
    expect(entries[1].crc).toBe(crc32(binary));
    expect((await entries[2].blob()).size).toBe(0);
  });

  it('計算済みの CRC を渡すと、その値をそのまま書く', async () => {
    const [entry] = await openZip(await buildZip([{ path: 'a.bin', data: new Blob([binary]), crc: 0x12345678 }]));
    expect(entry.crc).toBe(0x12345678);
  });

  it('ファイルが0件でも ZIP として読める', async () => {
    const zip = await buildZip([]);
    expect(zip.size).toBe(22);
    expect(await openZip(zip)).toEqual([]);
  });

  it('ZIP64 形式(4GB を超える書庫と同じ形式)でも往復できる', async () => {
    const zip = await buildZip(inputs, { forceZip64: true });
    const plain = await buildZip(inputs);
    // 1ファイルごとに拡張欄12バイト + ZIP64 の終端レコード56バイト + 位置表示20バイト
    expect(zip.size).toBe(plain.size + inputs.length * 12 + 56 + 20);
    const entries = await openZip(zip);
    expect(entries.map((e) => e.path)).toEqual(inputs.map((i) => i.path));
    expect(await sameBytes(await entries[1].blob(), binary)).toBe(true);
  });

  it('後ろにコメントが付いていても読める', async () => {
    const zip = await bytesOf(await buildZip(inputs));
    // 終端レコードのコメント長(末尾2バイト)を5にして、コメントを足す
    zip[zip.length - 2] = 5;
    const entries = await openZip(new Blob([zip, text('hello')]));
    expect(entries).toHaveLength(3);
  });
});

describe('openZip: 読めないもの', () => {
  it('ZIP でないファイルは例外にする', async () => {
    const json = new Blob(['{"app":"shinkoku-snap","data":{"transactions":[]}}']);
    expect(await isZip(json)).toBe(false);
    expect(await isZip(new Blob(['PK']))).toBe(false);
    await expect(openZip(json)).rejects.toThrow('ZIP ではありません');
  });

  it('途中で切れた ZIP(ダウンロードの失敗など)は例外にする', async () => {
    const zip = await buildZip([{ path: 'a.txt', data: new Blob(['x'.repeat(1000)]) }]);
    await expect(openZip(zip.slice(0, zip.size - 30))).rejects.toThrow();
    // 先頭が欠けると、目次の指す位置がずれる
    await expect(openZip(zip.slice(200))).rejects.toThrow('ZIP の構造が壊れています');
  });

  it('Deflate 以外の圧縮方式は、取り出すときに分かる形で断る(目次は読める)', async () => {
    const zip = await bytesOf(await buildZip([{ path: 'a.txt', data: new Blob(['hello']) }]));
    // 目次(セントラルディレクトリ)の圧縮方式を 9(Deflate64)に書き換える
    const cd = indexOfBytes(zip, bytes(0x50, 0x4b, 0x01, 0x02));
    zip[cd + 10] = 9;
    const [entry] = await openZip(new Blob([zip]));
    expect(entry.path).toBe('a.txt');
    await expect(entry.blob()).rejects.toThrow('対応していない圧縮方式の ZIP です');
  });
});

describe('openZip: ほかのソフトが作った ZIP(展開してから OS の機能で圧縮し直したもの)', () => {
  const raw = text('hello hello hello hello '.repeat(200));
  const binary = new Uint8Array(70_000).map((_, i) => (i * 31 + 7) & 0xff);

  it('Deflate で圧縮された中身を、元に戻して取り出せる', async () => {
    const zip = foreignZip([
      { path: 'a.txt', data: raw },
      { path: '証憑/領収書.pdf', data: binary },
      { path: '空.txt', data: bytes() },
      { path: '無圧縮.bin', data: binary, method: 0 },
    ]);
    // 圧縮されて小さくなっている(中身をそのまま並べた ZIP ではない)
    expect(zip.size).toBeLessThan(raw.length + binary.length * 2);
    const entries = await openZip(zip);
    expect(entries.map((e) => e.path)).toEqual(['a.txt', '証憑/領収書.pdf', '空.txt', '無圧縮.bin']);
    expect(entries[0]).toMatchObject({ size: raw.length, crc: crc32(raw) });

    const txt = await entries[0].blob('text/plain');
    expect(txt.type).toBe('text/plain');
    expect(await sameBytes(txt, raw)).toBe(true);
    expect(await sameBytes(await entries[1].blob(), binary)).toBe(true);
    expect((await entries[2].blob()).size).toBe(0);
    expect(await sameBytes(await entries[3].blob(), binary)).toBe(true);
  });

  it('サイズと検査値が中身の後ろに書かれた形式(macOS の圧縮機能)も読める', async () => {
    const entries = await openZip(
      foreignZip(
        [
          { path: 'a.txt', data: raw },
          { path: 'b.bin', data: binary },
        ],
        { descriptor: true },
      ),
    );
    expect(entries.map((e) => e.size)).toEqual([raw.length, binary.length]);
    expect(await sameBytes(await entries[0].blob(), raw)).toBe(true);
    expect(await sameBytes(await entries[1].blob(), binary)).toBe(true);
    expect(await blobCrc32(await entries[1].blob())).toBe(entries[1].crc);
  });

  it('UTF-8 の印がないファイル名は、UTF-8 として読めなければ Shift_JIS(日本語版 Windows)として読む', async () => {
    // 「証憑/領収書.pdf」を Shift_JIS で表したバイト列
    const sjis = bytes(0x8f, 0xd8, 0x9c, 0xdf, 0x2f, 0x97, 0xcc, 0x8e, 0xfb, 0x8f, 0x91, 0x2e, 0x70, 0x64, 0x66);
    const entries = await openZip(
      foreignZip([
        { path: '証憑/領収書.pdf', data: raw }, // UTF-8(macOS)
        { path: sjis, data: raw },
        { path: 'backup.json', data: raw },
      ]),
    );
    expect(entries.map((e) => e.path)).toEqual(['証憑/領収書.pdf', '証憑/領収書.pdf', 'backup.json']);
  });

  it('圧縮された中身が壊れているときは、取り出すときに例外にする', async () => {
    const zip = await bytesOf(foreignZip([{ path: 'a.txt', data: raw }]));
    // 中身はローカルヘッダー(30バイト + ファイル名5バイト)の直後から。その先頭を書き換える
    zip[35] ^= 0xff;
    const [entry] = await openZip(new Blob([zip]));
    await expect(entry.blob()).rejects.toThrow();
  });
});

describe('ZIP の形式(ほかのソフトで展開できること)', () => {
  it('ローカルヘッダーが仕様どおりで、中身がそのまま続く', async () => {
    const zip = await bytesOf(
      await buildZip([{ path: 'メモ.txt', data: new Blob(['hello']), modified: new Date(2026, 10, 11, 9, 30, 20).getTime() }]),
    );
    const view = new DataView(zip.buffer);
    const name = text('メモ.txt');
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    expect(view.getUint16(6, true)).toBe(0x0800); // ファイル名は UTF-8
    expect(view.getUint16(8, true)).toBe(0); // 無圧縮
    // 2026-11-11 09:30:20 → MS-DOS 形式
    expect(view.getUint16(10, true)).toBe((9 << 11) | (30 << 5) | 10);
    expect(view.getUint16(12, true)).toBe(((2026 - 1980) << 9) | (11 << 5) | 11);
    expect(view.getUint32(14, true)).toBe(crc32(text('hello')));
    expect(view.getUint32(18, true)).toBe(5);
    expect(view.getUint32(22, true)).toBe(5);
    expect(view.getUint16(26, true)).toBe(name.length);
    expect(zip.slice(30, 30 + name.length)).toEqual(name);
    expect(zip.slice(30 + name.length, 30 + name.length + 5)).toEqual(text('hello'));
    // 終端レコード: 1件・目次の位置はファイル本体の直後
    const end = zip.length - 22;
    expect(view.getUint32(end, true)).toBe(0x06054b50);
    expect(view.getUint16(end + 10, true)).toBe(1);
    expect(view.getUint32(end + 16, true)).toBe(30 + name.length + 5);
  });
});
