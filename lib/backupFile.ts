import { BackupAttachment, buildBackupJson, parseBackup, ParsedBackup } from './backup';
import { MAX_FILE_SIZE, portableToStored, StoredFile } from './files';
import { AppData, Transaction } from './types';
import { blobCrc32, buildZip, isZip, openZip, ZipEntry, ZipInput } from './zip';

/**
 * バックアップファイルの組み立てと読み込み。
 * - 証憑がないとき: 帳簿データの JSON 1つ
 * - 証憑があるとき: ZIP(帳簿データの backup.json + 証憑ファイルそのもの)
 * 以前(v7)は証憑を base64 にして JSON に埋め込んでいたが、証憑が数百MBになると
 * 1つの文字列に収まらずバックアップ自体が作れなくなるため、ファイルのまま ZIP に入れる。
 * ZIP は展開すれば証憑を取引ごとのフォルダで確認できる(復元には ZIP をそのまま指定する)。
 * Mac の Safari はダウンロードした ZIP を自動で展開してしまうため、
 * 展開後のフォルダを OS の機能で圧縮し直した ZIP からも復元できるようにしている。
 */

/** ZIP 内の帳簿データのファイル名 */
const BOOK_PATH = 'backup.json';
const FILES_DIR = '証憑';
const README_PATH = 'はじめにお読みください.txt';
const README_TEXT = [
  '「申告スナップ」のバックアップです。',
  '',
  '■ 復元するとき',
  'この ZIP ファイルを展開せず、そのままアプリのダッシュボード「バックアップから復元」で指定してください。',
  '',
  '■ ZIP が展開されて、フォルダになっているとき',
  '(Mac の Safari は、ダウンロードした ZIP を自動で展開します)',
  'このフォルダを ZIP に圧縮し直して、その ZIP を指定してください。',
  'フォルダの中の backup.json だけを指定すると、帳簿データは戻りますが証憑ファイルは戻りません。',
  '',
  '■ 中身',
  `・${BOOK_PATH} … 帳簿データ(取引・設定など)`,
  `・${FILES_DIR} フォルダ … 取引に添付した領収書・請求書などのファイル(取引ごとのフォルダに入っています)`,
  '',
].join('\r\n');

/**
 * 書庫内のパスを照合用にそろえる。macOS で展開・圧縮し直すと、濁点・半濁点が
 * 分かれた形(「プ」→「フ」+「゜」)のファイル名に変わることがある
 */
const pathKey = (path: string) => path.normalize('NFC');

/** フォルダ名・ファイル名に使えない文字を置き換え、長さを切り詰める(Windows でも展開できるように) */
function safeName(text: string, max: number): string {
  const cleaned = text
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  // 末尾のピリオド・空白は Windows で扱えない
  return [...cleaned].slice(0, max).join('').replace(/[. ]+$/, '');
}

/** 取引ごとのフォルダ名(取引日_摘要_金額)。取引が見つからない証憑は「取引なし」にまとめる */
function folderOf(tx: Transaction | undefined): string {
  if (!tx) return `${FILES_DIR}/取引なし`;
  const parts = [safeName(tx.date, 10), safeName(tx.description, 30), `${tx.amount}円`];
  return `${FILES_DIR}/${parts.filter((p) => p !== '').join('_')}`;
}

/** 拡張子を残してファイル名を安全な形にする */
function safeFileName(name: string): string {
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? safeName(name.slice(dot + 1), 10) : '';
  const stem = safeName(dot > 0 ? name.slice(0, dot) : name, 60) || '証憑';
  return ext ? `${stem}.${ext}` : stem;
}

/** 同じフォルダに同じ名前のファイルがあれば「名前 (2).pdf」のように番号を付ける */
function uniquePath(dir: string, name: string, used: Set<string>): string {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let n = 1; ; n++) {
    const path = `${dir}/${n === 1 ? name : `${stem} (${n})${ext}`}`;
    // Windows・macOS は大文字と小文字を区別しない。macOS は濁点などの表し方の違いも区別しない
    const key = pathKey(path).toLowerCase();
    if (!used.has(key)) {
      used.add(key);
      return path;
    }
  }
}

export interface BackupFile {
  blob: Blob;
  extension: 'json' | 'zip';
  /** 中身を読み出せず、バックアップに含められなかった証憑のファイル名 */
  skipped: string[];
}

/**
 * バックアップファイルを作る。
 * files に null を渡す(証憑を読み出せなかった)と帳簿データだけになり、
 * そのバックアップを復元しても端末の証憑には触れない
 */
export async function buildBackupFile(data: AppData, files: StoredFile[] | null): Promise<BackupFile> {
  const txById = new Map(data.transactions.map((t) => [t.id, t]));
  const used = new Set<string>();
  const attachments: BackupAttachment[] = [];
  const entries: ZipInput[] = [];
  const skipped: string[] = [];
  for (const f of files ?? []) {
    let crc: number;
    try {
      crc = await blobCrc32(f.blob);
    } catch {
      // ブラウザ側でファイルの実体が失われている等。この1件のためにバックアップ全体を止めない
      skipped.push(f.name);
      continue;
    }
    const path = uniquePath(folderOf(txById.get(f.txId)), safeFileName(f.name), used);
    attachments.push({
      id: f.id,
      txId: f.txId,
      name: f.name,
      type: f.type,
      size: f.blob.size,
      createdAt: f.createdAt,
      path,
    });
    entries.push({ path, data: f.blob, modified: f.createdAt, crc });
  }
  const json = buildBackupJson(data, files ? attachments : undefined);
  if (entries.length === 0) {
    return { blob: new Blob([json], { type: 'application/json' }), extension: 'json', skipped };
  }
  const blob = await buildZip([
    { path: BOOK_PATH, data: new Blob([json]) },
    // メモ帳で文字化けしないよう BOM を付ける
    { path: README_PATH, data: new Blob(['\ufeff', README_TEXT]) },
    ...entries,
  ]);
  return { blob, extension: 'zip', skipped };
}

