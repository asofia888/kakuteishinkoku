'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const NAV = [
  { href: '/', label: 'ダッシュボード', icon: '📊' },
  { href: '/transactions', label: '取引一覧(CSV読込)', icon: '📒' },
  { href: '/invoices', label: '請求書発行', icon: '📄' },
  { href: '/books', label: '帳簿・決算書(複式簿記)', icon: '📚' },
  { href: '/assets', label: '固定資産台帳(減価償却)', icon: '🗄' },
  { href: '/tax', label: '消費税(インボイス)', icon: '🧾' },
  { href: '/simulation', label: '所得税シミュレーション', icon: '🧮' },
  { href: '/rules', label: '自動仕訳ルール設定', icon: '🤖' },
  { href: '/anbun', label: '家事按分設定', icon: '🏠' },
];

export default function Sidebar() {
  // trailingSlash:true の静的エクスポートでは '/transactions/' が返るため正規化する
  const pathname = (usePathname() ?? '/').replace(/\/+$/, '') || '/';

  return (
    <aside className="shrink-0 border-b border-slate-200 bg-white md:min-h-screen md:w-64 md:border-r md:border-b-0">
      <div className="flex items-center gap-2 px-5 py-4 md:py-6">
        <span className="text-2xl">📋</span>
        <div>
          <div className="text-lg leading-tight font-bold text-slate-900">申告スナップ</div>
          <div className="text-xs text-slate-500">青色申告 帳簿管理</div>
        </div>
      </div>
      <nav className="flex gap-1 overflow-x-auto px-3 pb-3 md:flex-col md:pb-0">
        {NAV.map((item) => {
          const active = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors ${
                active
                  ? 'bg-blue-600 text-white'
                  : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
              }`}
            >
              <span aria-hidden>{item.icon}</span>
              {item.label}
            </Link>
          );
        })}
      </nav>
      <div className="hidden px-5 py-6 text-xs leading-relaxed text-slate-400 md:block">
        データはこの端末のブラウザ内
        (localStorage)にのみ保存され、外部には送信されません。
      </div>
    </aside>
  );
}
