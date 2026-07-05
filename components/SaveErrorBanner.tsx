'use client';

import { useState } from 'react';
import { downloadText } from '@/lib/csv';
import { BROKEN_STORAGE_KEY, useStore } from '@/lib/store';

/**
 * データ保全の警告バナー(最終防衛ライン)。
 * - 保存失敗(容量超過など): このままでは変更が失われることを知らせる
 * - 読込失敗(保存データの破損): 原本は退避キーへ写してあることを知らせ、
 *   気づかないまま空のデータで上書きして進めてしまうのを防ぐ
 */
export default function SaveErrorBanner() {
  const store = useStore();
  const [corruptDismissed, setCorruptDismissed] = useState(false);

  const downloadSalvaged = () => {
    try {
      const raw = localStorage.getItem(BROKEN_STORAGE_KEY);
      if (raw) downloadText('申告スナップ_退避データ.json', raw, 'application/json');
    } catch {
      // 読み出せない環境でもバナーは出し続ける
    }
  };

  return (
    <>
      {store.dataCorrupted && !corruptDismissed && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-amber-300 bg-amber-50 px-4 py-2.5 text-sm text-amber-900">
          <span className="font-medium">
            ⚠ 保存されていた帳簿データを読み取れなかったため、空の状態で起動しました。
          </span>
          <span>
            元のデータはブラウザ内に退避してあります(消えていません)。まず退避データを保存し、
            バックアップJSONをお持ちならダッシュボードの「データ管理」から復元してください。
          </span>
          <button
            type="button"
            onClick={downloadSalvaged}
            className="rounded border border-amber-400 bg-white px-2 py-0.5 text-xs font-medium hover:bg-amber-100"
          >
            退避データをダウンロード
          </button>
          <button
            type="button"
            onClick={() => setCorruptDismissed(true)}
            aria-label="この警告を閉じる"
            className="ml-auto rounded px-1.5 text-amber-700 hover:bg-amber-100"
          >
            ✕
          </button>
        </div>
      )}
      {store.saveError && (
        <div className="border-b border-rose-300 bg-rose-50 px-4 py-2.5 text-sm font-medium text-rose-800">
          ⚠ データの保存に失敗しました(ブラウザのストレージ容量不足の可能性があります)。
          このままでは変更が失われます。ダッシュボードの「バックアップをダウンロード」で今すぐデータを保全してください。
        </div>
      )}
    </>
  );
}
