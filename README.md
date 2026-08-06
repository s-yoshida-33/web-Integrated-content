# web-Integrated-content

AEON MALL向け、`wonder-screen-cms-server` の webfeed 機能
(`package_format = "dump_html"`) 用サイネージテンプレート一式です。

**EVENT NEWS** (イベントニュース) と **SHOP NEWS** (ショップニュース) の2コンテンツ種別を、それぞれ縦型・横型・層間の3レイアウトで提供します。

## ディレクトリ構成

```
templates/
  aeon-eventnews/
    responsive/        縦型 (1080x1920) / 横型 (1920x1080) 自動切替フルスクリーン
    strip-1920x540/    層間 (横長・低高さ) バナー
  aeon-shopnews/
    responsive/        縦型 (1080x1920) / 横型 (1920x1080) 自動切替フルスクリーン
    strip-1920x540/    層間 (横長・低高さ) バナー
```

各ディレクトリの中身がそのまま1つの Web Feed テンプレートに対応し、いずれも以下の構成です:

```
index.html   ← エントリーポイント (固定ファイル名)
style.css    ← 固定ファイル名
template.js  ← 固定ファイル名。データ取得〜描画〜切替を自前実装
assets/tpl/  ← ロゴ・アイコン・フォント等、テンプレート固有の静的アセット
```

4テンプレートとも `template.js` の処理フロー・テキスト省略ロジック・CMS回避策は共通で、コンテナの寸法・配置・参照フィールドがコンテンツ種別・レイアウトごとに異なります。

### 縦型・横型の自動切替 (`responsive/`)

`responsive/index.html` の `<head>` 内スクリプトが `window.innerWidth`/`innerHeight` のアスペクト比で縦型・横型を判定し、`<html>` 要素に `layout-portrait` / `layout-landscape` クラスを付与する。

`style.css` 側は各コンテナの座標・サイズをこのクラスでスコープして出し分ける (縦型専用の `container-side` と横型専用の `container-eventlabel` は非アクティブ側を `display:none` にする)。

DOM・アセットは縦横で共通のため、1つの Web Feed テンプレートを両方の解像度のゾーンに配置。

**層間 (`strip-1920x540/`) は対象外。**

配信ソフト上の解像度が横型と同じ 1920x1080 になり (LEDコントローラが上半分 1920x540 のみを実際の表示に使う)、画面サイズだけでは横型と層間を区別できないため、現状は専用ディレクトリのまま個別運用する。

CMS側で層間ゾーンを判別できる手段 (配置URLへのクエリパラメータ付与など) が確認でき次第、`responsive/` に統合する。

## アップロード方法

CMS の Web Feed テンプレート編集画面 (ファイルツリー) で、各ディレクトリの
`index.html` / `style.css` / `template.js` をそれぞれアップロード (or 貼り付け保存) してください。

`assets/tpl/` 配下のバイナリ (SVG・フォント) はアップロードAPI経由 (1ファイルずつ) になります。

`data.xml` / `template.json` / `assets-map.json` / `qr-map.json` はサーバー側が sync のたびに生成するファイルなので、**このリポジトリには含めていません**し、アップロードしないでください
(アップロードしても sync 時にサーバー側の値で上書きされます)。

※ `.gitignore` 参照

## template.js の処理フロー (共通)

サーバー側でのプレースホルダー置換は行われないため、`template.js` が実行時に以下を自前で行います (関数名は4テンプレートとも共通)。

1. **`loadBundle()`** — `template.json` / `assets-map.json` / `qr-map.json` / `data.xml` (または
   `template.json.dataFile` で指定されたファイル) を fetch。`fetch` が失敗する環境 (`file://` 等) では `loadViaXHR()` にフォールバックする。
2. **`buildRecords()`** — `template.json.recordPath` (既定 `//data/item`) でレコードを抽出。`.xml` なら XPath (`document.evaluate`)、それ以外は JSON パスとして解釈する汎用実装。
3. **`isRecordActive()`** — `template.json.recordFilters` があればそれに従って評価。無い場合の既定ルールは
   **`statusWeb === "1"` のみ** (WEB連携コンテンツである以上、WEB非掲載の記事をサイネージ側だけ表示するのは実態に合わないため)。
4. **`renderRecord()`** — 各コンテナの描画関数をまとめて呼び出し、1レコード分を反映する。
5. **`startSlideshow()`** — 有効レコードを **`updateDate`が新しい順(同日の場合はIDの昇順)** に並べ替えたうえで、`CONFIG.slideDurationMs` (既定15秒) ごとに `renderRecord` を呼んでローテーション表示する。`window.wonderFlow.getState/setState('last_shown_id')` に前回表示したIDを保存し、再生再開時にその続きから表示する。

