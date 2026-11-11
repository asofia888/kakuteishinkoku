/**
 * ZIP(無圧縮)の最小限の読み書き。バックアップに証憑ファイルをそのまま同梱するために使う。
 * - 書き込み: 中身(Blob)は連結するだけで、まとめてメモリに載せない(CRC の計算時に1件ずつ読む)。
 *   4GB を超える書庫・65,535件以上のファイルは ZIP64 形式で書く
 * - 読み込み: 末尾の目次(セントラルディレクトリ)だけを読み、各ファイルは書庫の該当部分を指す Blob で返す
 * 証憑(JPEG・PDF)はすでに圧縮されていて縮まないため、圧縮はしない。
 * 利用者が OS の機能で展開すれば、アプリがなくても証憑を取り出せる。
 * 展開したものを OS の機能で圧縮し直した ZIP(Deflate 圧縮・ファイル名に UTF-8 の印なし)も読める。
 */

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;
const SIG_END64 = 0x06064b50;
const SIG_LOCATOR64 = 0x07064b50;
/** 16ビット・32ビットの欄に入りきらない値の印(本当の値は ZIP64 の欄にある) */
const MAX16 = 0xffff;
const MAX32 = 0xffffffff;
/** ファイル名が UTF-8 であることを示すフラグ(日本語のファイル名を正しく展開させる) */
const FLAG_UTF8 = 0x0800;
const VERSION_DEFAULT = 20;
const VERSION_ZIP64 = 45;

let crcTable: Uint32Array | null = null;

/** CRC-32(ZIP の各ファイルの検査値。読み込み時に中身が壊れていないかの確認にも使う) */
export function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Blob の中身の CRC-32 */
export async function blobCrc32(blob: Blob): Promise<number> {
  return crc32(new Uint8Array(await blob.arrayBuffer()));
}

export interface ZipInput {
  /** 書庫内のパス(/ 区切り) */
  path: string;
  data: Blob;
  /** 更新日時(ミリ秒)。省略時は現在 */
  modified?: number;
  /** 中身の CRC-32 を計算済みなら渡す(省略時はここで中身を読んで計算する) */
  crc?: number;
}

/** MS-DOS 形式の日時(ZIP のヘッダー用。1980〜2107年・2秒単位) */
function dosDateTime(ms: number): { time: number; date: number } {
  const d = new Date(ms);
  const year = Math.min(2107, Math.max(1980, d.getFullYear()));
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

interface Written {
  name: Uint8Array;
  crc: number;
  size: number;
  time: number;
  date: number;
  /** ローカルヘッダーの位置 */
  offset: number;
}

function localHeader(e: Written): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(30 + e.name.length);
  const v = new DataView(b.buffer);
  v.setUint32(0, SIG_LOCAL, true);
  v.setUint16(4, VERSION_DEFAULT, true);
  v.setUint16(6, FLAG_UTF8, true);
  v.setUint16(8, 0, true); // 圧縮方式 0 = 無圧縮
  v.setUint16(10, e.time, true);
  v.setUint16(12, e.date, true);
  v.setUint32(14, e.crc, true);
  v.setUint32(18, e.size, true);
  v.setUint32(22, e.size, true);
  v.setUint16(26, e.name.length, true);
  v.setUint16(28, 0, true);
  b.set(e.name, 30);
  return b;
}

function centralHeader(e: Written, zip64: boolean): Uint8Array<ArrayBuffer> {
  // 位置が32ビットに入らないファイルだけ、ZIP64 の拡張欄(ID 1・8バイトの位置)を付ける
  const wide = zip64 || e.offset >= MAX32;
  const extraLength = wide ? 12 : 0;
  const b = new Uint8Array(46 + e.name.length + extraLength);
  const v = new DataView(b.buffer);
  v.setUint32(0, SIG_CENTRAL, true);
  v.setUint16(4, wide ? VERSION_ZIP64 : VERSION_DEFAULT, true);
  v.setUint16(6, wide ? VERSION_ZIP64 : VERSION_DEFAULT, true);
  v.setUint16(8, FLAG_UTF8, true);
  v.setUint16(10, 0, true);
  v.setUint16(12, e.time, true);
  v.setUint16(14, e.date, true);
  v.setUint32(16, e.crc, true);
  v.setUint32(20, e.size, true);
  v.setUint32(24, e.size, true);
  v.setUint16(28, e.name.length, true);
  v.setUint16(30, extraLength, true);
  v.setUint32(42, wide ? MAX32 : e.offset, true);
  b.set(e.name, 46);
  if (wide) {
    const x = 46 + e.name.length;
    v.setUint16(x, 0x0001, true);
    v.setUint16(x + 2, 8, true);
    v.setBigUint64(x + 4, BigInt(e.offset), true);
  }
  return b;
}

