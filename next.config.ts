import type { NextConfig } from 'next';

// GitHub Pages などサブパス配信用(例: /kakuteishinkoku)。未設定ならルート配信
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

const nextConfig: NextConfig = {
  // 全データはlocalStorage管理のため、静的サイトとして出力できる
  output: 'export',
  // 静的ホスティングで /transactions などの直リンクを動かすためディレクトリ出力にする
  trailingSlash: true,
  ...(basePath ? { basePath } : {}),
};

export default nextConfig;