`loadAndRender()` はこの一連の処理を実行し、失敗時は `CONFIG.dataLoadMaxRetries` 回まで
`dataLoadRetryDelayMs` 間隔でリトライする (sync直後のファイル再展開中の読み込み失敗に対応するため)。

### テキストの省略処理

- タイトル・本文は **文字数ベース** (`wrapByCharCount`)。末尾を半角カナの中黒3つ「･･･」に置き換える。
- フッターの1行テキスト (日付・時間・場所 / ショップ名・日付・階数) は **実測描画幅ベース**
  (`setTextTruncatedToWidth`)。全角・半角が混在し文字数だけでは幅を判定できないため、
  `Range.getBoundingClientRect()` で実際の描画幅を測りながら2分探索で切り詰める。
- 各行はデータが空の場合、行 (アイコン+テキスト) ごと非表示にする (`setRowVisible`)。

### WEB QR

QRコード画像自体はテンプレート側では生成しない。

CMSが sync のたびに `qr-map.json`
(ID → QR画像パスのマップ) を生成するため、`renderQr()` はそれを ID で引くだけでよい。

`statusWeb === "1"` かつ該当QRが解決できた場合のみ、QR画像と「詳しくはWEBで」ラベルを表示し、それ以外は両方非表示にする。

---

## EVENT NEWS (イベントニュース)

`templates/aeon-eventnews/`

1画面1件のスライドショー。

### 使用フィールド (`data.xml` / `template.json`)

| フィールド | role | 用途 |
|---|---|---|
| `eventId` | id | レジューム/スライドショーの記事識別、QR (`qr-map.json`) の参照キー |
| `statusWeb` | filter | 有効レコード判定 (`"1"`のみ表示) |
| `updateDate` | filter | スライドショーの並び順(新しい順)判定に使用 |
| `photo1ThumbW1080` | image | メイン画像 |
| `subTitle` | text | タイトル |
| `bodyShort` | text | 本文 |
| `dateStart` / `dateEnd` | text | 開催期間 (フッター日付行、`dateStart～dateEnd`で連結) |
| `time` | text | 開催時間(フッター時間行) |
| `venues` | text | 開催場所 (フッター場所行、空の場合は `place` にフォールバック) |
| `place` | text | `venues` が空の場合のみ使用 |

`template.json.urlTemplates.qr.template` (`https://.../event/{eventId}`) はCMSが生成するが、テンプレート側では使用しない (`qr-map.json` を直接参照するため)。

### コンテナ構成・表示内容

| コンテナ | 内容 | 参照フィールド |
|---|---|---|
| header | AEON MALLロゴ + 現在時刻 (クライアント側 `setInterval` で毎秒更新) | なし (静的アセット + `Date`) |
| image | メイン画像。背景色 `#FFF4E1` | `photo1ThumbW1080` |
| side / eventlabel | 「EVENT NEWS」ラベル (SVGアウトライン文字、背景 `#FFCB5B`、縦型は側面に縦書き回転、横型・層間は横書き) | なし (固定テキスト) |
| body | タイトル (1行15文字×最大2行) + 本文 (1行25文字×最大5行) | `subTitle` / `bodyShort` |
| footer | インフォエリア (枠線 `#FF7700`) に日付・時間・場所の3行 + 右下にWEB QR | `dateStart`/`dateEnd` / `time` / `venues` (`place`) / `eventId` |

コンテナの正確な座標・寸法は各レイアウトの `style.css` の `.container-*` を参照してください。

---

## SHOP NEWS (ショップニュース)

`templates/aeon-shopnews/`

コンテナ構成・データ参照ロジックはEVENT NEWSと共通化しつつ、フッターのインフォエリアの表示内容をショップ向けに変更している。

### 使用フィールド (`data.xml` / `template.json`)

| フィールド | role | 用途 |
|---|---|---|
| `shopNewsId` | id | レジューム/スライドショーの記事識別、QR (`qr-map.json`) の参照キー |
| `shopId` | text | ショップ自体の識別子 (`template.json.urlTemplates.qr.template` で使われるが、テンプレート側は `qr-map.json` を `shopNewsId` で引くため未使用) |
| `statusWeb` | filter | 有効レコード判定 (`"1"` のみ表示) |
| `updateDate` | filter | スライドショーの並び順(新しい順)判定に使用 |
| `photo1ThumbW1080` | image | メイン画像 |
| `shopLogo` | image | ショップロゴ画像 (フッターインフォエリア) |
| `shopName` | text | ショップ名 (フッター1行目) |
| `subTitle` | text | タイトル |
| `bodyShort` | text | 本文 |
| `dateStart` / `dateEnd` | filter | 開催期間 (フッター2行目、`dateStart～dateEnd` で連結、role は filter だが `recordFilters` 未設定時は使われず、表示用途のみ) |
| `shopFloorName` / `shopFloorsName` | text | 階数 (フッター3行目、 `shopFloorsName` を優先し、空の場合は `shopFloorName` にフォールバック) |

