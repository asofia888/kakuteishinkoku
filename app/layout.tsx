import type { Metadata } from 'next';
import React from 'react';
import SaveErrorBanner from '@/components/SaveErrorBanner';
import Sidebar from '@/components/Sidebar';
import { StoreProvider } from '@/lib/store';
import './globals.css';

export const metadata: Metadata = {
  title: '申告スナップ | 確定申告・帳簿管理',
  description:
    '個人事業主向けの確定申告(青色申告)帳簿管理アプリ。CSV取込・自動仕訳・家事按分・決算書集計。データは端末内(localStorage)にのみ保存されます。',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body>
        <StoreProvider>
          <SaveErrorBanner />
          <div className="flex min-h-screen flex-col md:flex-row">
            <Sidebar />
            <main className="min-w-0 flex-1 px-4 py-6 md:px-8 md:py-8">
              <div className="mx-auto max-w-6xl">{children}</div>
            </main>
          </div>
        </StoreProvider>
      </body>
    </html>
  );
}
