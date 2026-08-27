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

  // 同名タグの入れ子を拾わないよう直下の子要素だけを見る
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

  // <updateDate> が新しい順(降順)に並べ、同日であれば <shopNewsId> の昇順とする。
  function compareForSlideshow(a, b) {
    var keyA = dateOnlyKey(parseDate(a.updateDate));
    var keyB = dateOnlyKey(parseDate(b.updateDate));
    if (keyA !== keyB) return keyB - keyA;
    // shopNewsIdはUUID形式のため数値比較ではなく文字列比較で昇順とする。
    var idA = a.shopNewsId || '';
    var idB = b.shopNewsId || '';
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
    if (sourcePaths.indexOf('shopNewsId') === -1) sourcePaths.push('shopNewsId');
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

  // 1行あたりの最大文字数×最大行数を超える場合、末尾を省略記号に置き換えて
  // (省略記号を含めた合計文字数が上限に収まるようにして) maxLines 行に分割する。
  function wrapByCharCount(text, maxCharsPerLine, maxLines, ellipsis) {
    var maxTotal = maxCharsPerLine * maxLines;
    var t = text || '';
    if (t.length > maxTotal) {
      t = t.slice(0, maxTotal - ellipsis.length) + ellipsis;
    }
    var lines = [];
    for (var i = 0; i < t.length; i += maxCharsPerLine) {
      lines.push(t.slice(i, i + maxCharsPerLine));
    }
    return lines;
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

  // データが無い行(アイコン+テキスト)は丸ごと非表示にする。
  function setRowVisible(rowId, visible) {
    var row = document.getElementById(rowId);
    if (row) row.style.display = visible ? '' : 'none';
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
  // 仕様: 1行15文字以内・最大2行、文字数オーバー時は末尾を「･･･」に置き換える。
  function renderTitle(record) {
    var el = document.getElementById('event-title');
    if (!el) return;
    var lines = wrapByCharCount(record ? record.subTitle : '', 15, 2, '･･･');
    el.innerHTML = lines.map(escapeHtml).join('<br>');
  }

  // <bodyShort> を body コンテナの本文に描画する。
  // 仕様: 1行25文字以内・最大5行、文字数オーバー時は末尾を「･･･」に置き換える。
  function renderBody(record) {
    var el = document.getElementById('event-body');
    if (!el) return;
    var lines = wrapByCharCount(record ? record.bodyShort : '', 25, 5, '･･･');
    el.innerHTML = lines.map(escapeHtml).join('<br>');
  }

  // <shopName> / <dateStart>～<dateEnd> / <shopFloorsName>(空の場合は<shopFloorName>) を
  // footerコンテナのテキストエリア(580x50 x3行)に描画する。
  // 仕様: 1行のみ表示。ショップ名行はアイコン無しのため580px、日付・階数行は
  // アイコン(32px)とgap(20px)を差し引いた528pxに収まらない場合、末尾を「･･･」に置き換える。
  // データが無い項目は行ごと非表示にする。
  function renderFooterText(record) {
    var nameEl = document.getElementById('shop-name');
    var dateEl = document.getElementById('shop-date');
    var floorEl = document.getElementById('shop-floor');
    var nameMaxWidthPx = 580;
    var iconRowMaxWidthPx = 580 - 32 - 20;

    var nameText = record ? record.shopName : '';
    var dateStart = record ? record.dateStart : '';
    var dateEnd = record ? record.dateEnd : '';
    var dateText = (dateStart || dateEnd) ? (dateStart + '～' + dateEnd) : '';
    // <shopFloorsName> が空の場合は <shopFloorName> にフォールバック、両方空なら非表示。
    var floorText = record ? (record.shopFloorsName || record.shopFloorName || '') : '';

    setRowVisible('footer-shopname-row', !!nameText);
    setRowVisible('footer-date-row', !!dateText);
    setRowVisible('footer-floor-row', !!floorText);

    if (nameText) setTextTruncatedToWidth(nameEl, nameText, nameMaxWidthPx, '･･･');
    if (dateText) setTextTruncatedToWidth(dateEl, dateText, iconRowMaxWidthPx, '･･･');
    if (floorText) setTextTruncatedToWidth(floorEl, floorText, iconRowMaxWidthPx, '･･･');
  }

  // <shopLogo> を footer コンテナのショップロゴエリア(147x147)に描画する。
  // テキスト行数がデータの有無で変動しても位置がずれないよう、footer-infoの
  // 左下に固定配置(position:absolute)しているため、横型・縦型と異なり
  // ロゴの有無によるテキストエリアの幅拡張も不要。
  function renderShopLogo(record, assetsMap) {
    var el = document.getElementById('shop-logo');
    if (!el) return;
    var logoSrc = record ? resolveAsset(record.shopLogo, assetsMap) : '';
    el.style.display = logoSrc ? '' : 'none';
    el.src = logoSrc;
  }

  // <shopNewsId> のWEB QRを表示する。QR画像自体はCMSがsync時に生成し、
  // qr-map.json(shopNewsId→画像パス)で解決できるため、テンプレート側での
  // QR生成(URL組み立て含む)は行わない。
  // 仕様: <statusWeb> が "1" の記事に限り表示(QR自体・「詳しくはWEBで」ラベルとも)。
  function renderQr(record, qrMap) {
    var qrEl = document.getElementById('footer-qr');
    var labelEl = document.getElementById('footer-qr-label');
    if (!qrEl) return;

    var qrSrc = record ? resolveAsset(record.shopNewsId, qrMap) : '';
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
    renderFooterText(record);
    renderShopLogo(record, assetsMap);
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

  // <updateDate>が新しい順(同日なら<shopNewsId>昇順)に放映する。1記事15秒で、末尾まで来たら先頭に戻る。
  function startSlideshow(records, assetsMap, qrMap) {
    if (!records.length) {
      renderRecord(null, assetsMap, qrMap);
      return;
    }

    var current = 0;
    var resumeId = getResumeId();
    if (resumeId) {
      var idx = records.findIndex(function (r) { return r.shopNewsId === resumeId; });
      if (idx >= 0) current = (idx + 1) % records.length;
    }

    function showNext() {
      var record = records[current];
      renderRecord(record, assetsMap, qrMap);
      setResumeId(record.shopNewsId);
      current = (current + 1) % records.length;
    }

    showNext();
    if (records.length > 1) {
      setInterval(showNext, CONFIG.slideDurationMs);
    }
  }

  // Gido側のプリロード機構により、実際に画面へ前面化されるより前にiframeのsrcが
  // 確定してtemplate.jsが動き出すため、データ読み込み完了と同時にstartSlideshowを
  // 呼ぶと記事ローテーションのタイマーが前倒しで進んでしまい、90秒の枠境界がずれる
  // (Gido Issue #36)。これを避けるため、
  //   (a) データ読み込み完了(dataReady)
  //   (b) Gido本体からの前面化合図{type:'gido:activate'}受信(activated)
  // の両方が揃って初めてstartSlideshowを呼ぶようにする。順序はどちらが先でもよい。
  var activation = { dataReady: false, activated: false, started: false, pendingArgs: null };
  var activateFallbackTimer = null;

  function tryStartSlideshow() {
    if (activation.started || !activation.dataReady || !activation.activated) return;
    activation.started = true;
    var args = activation.pendingArgs;
    startSlideshow(args.records, args.assetsMap, args.qrMap);
  }

  function markDataReady(records, assetsMap, qrMap) {
    activation.dataReady = true;
    activation.pendingArgs = { records: records, assetsMap: assetsMap, qrMap: qrMap };
    tryStartSlideshow();
  }

  function activate() {
    if (activateFallbackTimer !== null) {
      clearTimeout(activateFallbackTimer);
      activateFallbackTimer = null;
    }
    if (activation.activated) return;
    activation.activated = true;
    tryStartSlideshow();
  }

  // Gido本体(親フレーム)からの前面化合図のみを受け付ける。
  window.addEventListener('message', function (event) {
    if (event.source !== window.parent) return;
    if (event.data && event.data.type === 'gido:activate') activate();
  });

  // Gido外(python -m http.server等でのスタンドアロン確認時)は上記メッセージが
  // 絶対に届かないため、一定時間待っても届かなければ自動的に開始する。
  activateFallbackTimer = setTimeout(activate, CONFIG.activateFallbackMs);

  function loadAndRender(attempt) {
    return loadBundle().then(function (bundle) {
      var allRecords = buildRecords(bundle);
      var recordFilters = bundle.templateConfig.recordFilters;
      // <updateDate>が新しいものから放映し、同日の場合は<shopNewsId>昇順とする。
      var activeRecords = allRecords
        .filter(function (r) { return isRecordActive(r, recordFilters); })
        .sort(compareForSlideshow);
      markDataReady(activeRecords, bundle.assetsMap, bundle.qrMap);
    }).catch(function (err) {
      if (attempt < CONFIG.dataLoadMaxRetries) {
        return new Promise(function (resolve) { setTimeout(resolve, CONFIG.dataLoadRetryDelayMs); })
          .then(function () { return loadAndRender(attempt + 1); });
      }
      console.error('shop news feed load failed', err);
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