### コンテナ構成・表示内容

| コンテナ | 内容 | 参照フィールド |
|---|---|---|
| header | AEON MALLロゴ + 現在時刻 | なし (EVENT NEWSと共通) |
| image | メイン画像 (背景色 `#FFEAF9`) | `photo1ThumbW1080` |
| side / eventlabel | 「SHOP NEWS」ラベル (背景 `#FD99E3`、アウトライン `#FF006F`) | なし (固定テキスト) |
| body | タイトル + 本文 (EVENT NEWSと同仕様) | `subTitle` / `bodyShort` |
| footer | インフォエリア (枠線 `#FF006F`) にショップロゴ + テキスト3行 (ショップ名/日付/階数) + 右下にWEB QR | `shopLogo` / `shopName` / `dateStart`・`dateEnd` / `shopFloorsName` (`shopFloorName`) / `shopNewsId` |

### ショップロゴの配置 (レイアウトごとの違い)

- **縦型・横型**: ロゴ (150x150) をインフォエリア左上に固定配置。ロゴがある場合、テキスト3行はロゴの右側 (x:190) に幅530pxで配置。
  `shopLogo` が空の場合はロゴを非表示にし、テキストエリアをロゴ領域まで拡張 (x:20、幅700px) する。
- **層間**: テキストエリアの縦幅に対してロゴを縦に並べると余白が少ないため、ロゴ(147x147)はインフォエリアの**左下に固定配置**
  (`position:absolute; left:20px; bottom:20px;`)。テキスト行数が1〜3行のいずれでも位置は変わらない。3行すべて表示される最大時でもテキストエリア下端とロゴ上端の間に5pxの余白が残り、重ならないことを実測済み。

---

## 配色一覧

| 用途 | EVENT NEWS | SHOP NEWS |
|---|---|---|
| ラベル背景 (side/eventlabel) | `#FFCB5B` | `#FD99E3` |
| ラベル文字アウトライン・フッター枠線/QR枠線/QRラベル文字 | `#FF7700` | `#FF006F` |
| imageコンテナ背景 | `#FFF4E1` | `#FFEAF9` |

## 既知のCMS仕様・回避策

- **`assets/tpl/` 配下の静的アセット (SVG) は `<img src>` で参照しない。**
  CMSのアセット配信APIがレスポンスに `Content-Type` を付けないことがあり、その場合ブラウザが画像として認識できず壊れたアイコン表示になる。回避策として、SVGは
  `fetch` でテキスト取得し `innerHTML` に注入するインラインSVG方式 (`loadInlineSvgs()`, `.inline-svg[data-src]`) を採用している。
- **`index.html` / `template.js` に `http://` / `https://` の文字列が含まれると、実際に外部通信していなくても「外部URLを参照している」とCMSのバリデーションに弾かれる。** インラインSVGの
  `xmlns="http://www.w3.org/2000/svg"` 属性はHTML5パーサーが自動付与するため、`index.html` 側では明示的に書かない。
- **フォント等バイナリのアップロードはサブフォルダ構成やファイル名中のカンマを保持しない
  (フラット化・カンマがURLエンコードされる)。** そのため `assets/tpl/` 直下にサブフォルダ無し・カンマ無しのファイル名
  (`Inter-Variable.ttf`) を置いている。
- **`template.json.fields` に `statusSignage` / `pubStart` / `pubEnd` が含まれない構成が存在する。** 有効レコードの既定判定は
  `statusWeb === "1"` のみとしている。`template.json.recordFilters` が設定されていれば、そちらが優先されるようテンプレート側は作ってある。
- **sync のたびに配信ZIP (Media) が新しいUUIDで再生成され、直前のMediaは削除される。**
  番組 (Program/Playlist) への配置は手動作業で、自動追従の仕組みは無い。実運用前に、一度
  sync→配置→再sync のサイクルで番組側の表示が更新されるか実機/実データで確認すること。

## ローカルでの動作確認方法

各テンプレートのディレクトリでCMSの実データDLと同じファイル一式
(`data.xml`, `template.json`, `assets-map.json`, `qr-map.json`, `assets/*`) を並べ、簡易HTTPサーバー
(例: `python -m http.server`) 経由でブラウザから開けば単体プレビューできる
(`file://` でも `loadViaXHR` フォールバックにより動作するが、CORSの制約が少ないHTTP経由を推奨)。

これらのデータファイルは `.gitignore` によりリポジトリには含まれない。

表示間隔 (`slideDurationMs`) や画像フィールド名 (`imageField`) は、各 `template.js` 先頭の
`CONFIG` 定数で調整できる。
