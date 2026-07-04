import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // 全データはlocalStorage管理のため、静的サイトとして出力できる
  output: 'export',
  // 静的ホスティングで /transactions などの直リンクを動かすためディレクトリ出力にする
  trailingSlash: true,
};

export default nextConfig;