export interface LoadedBackup {
  data: AppData;
  /** このアプリより新しい版で作られたバックアップか(復元前の警告用) */
  newer: boolean;
  /** 復元する証憑(端末の証憑をこれで置き換える)。null のときは端末の証憑に触れない */
  files: StoredFile[] | null;
  /** バックアップに記録はあるが、壊れていて復元できない証憑の件数 */
  broken: number;
  /** 証憑の中身は ZIP にあるのに JSON だけが指定されたため、復元できない証憑の件数 */
  missing: number;
}

/** バックアップの ZIP の中身: 帳簿データと、書庫内のパスから証憑を引く関数 */
interface BackupArchive {
  book: ZipEntry;
  find(path: string): ZipEntry | undefined;
}

/**
 * ZIP の中から帳簿データ(backup.json)を探す。なければ null。
 * ダウンロードした ZIP そのままなら一番上にある。展開したフォルダごと圧縮し直した ZIP では
 * 「フォルダ名/backup.json」になるため、そのフォルダの中を書庫の一番上とみなす
 */
function openBackupArchive(all: ZipEntry[]): BackupArchive | null {
  const items = all
    // 区切りが \ の ZIP を作るソフトがある(このアプリが書くパスに \ は現れない)
    .map((entry) => ({ entry, path: entry.path.replace(/\\/g, '/') }))
    // macOS が圧縮時に足す管理用のファイルは見ない
    .filter(({ path }) => !path.startsWith('__MACOSX/'));
  const depth = (path: string) => path.split('/').length;
  const book =
    items.find(({ path }) => path === BOOK_PATH) ??
    items
      .filter(({ path }) => path.endsWith(`/${BOOK_PATH}`))
      .sort((a, b) => depth(a.path) - depth(b.path))[0];
  if (!book) return null;
  const root = book.path.slice(0, book.path.length - BOOK_PATH.length);
  const exact = new Map<string, ZipEntry>();
  const normalized = new Map<string, ZipEntry>();
  for (const { entry, path } of items) {
    if (!path.startsWith(root)) continue;
    const relative = path.slice(root.length);
    exact.set(relative, entry);
    if (!normalized.has(pathKey(relative))) normalized.set(pathKey(relative), entry);
  }
  return {
    book: book.entry,
    // 書いたとおりのパスを優先し、なければ表し方の違いをそろえて探す
    find: (path) => exact.get(path) ?? normalized.get(pathKey(path)),
  };
}

/** 一覧(attachments)に載っている証憑を ZIP から取り出す。欠けている・壊れているものは数える */
async function filesFromZip(
  attachments: BackupAttachment[],
  archive: BackupArchive,
): Promise<{ files: StoredFile[]; broken: number }> {
  const files: StoredFile[] = [];
  let broken = 0;
  for (const a of attachments) {
    const entry = archive.find(a.path);
    let blob: Blob | null = null;
    if (entry && entry.size <= MAX_FILE_SIZE) {
      try {
        const candidate = await entry.blob(a.type);
        if (candidate.size === entry.size && (await blobCrc32(candidate)) === entry.crc) blob = candidate;
      } catch {
        // 読めないものは壊れている扱い
      }
    }
    if (!blob) {
      broken++;
      continue;
    }
    files.push({
      id: a.id,
      txId: a.txId,
      name: a.name,
      type: a.type,
      size: blob.size,
      createdAt: a.createdAt,
      blob,
    });
  }
  return { files, broken };
}

async function load(parsed: ParsedBackup, archive: BackupArchive | null): Promise<LoadedBackup> {
  const base = { data: parsed.data, newer: parsed.newer, broken: 0, missing: 0 };
  if (parsed.attachments !== null) {
    if (archive) return { ...base, ...(await filesFromZip(parsed.attachments, archive)) };
    // JSON 単体: 証憑なしのバックアップならそのとおり置き換える。
    // 証憑の記録があるのに中身がない(ZIP から取り出した JSON)ときは、端末の証憑を消さない
    return parsed.attachments.length === 0
      ? { ...base, files: [] }
      : { ...base, files: null, missing: parsed.attachments.length };
  }
  if (parsed.embeddedFiles !== null) {
    // v7: JSON に base64 で埋め込まれた証憑
    const files: StoredFile[] = [];
    for (const f of parsed.embeddedFiles) {
      const stored = portableToStored(f);
      if (stored) files.push(stored);
    }
    return { ...base, files, broken: parsed.embeddedFiles.length - files.length };
  }
  // v6以前: 証憑を含まないバックアップ
  return { ...base, files: null };
}

/**
 * バックアップファイル(ZIP または JSON)を読み込む。拡張子ではなく中身で形式を判定する。
 * バックアップとして読めなければ null を返す
 */
export async function readBackupFile(file: Blob): Promise<LoadedBackup | null> {
  try {
    if (!(await isZip(file))) {
      const parsed = parseBackup(await file.text());
      return parsed ? await load(parsed, null) : null;
    }
    const archive = openBackupArchive(await openZip(file));
    if (!archive) return null;
    const bookBlob = await archive.book.blob();
    if ((await blobCrc32(bookBlob)) !== archive.book.crc) return null;
    const parsed = parseBackup(await bookBlob.text());
    return parsed ? await load(parsed, archive) : null;
  } catch {
    return null;
  }
}