/** 書庫の終端(必要なら ZIP64 の終端レコードと位置表示を前に付ける) */
function endRecords(count: number, cdSize: number, cdOffset: number, zip64: boolean): Uint8Array<ArrayBuffer> {
  const wide = zip64 || count >= MAX16 || cdSize >= MAX32 || cdOffset >= MAX32;
  const b = new Uint8Array((wide ? 56 + 20 : 0) + 22);
  const v = new DataView(b.buffer);
  let p = 0;
  if (wide) {
    v.setUint32(p, SIG_END64, true);
    v.setBigUint64(p + 4, BigInt(44), true); // この後に続くレコードの長さ
    v.setUint16(p + 12, VERSION_ZIP64, true);
    v.setUint16(p + 14, VERSION_ZIP64, true);
    v.setBigUint64(p + 24, BigInt(count), true);
    v.setBigUint64(p + 32, BigInt(count), true);
    v.setBigUint64(p + 40, BigInt(cdSize), true);
    v.setBigUint64(p + 48, BigInt(cdOffset), true);
    p += 56;
    v.setUint32(p, SIG_LOCATOR64, true);
    v.setBigUint64(p + 8, BigInt(cdOffset + cdSize), true); // ZIP64 終端レコードの位置
    v.setUint32(p + 16, 1, true);
    p += 20;
  }
  v.setUint32(p, SIG_END, true);
  v.setUint16(p + 8, wide ? MAX16 : count, true);
  v.setUint16(p + 10, wide ? MAX16 : count, true);
  v.setUint32(p + 12, wide ? MAX32 : cdSize, true);
  v.setUint32(p + 16, wide ? MAX32 : cdOffset, true);
  return b;
}

/**
 * ファイルを無圧縮の ZIP にまとめる。
 * forceZip64 は小さい書庫でも ZIP64 形式で書く(4GB 超の書庫と同じ形式をテストで確かめるため)
 */
export async function buildZip(entries: ZipInput[], opts: { forceZip64?: boolean } = {}): Promise<Blob> {
  const zip64 = opts.forceZip64 === true;
  const encoder = new TextEncoder();
  const parts: BlobPart[] = [];
  const written: Written[] = [];
  let offset = 0;
  for (const entry of entries) {
    if (entry.data.size >= MAX32) throw new Error(`4GB 以上のファイルは格納できません: ${entry.path}`);
    const e: Written = {
      name: encoder.encode(entry.path),
      crc: entry.crc ?? (await blobCrc32(entry.data)),
      size: entry.data.size,
      ...dosDateTime(entry.modified ?? Date.now()),
      offset,
    };
    const header = localHeader(e);
    parts.push(header, entry.data);
    written.push(e);
    offset += header.length + e.size;
  }
  const cdOffset = offset;
  let cdSize = 0;
  for (const e of written) {
    const header = centralHeader(e, zip64);
    parts.push(header);
    cdSize += header.length;
  }
  parts.push(endRecords(written.length, cdSize, cdOffset, zip64));
  return new Blob(parts, { type: 'application/zip' });
}

export interface ZipEntry {
  path: string;
  /** 元のサイズ(バイト) */
  size: number;
  /** 中身の CRC-32(blobCrc32 と比べれば壊れていないか確かめられる) */
  crc: number;
  /** 中身。書庫の該当部分を指すだけで、読むまでメモリに載らない */
  blob(type?: string): Promise<Blob>;
}

async function viewOf(file: Blob, start: number, end: number): Promise<DataView> {
  if (start < 0 || end > file.size || start > end) throw new Error('ZIP の構造が壊れています');
  return new DataView(await file.slice(start, end).arrayBuffer());
}

/**
 * ファイル名を読む。このアプリは UTF-8 の印を付けて書くが、OS の機能で圧縮し直した ZIP には印がなく、
 * 中身は UTF-8(macOS など)のことも、Shift_JIS(日本語版 Windows)のこともある
 */
function decodeName(bytes: Uint8Array, utf8: boolean): string {
  if (!utf8) {
    for (const encoding of ['utf-8', 'shift_jis']) {
      try {
        return new TextDecoder(encoding, { fatal: true }).decode(bytes);
      } catch {
        // この文字コードではない(または、この環境では扱えない)。次を試す
      }
    }
  }
  return new TextDecoder().decode(bytes);
}

/** Deflate で圧縮された中身を元に戻す */
async function inflate(packed: Blob, type?: string): Promise<Blob> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('このブラウザでは、圧縮された ZIP を読み込めません');
  }
  const stream = packed.stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Blob([await new Response(stream).arrayBuffer()], type ? { type } : undefined);
}

/** ファイルの先頭が ZIP か(拡張子ではなく中身で判定する) */
export async function isZip(file: Blob): Promise<boolean> {
  if (file.size < 22) return false;
  const sig = (await viewOf(file, 0, 4)).getUint32(0, true);
  return sig === SIG_LOCAL || sig === SIG_END;
}

