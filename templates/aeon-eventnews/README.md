# AEON EVENTNEWS 用 Web Feed テンプレート

`wonder-screen-cms-server` の webfeed 機能 (`package_format = "dump_html"`) 向けに、
AM堺北花田 EVENTNEWS フィードを表示するための本番テンプレート一式です。
縦型・横型・層間の3レイアウトとも、情報設計とデータ参照ロジックは共通で、
コンテナの寸法・配置のみがレイアウトごとに異なります。

## ディレクトリ構成

| ディレクトリ | 想定画面 | 表示件数 |
|---|---|---|
| `portrait-1080x1920/` | 縦型 (9:16) フルスクリーン | 1画面1件のスライドショー |
| `landscape-1920x1080/` | 横型 (16:9) フルスクリーン | 1画面1件のスライドショー |
| `strip-1920x540/` | 層間 (横長・低高さ) バナー | 1画面1件のスライドショー |

各ディレクトリの中身がそのまま1つの Web Feed テンプレートに対応します:

```
index.html   ← エントリーポイント (固定ファイル名)
style.css    ← 固定ファイル名
template.js  ← 固定ファイル名。データ取得〜描画〜切替を自前実装
assets/tpl/  ← ロゴ・アイコン・フォント等、テンプレート固有の静的アセット
```

## アップロード方法

CMS の Web Feed テンプレート編集画面(ファイルツリー)で、各ディレクトリの
`index.html` / `style.css` / `template.js` をそれぞれアップロード(or 貼り付け保存)してください。
`assets/tpl/` 配下のバイナリ(SVG・フォント)はアップロードAPI経由(1ファイルずつ)になります。

`data.xml` / `template.json` / `assets-map.json` / `qr-map.json` はサーバー側が sync のたびに
生成するファイルなので、**このリポジトリには含めていません**し、アップロードしないでください
(アップロードしても sync 時にサーバー側の値で上書きされます。`.gitignore` 参照)。

## コンテナ構成(共通の情報設計)

| コンテナ | 内容 | 参照フィールド |
|---|---|---|
| header | ロゴ + 現在時刻(クライアント側 `setInterval` で毎秒更新) | なし(静的アセット + `Date`) |
| image | メイン画像 | `photo1ThumbW1080` |
| eventlabel | 「EVENT NEWS」ラベル(SVGアウトライン文字) | なし(固定テキスト) |
| body | タイトル + 本文 | `subTitle` / `bodyShort` |
| footer | 日付・時間・場所 + WEB QR | `dateStart`/`dateEnd` / `time` / `venues`(空なら`place`) / `eventId` |

レイアウトごとのコンテナ座標・寸法は各 `style.css` の `.container-*` を参照してください。

## template.js の処理フロー

サーバー側でのプレースホルダー置換は行われないため、`template.js` が実行時に以下を自前で行います
(関数名は3レイアウトとも共通)。

1. **`loadBundle()`** — `template.json` / `assets-map.json` / `qr-map.json` / `data.xml`(または
   `template.json.dataFile` で指定されたファイル)を fetch。`fetch` が失敗する環境
   (`file://` 等)では `loadViaXHR()` にフォールバックする。
2. **`buildRecords()`** — `template.json.recordPath`(既定 `//data/item`)でレコードを抽出。
   `.xml` なら XPath (`document.evaluate`)、それ以外は JSON パスとして解釈する汎用実装。
3. **`isRecordActive()`** — `template.json.recordFilters` があればそれに従って評価。
   無い場合の既定ルールは **`statusWeb === "1"` のみ**(後述)。
4. **`renderRecord()`** — `renderImage` / `renderTitle` / `renderBody` / `renderFooter` / `renderQr`
   をまとめて呼び出し、1レコード分をコンテナに反映する。
5. **`startSlideshow()`** — 有効レコードを **記事IDの降順** に並べ替えたうえで、
   `CONFIG.slideDurationMs`(既定15秒)ごとに `renderRecord` を呼んでローテーション表示する。
   `window.wonderFlow.getState/setState('last_shown_id')` に前回表示した `eventId` を保存し、
   再生再開時にその続きから表示する。

