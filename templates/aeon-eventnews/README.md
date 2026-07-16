# AEON EVENTNEWS 用 Web Feed テンプレート サンプル

`wonder-screen-cms-server` の webfeed 機能 (`package_format = "dump_html"`) 向けに、
AM堺北花田 EVENTNEWS フィードの実データ (`実データDL` で取得した `AM_-EVENTNEWS-data.zip`) を元に作成した
サンプルテンプレート一式です。

## ディレクトリ構成

| ディレクトリ | 想定画面 |
|---|---|
| `landscape-1920x1080/` | 横型 (16:9) フルスクリーン 1画面1件のスライドショー |
| `portrait-1080x1920/` | 縦型 (9:16) フルスクリーン 1画面1件のスライドショー |
| `strip-1920x540/` | 層間 (横長・低高さ) バナー。1画面3件を並べて表示 |

各ディレクトリの中身がそのまま1つの Web Feed テンプレートに対応します:

```
index.html   ← エントリーポイント (固定ファイル名)
style.css    ← 固定ファイル名
template.js  ← 固定ファイル名。データ取得〜描画〜切替を自前実装
assets/tpl/  ← テンプレート固有の静的アセットを置く場合はこの配下(今回は未使用)
```

## アップロード方法

CMS の Web Feed テンプレート編集画面(ファイルツリー)で、各ディレクトリの
`index.html` / `style.css` / `template.js` をそれぞれアップロード(or 貼り付け保存)してください。
`assets/tpl/` 配下にバイナリを置く場合はアップロードAPI経由(1ファイルずつ、最大5MiB)になります。

`data.xml` / `template.json` / `assets-map.json` / `qr-map.json` はサーバー側が sync のたびに
生成するファイルなので、**このリポジトリには含めていません**し、アップロードしないでください
(アップロードしても sync 時にサーバー側の値で上書きされます)。

## template.js の実装方針

サーバー側でのプレースホルダー置換は行われないため、`template.js` が実行時に以下を自分で行います:

1. `template.json` (マッピング) と `assets-map.json` を fetch
2. `template.json.dataFile` (`data.xml`) を fetch し、`recordPath` (`//data/item`) で
   レコードを抽出 (XPath, `document.evaluate` を使用)
3. `template.json.recordFilters` があればそれに従い、無ければ
   `statusSignage === "1"` かつ `pubStart <= 現在時刻 <= pubEnd` という既定ルールで対象レコードを絞り込み
4. `role: "image"` のフィールド値を `assets-map.json` でローカルパスに解決して描画
5. `window.wonderFlow.getState/setState('last_shown_id')` で前回表示位置から再開

表示間隔・1画面あたりの件数は各 `template.js` 先頭の `CONFIG` 定数で調整できます。

## 既知の注意点

- **今回の実データの `template.json` には `role: "id"` のフィールドが設定されていません。**
  レジューム/重複排除には `eventId` を独自に使っています。マッピング画面で `id` ロールを
  設定した場合、サーバー側の QR/dedup 挙動とも一致するよう、必要なら `sourcePath` を合わせてください。
- **`recordFilters` も未設定でした。** 上記の既定ルール(statusSignage/pubStart/pubEnd)は
  AEON EVENTNEWS の慣例に基づく decoyフォールバックです。マッピング画面で `recordFilters` を
  設定すれば、そちらが優先されるようテンプレート側は作ってあります。
- **sync のたびに配信ZIP(Media)が新しいUUIDで再生成され、直前のMediaは削除されます。**
  番組(Program/Playlist)への配置は手動作業で、自動追従の仕組みは今のところありません。
  実運用に乗せる前に、一度 sync→配置→再sync のサイクルで番組側の表示が更新されるか
  実機/実データで確認してください。
- 各テンプレートは動作確認用に、CMSの実データDLと同じファイル一式(`data.xml`, `template.json`,
  `assets-map.json`, `assets/*`)をローカルに並べてブラウザで開けば単体プレビューできます
  (実際のCMSアップロードにはこれらのデータファイルは含めません)。