/**
 * ZIP の目次を読む。ZIP として読めなければ例外を投げる。
 * 各ファイルの中身は blob() を呼んだときに取り出す(無圧縮と Deflate 圧縮に対応)
 */
export async function openZip(file: Blob): Promise<ZipEntry[]> {
  // 終端レコードは末尾の「22バイト + コメント(最大65,535バイト)」のどこかにある
  const tailStart = Math.max(0, file.size - (22 + MAX16));
  const tail = await viewOf(file, tailStart, file.size);
  let p = tail.byteLength - 22;
  while (p >= 0 && tail.getUint32(p, true) !== SIG_END) p--;
  if (p < 0) throw new Error('ZIP ではありません');

  let count = tail.getUint16(p + 10, true);
  let cdSize = tail.getUint32(p + 12, true);
  let cdOffset = tail.getUint32(p + 16, true);
  if (count === MAX16 || cdSize === MAX32 || cdOffset === MAX32) {
    // ZIP64: 終端レコードの直前の位置表示(20バイト)が、本当の値を持つ終端レコードを指す
    const locatorPos = tailStart + p - 20;
    const locator = await viewOf(file, locatorPos, locatorPos + 20);
    if (locator.getUint32(0, true) !== SIG_LOCATOR64) throw new Error('ZIP の構造が壊れています');
    const end64Pos = Number(locator.getBigUint64(8, true));
    const end64 = await viewOf(file, end64Pos, end64Pos + 56);
    if (end64.getUint32(0, true) !== SIG_END64) throw new Error('ZIP の構造が壊れています');
    count = Number(end64.getBigUint64(32, true));
    cdSize = Number(end64.getBigUint64(40, true));
    cdOffset = Number(end64.getBigUint64(48, true));
  }

  const cd = await viewOf(file, cdOffset, cdOffset + cdSize);
  const entries: ZipEntry[] = [];
  let q = 0;
  for (let i = 0; i < count; i++) {
    if (q + 46 > cd.byteLength || cd.getUint32(q, true) !== SIG_CENTRAL) {
      throw new Error('ZIP の構造が壊れています');
    }
    const flags = cd.getUint16(q + 8, true);
    const method = cd.getUint16(q + 10, true);
    const crc = cd.getUint32(q + 16, true);
    let packedSize = cd.getUint32(q + 20, true);
    let size = cd.getUint32(q + 24, true);
    const nameLength = cd.getUint16(q + 28, true);
    const extraLength = cd.getUint16(q + 30, true);
    const commentLength = cd.getUint16(q + 32, true);
    let offset = cd.getUint32(q + 42, true);
    const nameStart = q + 46;
    const path = decodeName(
      new Uint8Array(cd.buffer, cd.byteOffset + nameStart, nameLength),
      (flags & FLAG_UTF8) !== 0,
    );
    // ZIP64 の拡張欄(ID 1): 32ビットの欄が 0xFFFFFFFF の項目だけが、
    // 元のサイズ → 格納サイズ → 位置 の順に8バイトずつ入っている
    const extraEnd = nameStart + nameLength + extraLength;
    for (let x = nameStart + nameLength; x + 4 <= extraEnd; ) {
      const id = cd.getUint16(x, true);
      const length = cd.getUint16(x + 2, true);
      if (id === 0x0001) {
        let y = x + 4;
        if (size === MAX32) {
          size = Number(cd.getBigUint64(y, true));
          y += 8;
        }
        if (packedSize === MAX32) {
          packedSize = Number(cd.getBigUint64(y, true));
          y += 8;
        }
        if (offset === MAX32) offset = Number(cd.getBigUint64(y, true));
      }
      x += 4 + length;
    }
    const entryOffset = offset;
    const entryPackedSize = packedSize;
    entries.push({
      path,
      size,
      crc,
      async blob(type) {
        // 0 = 無圧縮(このアプリが書く形式)、8 = Deflate(OS の機能などで圧縮し直した ZIP)
        if (method !== 0 && method !== 8) throw new Error(`対応していない圧縮方式の ZIP です: ${path}`);
        // 中身はローカルヘッダー(30バイト + ファイル名 + 拡張欄)の直後から始まる
        const local = await viewOf(file, entryOffset, entryOffset + 30);
        if (local.getUint32(0, true) !== SIG_LOCAL) throw new Error('ZIP の構造が壊れています');
        const start = entryOffset + 30 + local.getUint16(26, true) + local.getUint16(28, true);
        if (start + entryPackedSize > file.size) throw new Error('ZIP の構造が壊れています');
        const packed = file.slice(start, start + entryPackedSize, type);
        return method === 0 ? packed : inflate(packed, type);
      },
    });
    q = extraEnd + commentLength;
  }
  return entries;
}
