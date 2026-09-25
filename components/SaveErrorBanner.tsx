'use client';

import { useState } from 'react';
import { downloadText } from '@/lib/csv';
import { BROKEN_STORAGE_KEY, useStore } from '@/lib/store';

/**
 * データ保全の警告バナー(最終防衛ライン)。
 * - 保存失敗(容量超過など): このままでは変更が失われることを知らせる
 * - 読込失敗(保存データの破損): 原本は退避キーへ写してあることを知らせ、
 *   気づかないまま空のデータで上書きして進めてしまうのを防ぐ
 * - 申告済みロック: ロック中の年の帳簿が変わる変更を止めたことを知らせる
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
      {store.lockNotice && (
        <div
          role="alert"
          className="flex flex-wrap items-start gap-x-2 gap-y-1 border-b border-sky-300 bg-sky-50 px-4 py-2.5 text-sm text-sky-900"
        >
          <span className="font-medium">
            🔒{' '}
            {store.lockNotice.skipped
              ? `${store.lockNotice.years.join('・')}年分は申告済み(ロック中)のため、その年の取引${store.lockNotice.skipped}件は追加しませんでした。`
              : `申告済み(ロック中)の${store.lockNotice.years.join('・')}年分の帳簿の数字が変わるため、この変更は保存されませんでした。`}
          </span>
          {!store.lockNotice.skipped && (
            <span>
              按分割合を変えたいときは、家事按分設定で「適用開始年」を指定した新しい設定を追加すると過去の年は変わりません。
              修正申告などで直す場合は、帳簿・決算書ページでその年のロックを解除してください。
            </span>
          )}
          <button
            type="button"
            onClick={store.dismissLockNotice}
            aria-label="このお知らせを閉じる"
            className="ml-auto rounded px-1.5 text-sky-700 hover:bg-sky-100"
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