`loadAndRender()` はこの一連の処理を実行し、失敗時は `CONFIG.dataLoadMaxRetries` 回まで
`dataLoadRetryDelayMs` 間隔でリトライする(sync直後のファイル再展開中の読み込み失敗に対応するため)。

### テキストの省略処理

- タイトル(`subTitle`)・本文(`bodyShort`)は **文字数ベース**(`wrapByCharCount`)。
  タイトルは1行15文字×最大2行、本文は1行25文字×最大5行を超えた場合、
  末尾を半角カナの中黒3つ「･･･」に置き換える。
- フッターの日付・時間・場所は **実測描画幅ベース**(`setTextTruncatedToWidth`)。
  全角・半角が混在し文字数だけでは幅を判定できないため、`Range.getBoundingClientRect()`
  で実際の描画幅を測りながら2分探索で切り詰める。テキストエリア幅からアイコン幅(32px)と
  gap(20px)を引いた値が上限になる(例: 層間はテキストエリア580pxのため上限528px)。
- 日付・時間・場所はいずれもデータが空の場合、行(アイコン+テキスト)ごと非表示にする
  (`setRowVisible`)。`venues` が空の場合のみ `place` にフォールバックする。

### WEB QR

QRコード画像自体はテンプレート側では生成しない。CMSが sync のたびに `qr-map.json`
(`eventId` → QR画像パスのマップ)を生成するため、`renderQr()` はそれを `eventId` で
引くだけでよい。`statusWeb === "1"` かつ該当QRが解決できた場合のみ、QR画像と
「詳しくはWEBで」ラベルを表示し、それ以外は両方非表示にする。

## 既知のCMS仕様・回避策

- **`assets/tpl/` 配下の静的アセット(SVG)は `<img src>` で参照しない。**
  CMSのアセット配信APIがレスポンスに `Content-Type` を付けないことがあり、その場合
  ブラウザが画像として認識できず壊れたアイコン表示になる。回避策として、SVGは
  `fetch` でテキスト取得し `innerHTML` に注入するインラインSVG方式(`loadInlineSvgs()`,
  `.inline-svg[data-src]`)を採用している。
- **`index.html` / `template.js` に `http://` / `https://` の文字列が含まれると、
  実際に外部通信していなくても「外部URLを参照している」とCMSのバリデーションに
  弾かれる。** インラインSVGの `xmlns="http://www.w3.org/2000/svg"` 属性はHTML5パーサーが
  自動付与するため、`index.html` 側では明示的に書かない。
- **フォント等バイナリのアップロードはサブフォルダ構成やファイル名中のカンマを保持しない
  (フラット化・カンマがURLエンコードされる)。** そのため `assets/tpl/` 直下に
  サブフォルダ無し・カンマ無しのファイル名(`Inter-Variable.ttf`)を置いている。
- **`template.json.fields` に `statusSignage` / `pubStart` / `pubEnd` が含まれない
  構成が存在する。** 有効レコードの既定判定は `statusWeb === "1"` のみとしている
  (WEB連携コンテンツである以上、WEB非掲載の記事をサイネージ側だけ表示するのは
  実態に合わないため)。`template.json.recordFilters` が設定されていれば、
  そちらが優先されるようテンプレート側は作ってある。
- **sync のたびに配信ZIP(Media)が新しいUUIDで再生成され、直前のMediaは削除される。**
  番組(Program/Playlist)への配置は手動作業で、自動追従の仕組みは無い。
  実運用前に、一度 sync→配置→再sync のサイクルで番組側の表示が更新されるか
  実機/実データで確認すること。

## ローカルでの動作確認方法

各テンプレートのディレクトリでCMSの実データDLと同じファイル一式
(`data.xml`, `template.json`, `assets-map.json`, `qr-map.json`)を並べ、
簡易HTTPサーバー(例: `python -m http.server`)経由でブラウザから開けば単体プレビューできる
(`file://` でも `loadViaXHR` フォールバックにより動作するが、CORSの制約が少ないHTTP経由を推奨)。
これらのデータファイルは `.gitignore` によりリポジトリには含まれない。

表示間隔(`slideDurationMs`)や画像フィールド名(`imageField`)は、各 `template.js` 先頭の
`CONFIG` 定数で調整できる。
