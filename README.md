# Run Form Lab

横から撮ったランニング動画と Garmin の FIT データから、ブラウザ内でフォームを数値化し、AI（Gemini / Claude / OpenAI）が改善点を解説する Web アプリです。動画は端末の外に出ません。

設計の詳細は [DESIGN.md](DESIGN.md) を参照してください。

## 使い方

1. （任意）Garmin Connect でアクティビティを開き「オリジナルをエクスポート」→ .zip または .fit を選択
2. 真横から全身が入るように固定して撮影した動画（5〜20 秒、できれば 60fps）を選択
3. 解析区間・身長を入れて「フォームを解析」
4. 右上の「設定」で AI と API キーを設定し「AI に解説してもらう」

## ローカルで動かす

ES Modules を使うため、ファイルを直接開くのではなくローカルサーバー経由で開きます。

```bash
npx serve .        # または python3 -m http.server 8080
```

## 公開（Cloudflare Pages の例）

1. このフォルダを GitHub リポジトリに push
2. Cloudflare Pages で新規プロジェクト → リポジトリを選択（ビルドコマンドなし、出力ディレクトリ `/`）
3. 実機で動作確認後、`_headers.example` を `_headers` にリネームしてセキュリティヘッダを有効化

GitHub Pages でもそのまま動きます（`_headers` は Cloudflare 専用）。

## 骨格モデルを自前で配信する（任意）

`models/pose_landmarker_full.task`（lite / heavy も同様）を置くと、Google の配布元より優先して読み込みます。モデルは MediaPipe の Pose Landmarker（Apache-2.0）です。

## 構成

| ファイル | 役割 |
|---|---|
| `js/main.js` | 画面制御、FIT と動画の同期、キーフレーム生成 |
| `js/fit.js` | FIT/ZIP 読み込み（Garmin FIT SDK）と区間集計 |
| `js/pose.js` | MediaPipe Pose による骨格推定 |
| `js/metrics.js` | 接地検出とフォーム指標の計算（純粋関数） |
| `js/ai.js` | プロンプトと各社 API の呼び出し |

## 注意

- AI の既定モデル名（`gemini-flash-latest` など）は各社の変更で使えなくなることがあります。設定画面の「一覧を取得」で選び直してください。
- 解析結果は 2D 動画からの推定であり、医学的な診断ではありません。
