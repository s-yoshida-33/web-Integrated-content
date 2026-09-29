(function () {
  'use strict';

  var CONFIG = {
    imageField: 'photo1ThumbW1080',
    // 仕様書通り1記事15秒
    slideDurationMs: 15000,
    // 再生ローテーションのタイミングでファイルが再展開中(書き込み途中)のことがあるため、
    // 読み込み・パース失敗時は少し待ってリトライする
    dataLoadMaxRetries: 5,
    dataLoadRetryDelayMs: 600,
    // Gido本体からの{type:'gido:activate'}を待つが、Gido外(スタンドアロン確認等)では
    // 届かないため、これだけ待っても届かなければ自動的にスライドショーを開始する
    activateFallbackMs: 1500
  };

  function stripText(el) {
    return el ? (el.textContent || '').trim() : '';
  }

  // file:// で開かれる再生環境では fetch() が "Failed to fetch" で必ず失敗するため、
  // XMLHttpRequest にフォールバックする(file://では成功時も status が 0 になる点に注意)。
  function loadViaXHR(path) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.onreadystatechange = function () {
        if (xhr.readyState !== 4) return;
        if (xhr.status === 0 || (xhr.status >= 200 && xhr.status < 300)) {
          resolve(xhr.responseText);
        } else {
          reject(new Error('failed to load ' + path + ': status ' + xhr.status));
        }
      };
      xhr.onerror = function () { reject(new Error('failed to load ' + path + ' (network error)')); };
      try {
        xhr.open('GET', path, true);
        // file:// では charset 判定が既定でUTF-8にならず、CDATA内の日本語が化けて
        // XMLとして不正になることがあるため、明示的にUTF-8として読ませる。
        xhr.overrideMimeType('text/plain; charset=utf-8');
        xhr.send(null);
      } catch (e) {
        reject(e);
      }
    });
  }

  function fetchText(path) {
    return fetch(path, { cache: 'no-store' })
      .then(function (res) {
        if (!res.ok) throw new Error('failed to fetch ' + path + ': ' + res.status);
        return res.text();
      })
      .catch(function () { return loadViaXHR(path); });
  }

  function fetchJson(path) {
    return fetchText(path)
      .then(function (text) { return JSON.parse(text); })
      .catch(function () { return null; });
  }

  function evaluateXPath(doc, xpath) {
    var result = doc.evaluate(xpath, doc, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
    var nodes = [];
    for (var i = 0; i < result.snapshotLength; i++) nodes.push(result.snapshotItem(i));
    return nodes;
  }

  // 同名タグの入れ子(<item type="date">内の<dateStart>等)を拾わないよう直下の子要素だけを見る
  function directChildText(recordEl, tagName) {
    for (var i = 0; i < recordEl.children.length; i++) {
      var c = recordEl.children[i];
      if (c.tagName === tagName) return stripText(c);
    }
    return '';
  }

  function parseDate(value) {
    if (!value) return null;
    var d = new Date(value.trim().replace(' ', 'T'));
    return isNaN(d.getTime()) ? null : d;
  }

  // 日付部分のみのキーに変換する(時刻差は「同日」判定に影響させない)。
  // 不正・空の場合は最も古い扱いとして末尾に回す。
  function dateOnlyKey(d) {
    return d ? (d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate()) : -1;
  }

  // <updateDate> が新しい順(降順)に並べ、同日であれば <eventId> の昇順とする。
  function compareForSlideshow(a, b) {
    var keyA = dateOnlyKey(parseDate(a.updateDate));
    var keyB = dateOnlyKey(parseDate(b.updateDate));
    if (keyA !== keyB) return keyB - keyA;
    // eventIdはUUID形式のため数値比較ではなく文字列比較で昇順とする。
    var idA = a.eventId || '';
    var idB = b.eventId || '';
    return idA < idB ? -1 : (idA > idB ? 1 : 0);
  }

  function loadBundle() {
    return Promise.all([
      fetchJson('template.json'),
      fetchJson('assets-map.json'),
      fetchJson('qr-map.json')
    ]).then(function (results) {
      var templateConfig = results[0] || {};
      var assetsMap = results[1] || {};
      var qrMap = results[2] || {};
      var dataFile = templateConfig.dataFile || 'data.xml';
      return fetchText(dataFile).then(function (raw) {
        return { templateConfig: templateConfig, assetsMap: assetsMap, qrMap: qrMap, dataFile: dataFile, raw: raw };
      });
    });
  }

  function buildRecords(bundle) {
    var templateConfig = bundle.templateConfig;
    var recordPath = templateConfig.recordPath || '//data/item';
    var fields = templateConfig.fields || [];
    var sourcePaths = fields.map(function (f) { return f.sourcePath; });
    if (sourcePaths.indexOf('eventId') === -1) sourcePaths.push('eventId');
    if (sourcePaths.indexOf('updateDate') === -1) sourcePaths.push('updateDate');
    if (sourcePaths.indexOf('statusSignage') === -1) sourcePaths.push('statusSignage');
    if (sourcePaths.indexOf(CONFIG.imageField) === -1) sourcePaths.push(CONFIG.imageField);

    var records = [];
    if (/\.xml$/i.test(bundle.dataFile)) {
      var doc = new DOMParser().parseFromString(bundle.raw, 'application/xml');
      if (doc.getElementsByTagName('parsererror').length) {
        throw new Error('data.xml の解析に失敗しました(不正なXML)');
      }
      evaluateXPath(doc, recordPath).forEach(function (node) {
        var raw = {};
        sourcePaths.forEach(function (p) { raw[p] = directChildText(node, p); });
        records.push(raw);
      });
    } else {
      var segments = recordPath.replace(/^\/+/, '').split('/').filter(Boolean);
      var cursor = JSON.parse(bundle.raw);
      segments.forEach(function (seg) { if (cursor) cursor = cursor[seg]; });
      (Array.isArray(cursor) ? cursor : []).forEach(function (item) {
        var raw = {};
        sourcePaths.forEach(function (p) { raw[p] = item[p] != null ? String(item[p]) : ''; });
        records.push(raw);
      });
    }
    return records;
  }

  // recordFilters が template.json にあれば汎用ロジックで評価。
  // 未設定の場合は statusWeb=1 のみを既定ルールとする。
  // <statusSignage>が"0"の場合は、他の判定によらず「明示的に非表示にしたい」という
  // 意思表示として除外する。"1"・空欄(未設定)の場合はこの判定では除外しない。
  function isRecordActive(raw, recordFilters) {
    if (raw.statusSignage === '0') return false;
    if (recordFilters && recordFilters.length) {
      return recordFilters.every(function (f) {
        var value = raw[f.sourcePath];
        if (f.op === 'eq') return value === f.value;
        if (f.op === 'notPast') { var d = parseDate(value); return !d || d >= new Date(); }
        if (f.op === 'notFuture') { var d = parseDate(value); return !d || d <= new Date(); }
        return true;
      });
    }
    return raw.statusWeb === '1';
  }

  function resolveAsset(rawValue, assetsMap) {
    if (!rawValue || !assetsMap) return '';
    return assetsMap[rawValue] || '';
  }

  function escapeHtml(s) {
    return (s || '').replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // 幅測定用の非表示ルーラー要素(1個を使い回す)。position:absolute+visibility:hiddenで
  // レイアウトに影響させず、対象要素と同じフォント設定を都度コピーして測定する。
  var measureRuler = null;
  function measureTextWidth(refEl, text) {
    if (!measureRuler) {
      measureRuler = document.createElement('span');
      measureRuler.style.position = 'absolute';
      measureRuler.style.visibility = 'hidden';
      measureRuler.style.whiteSpace = 'nowrap';
      measureRuler.style.left = '-99999px';
      measureRuler.style.top = '0';
      document.body.appendChild(measureRuler);
    }
    var cs = window.getComputedStyle(refEl);
    measureRuler.style.fontFamily = cs.fontFamily;
    measureRuler.style.fontSize = cs.fontSize;
    measureRuler.style.fontWeight = cs.fontWeight;
    measureRuler.style.fontStyle = cs.fontStyle;
    measureRuler.style.letterSpacing = cs.letterSpacing;
    measureRuler.textContent = text;
    return measureRuler.getBoundingClientRect().width;
  }

  // 全角/半角混在の文章だと文字数ベースの折り返しでは行ごとの実際の見た目の長さが
  // 不揃いになり不自然な余白が生じるため、文字数は仕様書上の目安に留め、実装では
  // 実測描画幅(px)ベースで1行に収まる最大文字数をその都度求めて折り返す
  // (footerのsetTextTruncatedToWidthと同じ考え方の複数行版)。
  // event-title/event-bodyは(footerのテキストと異なり)flexアイテムではない通常の
  // block要素で、width:autoが常にコンテナ幅を返し内容量に応じて縮まないため、
  // 対象要素自体のgetBoundingClientRect().widthを直接測ることはできない
  // (常にコンテナ幅と同じ値が返り、どんな長さの文字列でも「収まる」と誤判定してしまう)。
  // そのため非表示のルーラー要素(measureTextWidth)で候補文字列だけを測る。
  // maxLines行を超える場合は最終行を省略記号で切り詰める。
  function wrapByWidth(el, text, maxLines, ellipsis) {
    var full = text || '';
    if (!full) { el.innerHTML = ''; return; }

    var maxWidthPx = el.clientWidth;

    // start位置から、末尾にsuffixを付けた状態でmaxWidthPxに収まる最大文字数を2分探索する。
    function maxFitLength(start, suffix) {
      var lo = 0;
      var hi = full.length - start;
      while (lo < hi) {
        var mid = Math.ceil((lo + hi) / 2);
        var w = measureTextWidth(el, full.slice(start, start + mid) + suffix);
        if (w <= maxWidthPx) {
          lo = mid;
        } else {
          hi = mid - 1;
        }
      }
      return lo;
    }

    var lines = [];
    var pos = 0;
    for (var i = 0; i < maxLines && pos < full.length; i++) {
      var remaining = full.length - pos;
      var fitLen = maxFitLength(pos, '');
      if (fitLen < remaining && i === maxLines - 1) {
        // 最終許容行に全文が収まりきらない: 省略記号付きで収まる長さに切り詰めて打ち切る
        fitLen = maxFitLength(pos, ellipsis);
        lines.push(full.slice(pos, pos + fitLen) + ellipsis);
        break;
      }
      if (fitLen === 0) fitLen = 1; // 極端に幅が狭い場合の無限ループ防止
      lines.push(full.slice(pos, pos + fitLen));
      pos += fitLen;
    }

    el.innerHTML = lines.map(escapeHtml).join('<br>');
  }

  // footerの1行テキスト用: 文字数ではなく実際の描画幅(px)で判定し、
  // maxWidthPx に収まらない場合は末尾を「･･･」に置き換えて切り詰める。
  // (全角/半角が混在するため、文字数カウントより実測の方が確実)
  function setTextTruncatedToWidth(el, text, maxWidthPx, ellipsis) {
    if (!el) return;
    var full = text || '';
    el.textContent = full;
    if (!full || el.getBoundingClientRect().width <= maxWidthPx) return;

    var lo = 0;
    var hi = full.length;
    while (lo < hi) {
      var mid = Math.ceil((lo + hi) / 2);
      el.textContent = full.slice(0, mid) + ellipsis;
      if (el.getBoundingClientRect().width <= maxWidthPx) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    el.textContent = full.slice(0, lo) + ellipsis;
  }

  // ロゴ・アイコン等のテンプレート固有アセット(SVG)を <img src> ではなく
  // fetchでテキスト取得してインラインSVGとして注入する。
  // CMSのアセット配信がContent-Typeヘッダーを付けないことがあり、その場合
  // <img>では「画像として不正」と判定され壊れたアイコン表示になるため回避する。
  function loadInlineSvgs() {
    var nodes = document.querySelectorAll('.inline-svg[data-src]');
    Array.prototype.forEach.call(nodes, function (el) {
      fetchText(el.getAttribute('data-src'))
        .then(function (svgText) { el.innerHTML = svgText; })
        .catch(function (err) { console.error('inline svg load failed: ' + el.getAttribute('data-src'), err); });
    });
  }

  function pad(n) { return String(n).padStart(2, '0'); }

  function renderClock() {
    var el = document.getElementById('header-clock');
    if (!el) return;
    var now = new Date();
    el.textContent = pad(now.getHours()) + ':' + pad(now.getMinutes());
  }

  // <photo1ThumbW1080> を image コンテナ(450x450)に描画する。
  // 比率が1:1でない画像は object-fit:contain (style.css 側) で
  // 枠内に収め、はみ出す分をクロップせず余白(白背景)として残す。
  function renderImage(record, assetsMap) {
    var el = document.getElementById('event-photo');
    if (!el) return;
    el.src = record ? resolveAsset(record[CONFIG.imageField], assetsMap) : '';
  }

  // <subTitle> を body コンテナのタイトルに描画する。
  // 仕様: 1行15文字程度を目安に最大2行。行に収まらない場合は末尾を「･･･」に置き換える
  // (実際の折り返しは実測描画幅ベース。wrapByWidthのコメント参照)。
  function renderTitle(record) {
    var el = document.getElementById('event-title');
    if (!el) return;
    wrapByWidth(el, record ? record.subTitle : '', 2, '･･･');
  }

  // <bodyShort> を body コンテナの本文に描画する。
  // 仕様: 1行25文字程度を目安に最大5行。行に収まらない場合は末尾を「･･･」に置き換える
  // (実際の折り返しは実測描画幅ベース。wrapByWidthのコメント参照)。
  function renderBody(record) {
    var el = document.getElementById('event-body');
    if (!el) return;
    wrapByWidth(el, record ? record.bodyShort : '', 5, '･･･');
  }

  // データが無い行(アイコン+テキスト)は丸ごと非表示にする。
  function setRowVisible(rowId, visible) {
    var row = document.getElementById(rowId);
    if (row) row.style.display = visible ? '' : 'none';
  }

  // <dateStart>～<dateEnd> / <time> / <venues>(空の場合は<place>) を footer コンテナに描画する。
  // 仕様: 1行のみ表示。テキストエリア幅(580px)からアイコン(32px)とgap(20px)を
  // 差し引いた528pxに収まらない場合は、タイトル/本文と同様に末尾を「･･･」に置き換える。
  // データが無い項目は行ごと非表示にする。
  function renderFooter(record) {
    var dateEl = document.getElementById('event-date');
    var timeEl = document.getElementById('event-time');
    var venuesEl = document.getElementById('event-venues');
    var maxWidthPx = 580 - 32 - 20;

    var dateStart = record ? record.dateStart : '';
    var dateEnd = record ? record.dateEnd : '';
    var dateText = (dateStart || dateEnd) ? (dateStart + '～' + dateEnd) : '';
    var timeText = record ? record.time : '';
    // <venues> が空の場合は <place> にフォールバック、両方空なら非表示。
    var venuesText = record ? (record.venues || record.place || '') : '';

    setRowVisible('footer-date-row', !!dateText);
    setRowVisible('footer-time-row', !!timeText);
    setRowVisible('footer-venues-row', !!venuesText);

    if (dateText) setTextTruncatedToWidth(dateEl, dateText, maxWidthPx, '･･･');
    if (timeText) setTextTruncatedToWidth(timeEl, timeText, maxWidthPx, '･･･');
    if (venuesText) setTextTruncatedToWidth(venuesEl, venuesText, maxWidthPx, '･･･');
  }

  // <eventId> のWEB QRを表示する。QR画像自体はCMSがsync時に生成し、
  // qr-map.json(eventId→画像パス)で解決できるため、テンプレート側での
  // QR生成(URL組み立て含む)は行わない。
  // 仕様: <statusWeb> が "1" の記事に限り表示(QR自体・「詳しくはWEBで」ラベルとも)。
  function renderQr(record, qrMap) {
    var qrEl = document.getElementById('footer-qr');
    var labelEl = document.getElementById('footer-qr-label');
    if (!qrEl) return;

    var qrSrc = record ? resolveAsset(record.eventId, qrMap) : '';
    var shouldShow = !!(record && record.statusWeb === '1' && qrSrc);
    if (!shouldShow) {
      qrEl.src = '';
      qrEl.style.display = 'none';
      if (labelEl) labelEl.style.display = 'none';
      return;
    }

    qrEl.style.display = '';
    if (labelEl) labelEl.style.display = '';
    qrEl.src = qrSrc;
  }

  function renderRecord(record, assetsMap, qrMap) {
    renderImage(record, assetsMap);
    renderTitle(record);
    renderBody(record);
    renderFooter(record);
    renderQr(record, qrMap);
  }

  // WonderScreen純正プレイヤーはwindow.wonderFlowで状態永続化APIを提供するが、
  // Gido等の他プレイヤーはこれを提供しないため常にresumeIdがnullとなり、
  // iframe再生成(90秒枠が回ってくるたび)のたびに先頭から再開してしまい、
  // 全記事を巡回できない不具合があった。同一オリジン(asset.localhost)内で永続化される
  // localStorageをフォールバックとして使い、wonderFlowが無い環境でも再開位置を保持する。
  // クエリ文字列(キャッシュバスター)の影響を受けないlocation.pathnameでキーを
  // スコープし、別のWEB連携コンテンツ(別テンプレート・別コンテンツ種別)の状態と
  // 混ざらないようにする。
  function resumeStorageKey() {
    return 'gido-webfeed:last_shown_id:' + location.pathname;
  }

  function getResumeId() {
    if (window.wonderFlow && typeof window.wonderFlow.getState === 'function') {
      try {
        var v = window.wonderFlow.getState('last_shown_id');
        if (v) return v;
      } catch (e) { /* フォールバックへ */ }
    }
    try { return window.localStorage.getItem(resumeStorageKey()); } catch (e) { return null; }
  }

  function setResumeId(id) {
    if (window.wonderFlow && typeof window.wonderFlow.setState === 'function') {
      try { window.wonderFlow.setState('last_shown_id', id); } catch (e) { /* noop */ }
    }
    try { window.localStorage.setItem(resumeStorageKey(), id); } catch (e) { /* noop */ }
  }

  // <updateDate>が新しい順(同日なら<eventId>昇順)に放映する。1記事15秒で、末尾まで来たら先頭に戻る。
  // 最初に表示する記事は、前回最後に表示した記事(再開位置)の次。
  function firstRecordIndex(records) {
    var resumeId = getResumeId();
    if (!resumeId) return 0;
    var idx = records.findIndex(function (r) { return r.eventId === resumeId; });
    return idx >= 0 ? (idx + 1) % records.length : 0;
  }

  // 描画済みの画像(表示中のもの)を、デコードまで済ませる。decode()に失敗しても(画像が
  // 壊れている等)描画は続けるため、失敗は無視する。
  function decodeRenderedImages() {
    var imgs = Array.prototype.slice.call(document.querySelectorAll('img'));
    return Promise.all(imgs.map(function (img) {
      if (!img.getAttribute('src') || img.style.display === 'none' || typeof img.decode !== 'function') {
        return null;
      }
      return img.decode().catch(function () { /* noop */ });
    }));
  }

  // 記事ローテーションを始める。1記事目(startIndex)は事前に描画済み(prerenderFirstRecord)。
  // elapsedMs は、プレイヤーの予定上このコンテンツが既に進んでいるはずの時間(優先度の高い
  // 割り込みの後に途中から表示される場合など)。その分だけ記事を進め、最初の記事の表示時間を
  // 短くして、以降の切り替わりを予定どおりの位置に揃える。通常の切り替え(Gido含む)では0。
  function startSlideshow(records, assetsMap, qrMap, startIndex, elapsedMs) {
    if (!records.length) return;

    var skip = Math.floor(elapsedMs / CONFIG.slideDurationMs);
    var offsetInSlideMs = elapsedMs % CONFIG.slideDurationMs;
    var current = (startIndex + skip) % records.length;
    // 途中から始める場合だけ、事前に描画した記事から描画し直す。
    if (skip > 0) renderRecord(records[current], assetsMap, qrMap);
    setResumeId(records[current].eventId);

    if (records.length <= 1) return;
    current = (current + 1) % records.length;

    function showNext() {
      var record = records[current];
      renderRecord(record, assetsMap, qrMap);
      setResumeId(record.eventId);
      current = (current + 1) % records.length;
    }

    setTimeout(function () {
      showNext();
      setInterval(showNext, CONFIG.slideDurationMs);
    }, CONFIG.slideDurationMs - offsetInSlideMs);
  }

  // プレイヤー側のプリロード機構により、実際に画面へ前面化されるより前にiframeのsrcが
  // 確定してtemplate.jsが動き出すため、データ読み込み完了と同時に記事ローテーションの
  // タイマーを始めると前倒しで進んでしまい、枠の境界がずれる(Gido Issue #36)。これを避けるため、
  //   (a) データ読み込み完了と、1記事目の事前描画・画像デコード(dataReady)
  //   (b) プレイヤーからの前面化合図{type:'gido:activate'}受信(activated)
  // の両方が揃って初めてタイマーを始める。順序はどちらが先でもよい。
  // 1記事目の描画は(a)の時点で済ませておき、前面化の瞬間にテキスト・画像がパラパラと
  // 描画されるのを防ぐ(web-Integrated-content #10)。再開位置(last_shown_id)は、実際に
  // 前面化された時点で記録する(前面化されないまま破棄された場合は進めない)。
  var activation = { dataReady: false, activated: false, started: false, elapsedMs: 0, pendingArgs: null };
  var activateFallbackTimer = null;

  function tryStartSlideshow() {
    if (activation.started || !activation.dataReady || !activation.activated) return;
    activation.started = true;
    var args = activation.pendingArgs;
    startSlideshow(args.records, args.assetsMap, args.qrMap, args.startIndex, activation.elapsedMs);
  }

  function markDataReady(records, assetsMap, qrMap) {
    var startIndex = records.length ? firstRecordIndex(records) : 0;
    renderRecord(records.length ? records[startIndex] : null, assetsMap, qrMap);
    activation.pendingArgs = { records: records, assetsMap: assetsMap, qrMap: qrMap, startIndex: startIndex };
    decodeRenderedImages().then(function () {
      activation.dataReady = true;
      tryStartSlideshow();
    });
  }

  function activate(elapsedMs) {
    if (activateFallbackTimer !== null) {
      clearTimeout(activateFallbackTimer);
      activateFallbackTimer = null;
    }
    if (activation.activated) return;
    activation.activated = true;
    activation.elapsedMs = (typeof elapsedMs === 'number' && isFinite(elapsedMs) && elapsedMs > 0) ? elapsedMs : 0;
    tryStartSlideshow();
  }

  // プレイヤー(親フレーム)からの前面化合図のみを受け付ける。elapsedMs は省略可(Gidoは送らない)。
  window.addEventListener('message', function (event) {
    if (event.source !== window.parent) return;
    if (event.data && event.data.type === 'gido:activate') activate(event.data.elapsedMs);
  });

  // フォールバックは、iframe化されていない(スタンドアロン確認時、python -m http.server等で
  // 直接開いた場合)、すなわちwindow.parent === windowの場合にのみ動作させる。
  // 親フレームに埋め込まれている(Gido等)場合は、本物のgido:activateだけを待つ
  // (埋め込み時にもこれを無条件で動かすと、Gidoのプリロードリード時間(約15秒)より
  // フォールバック(1.5秒)の方が先に発火してしまい、postMessage同期が実質無効化される)。
  if (window.parent === window) {
    activateFallbackTimer = setTimeout(function () { activate(0); }, CONFIG.activateFallbackMs);
  }

  function loadAndRender(attempt) {
    return loadBundle().then(function (bundle) {
      var allRecords = buildRecords(bundle);
      var recordFilters = bundle.templateConfig.recordFilters;
      // <updateDate>が新しいものから放映し、同日の場合は<eventId>昇順とする。
      var activeRecords = allRecords
        .filter(function (r) { return isRecordActive(r, recordFilters); })
        .sort(compareForSlideshow);
      markDataReady(activeRecords, bundle.assetsMap, bundle.qrMap);
    }).catch(function (err) {
      if (attempt < CONFIG.dataLoadMaxRetries) {
        return new Promise(function (resolve) { setTimeout(resolve, CONFIG.dataLoadRetryDelayMs); })
          .then(function () { return loadAndRender(attempt + 1); });
      }
      console.error('event feed load failed', err);
    });
  }

  loadInlineSvgs();
  renderClock();
  setInterval(renderClock, 1000);
  loadAndRender(0);

  // 初期化完了・{type:'gido:activate'}の合図待ちが可能になったことをGido本体へ通知する。
  // Gido側のorigin(tauri://localhost等、環境により変わる)をこちらから特定できないため
  // targetOriginは'*'とする(受信側であるGidoが送信元origin/window.parentを厳密に
  // チェックする設計になっている)。
  try {
    window.parent.postMessage({ type: 'gido:ready' }, '*');
  } catch (e) { /* noop */ }
})();
