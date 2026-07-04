/** 12,345 → 「12,345」 */
export function num(n: number): string {
  return n.toLocaleString('ja-JP');
}

/** 12,345 → 「¥12,345」 */
export function yen(n: number): string {
  return `¥${n.toLocaleString('ja-JP')}`;
}

/** 'YYYY-MM-DD' → 'YYYY/MM/DD' */
export function dateLabel(date: string): string {
  return date.replaceAll('-', '/');
}

/** 今日の日付を YYYY-MM-DD で返す */
export function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}
