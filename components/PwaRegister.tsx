'use client';

import { useEffect } from 'react';

/** Service Worker を登録してPWA(オフライン動作・ホーム画面追加)を有効にする */
export default function PwaRegister() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const base = process.env.NEXT_PUBLIC_BASE_PATH ?? '';
    navigator.serviceWorker
      .register(`${base}/sw.js`, { scope: `${base}/` })
      .catch(() => {
        // 登録失敗(未対応ブラウザ・file://等)はオンライン動作に影響しないため無視
      });
  }, []);
  return null;
}
