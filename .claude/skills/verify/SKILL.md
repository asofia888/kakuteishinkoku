---
name: verify
description: 申告スナップ(Next.js静的エクスポート)の変更をローカルの実ブラウザで動作確認する手順。ビルド→配信→Playwright直叩き。
---

# 申告スナップの動作確認手順

## ビルドと配信

```bash
npx next build                      # out/ に静的エクスポート(sw.js等 public/ の変更もここで反映)
node scripts/serve-out.mjs          # http://127.0.0.1:4173 で配信(バックグラウンド起動)
```

サブパス構成(GitHub Pages 再現)を試すときは、ビルドと配信の両方に
`NEXT_PUBLIC_BASE_PATH=/kakuteishinkoku` を付ける。

## Chromium の起動(WSL の欠損ライブラリ対策)

この WSL には libnss3 等がなく、素の `npx playwright test` は起動に失敗する(sudo も使えない)。
root 権限なしの回避策: 必要な .deb を展開して LD_LIBRARY_PATH で補う。

```bash
mkdir -p "$SCRATCHPAD/libs" && cd "$SCRATCHPAD/libs"
apt-get download libnspr4 libnss3 libasound2t64
for f in *.deb; do dpkg -x "$f" extracted/; done
```

## 検証スクリプトの実行

Playwright を直接 require するドライバ(.js)を scratchpad に書き、次のように実行する:

```bash
NODE_PATH="<repo>/node_modules" \
LD_LIBRARY_PATH="$SCRATCHPAD/libs/extracted/usr/lib/x86_64-linux-gnu:$SCRATCHPAD/libs/extracted/usr/lib/x86_64-linux-gnu/nss" \
node "$SCRATCHPAD/verify-driver.js"
```

- `const { chromium } = require('@playwright/test')` で起動できる(NODE_PATH 必須。スクリプトが repo 外にあるため)
- 既存の E2E 一式(`npx playwright test`)も同じ LD_LIBRARY_PATH で通る

## e-Tax(.xtx)の公式スキーマ検証

lib/etax.ts の出力は国税庁公式XSDで検証できる(lib/etax.test.ts の条件付きテスト)。

```bash
# 仕様書の取得(公開CAB。09=XML構造設計書等【所得税】・19=XMLスキーマ)
curl -sLO https://www.e-tax.nta.go.jp/shiyo/download/e-tax19.CAB
# cabextract も dpkg -x で展開して使う(apt-get download cabextract libmspack0t64)
cabextract -e SJIS -d xsd e-tax19.CAB
# 展開後のファイル名は「19XMLスキーマ¥shotoku¥KOA210-011.xsd」のような ¥ 区切りの
# フラット名になるため、¥ をディレクトリ区切りに変換してツリーを再構築してから使う
ETAX_XSD_DIR=<ツリーのルート> ETAX_XMLLINT=<xmllintのパス> npx vitest run lib/etax.test.ts
```

- 検証対象スキーマ: `shotoku/RKO0010-250.xsd`(手続v25.0.0)。年分仕様の改定時は
  lib/etax.ts の ETAX_VERSIONS を上げて再検証する
- 文字項目には maxLength がある(資産名16字・償却方法10字・摘要15字など)。
  超過は builder 側で切り詰めている

## 駆動時の注意

- 削除・データ置換・サンプル読込は `confirm()` を挟む → `page.on('dialog', d => d.accept())` か `page.once('dialog', ...)` で処理
- 日本語テキスト照合は全角/半角括弧の取り違えに注意(正規表現で括弧非依存のパターンにする)
- データ投入の最短経路: ダッシュボードの「サンプルデータを読み込む」ボタン(空状態なら confirm なし)
- バックアップ復元はダッシュボードの hidden input `input[aria-label="バックアップファイルを選択"]` に `setInputFiles` で直接渡せる
- 取引一覧の金額列は 4 列目(`tr.children[3]`)、`¥85,000` 形式
