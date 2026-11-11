import { deflateRawSync } from 'node:zlib';
import { crc32 } from '../zip';

export interface ForeignZipEntry {
  /** 書庫内のパス。バイト列で渡すと、その並びのまま書く(UTF-8 以外の文字コードの再現用) */
  path: string | Uint8Array<ArrayBuffer>;
  data: Uint8Array<ArrayBuffer>;
  /**
   * 圧縮方式の番号(省略時は 8 = Deflate)。8 以外は中身をそのまま書く
   * (0 = 無圧縮。対応していない方式の ZIP を再現するときは、その番号だけを書く)
   */
  method?: number;
  /** 検査値(CRC-32)。省略時は中身から計算する(記録と中身が合わない ZIP の再現用) */
  crc?: number;
}

export interface ForeignZipOptions {
  /** 「ファイル名は UTF-8」の印を付ける(省略時は付けない = macOS や古い Windows の圧縮機能と同じ) */
  utf8Flag?: boolean;
  /** サイズと検査値をローカルヘッダーではなく中身の後ろ(データ記述子)に書く(macOS の圧縮機能と同じ) */
  descriptor?: boolean;
}

/**
 * テスト専用: OS の圧縮機能など、ほかのソフトが作る形の ZIP を組み立てる。
 * このアプリの書き込み(lib/zip.ts の buildZip)は無圧縮・UTF-8 の印つきしか作らないため、
 * 「展開してから圧縮し直した ZIP」を読めることは、ここで別に組み立てた ZIP で確かめる
 */
export function foreignZip(entries: ForeignZipEntry[], opts: ForeignZipOptions = {}): Blob {
  const flags = (opts.utf8Flag ? 0x0800 : 0) | (opts.descriptor ? 0x0008 : 0);
  const body: Uint8Array<ArrayBuffer>[] = [];
  const central: Uint8Array<ArrayBuffer>[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = typeof e.path === 'string' ? new TextEncoder().encode(e.path) : e.path;
    const method = e.method ?? 8;
    const packed = method === 8 ? new Uint8Array(deflateRawSync(e.data)) : e.data;
    const crc = e.crc ?? crc32(e.data);

    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, flags, true);
    lv.setUint16(8, method, true);
    if (!opts.descriptor) {
      lv.setUint32(14, crc, true);
      lv.setUint32(18, packed.length, true);
      lv.setUint32(22, e.data.length, true);
    }
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    body.push(local, packed);
    let written = local.length + packed.length;
    if (opts.descriptor) {
      const descriptor = new Uint8Array(16);
      const dv = new DataView(descriptor.buffer);
      dv.setUint32(0, 0x08074b50, true);
      dv.setUint32(4, crc, true);
      dv.setUint32(8, packed.length, true);
      dv.setUint32(12, e.data.length, true);
      body.push(descriptor);
      written += descriptor.length;
    }

    const header = new Uint8Array(46 + name.length);
    const cv = new DataView(header.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, flags, true);
    cv.setUint16(10, method, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, packed.length, true);
    cv.setUint32(24, e.data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    header.set(name, 46);
    central.push(header);
    offset += written;
  }
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, central.reduce((sum, h) => sum + h.length, 0), true);
  ev.setUint32(16, offset, true);
  return new Blob([...body, ...central, end]);
}
