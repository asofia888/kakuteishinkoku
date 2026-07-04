'use client';

import { useStore } from '@/lib/store';

/**
 * localStorage への保存が失敗している間、画面上部に警告を出す。
 * 帳簿データが静かに失われるのを防ぐための最終防衛ライン。
 */
export default function SaveErrorBanner() {
  const store = useStore();
  if (!store.saveError) return null;
  return (
    <div className="border-b border-rose-300 bg-rose-50 px-4 py-2.5 text-sm font-medium text-rose-800">
      ⚠ データの保存に失敗しました(ブラウザのストレージ容量不足の可能性があります)。
      このままでは変更が失われます。ダッシュボードの「バックアップをダウンロード」で今すぐデータを保全してください。
    </div>
  );
}
