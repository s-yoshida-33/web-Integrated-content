(function () {
  'use strict';

  // ここを変えれば表示間隔を調整できる(サーバー側に自動反映される仕組みは無い)
  var CONFIG = {
    imageField: 'photo1ThumbW1080',
    // 仕様書通り1記事15秒
    slideDurationMs: 15000,
    // 再生ローテーションのタイミングでファイルが再展開中(書き込み途中)のことがあるため、
    // 読み込み・パース失敗時は少し待ってリトライする
    dataLoadMaxRetries: 5,
    dataLoadRetryDelayMs: 600
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

  function loadText(path) {
    return fetch(path, { cache: 'no-store' })
      .then(function (res) {
        if (!res.ok) throw new Error('failed to fetch ' + path + ': ' + res.status);
        return res.text();
      })
      .catch(function () { return loadViaXHR(path); });
  }

  function fetchText(path) {
    return loadText(path);
  }

  function fetchJson(path) {
    return loadText(path)
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

  function loadBundle() {
    return Promise.all([
      fetchJson('template.json'),
      fetchJson('assets-map.json')
    ]).then(function (results) {
      var templateConfig = results[0] || {};
      var assetsMap = results[1] || {};
      var dataFile = templateConfig.dataFile || 'data.xml';
      return fetchText(dataFile).then(function (raw) {
        return { templateConfig: templateConfig, assetsMap: assetsMap, dataFile: dataFile, raw: raw };
      });
    });
  }

  function buildRecords(bundle) {
    var templateConfig = bundle.templateConfig;
    var recordPath = templateConfig.recordPath || '//data/item';
    var fields = templateConfig.fields || [];
    var sourcePaths = fields.map(function (f) { return f.sourcePath; });
    if (sourcePaths.indexOf('eventId') === -1) sourcePaths.push('eventId');
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
  // このAEON EVENTNEWSの実データではrecordFiltersが未設定だったため、
  // その場合は statusSignage=1 かつ公開期間内、という既定ルールを使う。
  function isRecordActive(raw, recordFilters) {
    if (recordFilters && recordFilters.length) {
      return recordFilters.every(function (f) {
        var value = raw[f.sourcePath];
        if (f.op === 'eq') return value === f.value;
        if (f.op === 'notPast') { var d = parseDate(value); return !d || d >= new Date(); }
        if (f.op === 'notFuture') { var d = parseDate(value); return !d || d <= new Date(); }
        return true;
      });
    }
    if (raw.statusSignage !== '1') return false;
    var now = new Date();
    var start = parseDate(raw.pubStart);
    var end = parseDate(raw.pubEnd);
    if (start && now < start) return false;
    if (end && now > end) return false;
    return true;
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
  // maxWidthPx に収まらない場合は末尾を「・・・」に置き換えて切り詰める。
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

  // <photo1ThumbW1080> を image コンテナ(960x960)に描画する。
  // 比率が1:1でない画像は object-fit:contain (style.css 側) で
  // 枠内に収め、はみ出す分をクロップせず余白(白背景)として残す。
  function renderImage(record, assetsMap) {
    var el = document.getElementById('event-photo');
    if (!el) return;
    el.src = record ? resolveAsset(record[CONFIG.imageField], assetsMap) : '';
  }

  // <subTitle> を body コンテナのタイトルに描画する。
  // 仕様: 1行15文字以内・最大2行、文字数オーバー時は末尾を「・・・」に置き換える。
  function renderTitle(record) {
    var el = document.getElementById('event-title');
    if (!el) return;
    var lines = wrapByCharCount(record ? record.subTitle : '', 15, 2, '・・・');
    el.innerHTML = lines.map(escapeHtml).join('<br>');
  }

  // <bodyShort> を body コンテナの本文に描画する。
  // 仕様: 1行25文字以内・最大5行、文字数オーバー時は末尾を「・・・」に置き換える。
  function renderBody(record) {
    var el = document.getElementById('event-body');
    if (!el) return;
    var lines = wrapByCharCount(record ? record.bodyShort : '', 25, 5, '・・・');
    el.innerHTML = lines.map(escapeHtml).join('<br>');
  }

  // データが無い行(アイコン+テキスト)は丸ごと非表示にする。
  function setRowVisible(rowId, visible) {
    var row = document.getElementById(rowId);
    if (row) row.style.display = visible ? '' : 'none';
  }

  // <dateStart>～<dateEnd> / <time> / <venues>(空の場合は<place>) を footer コンテナに描画する。
  // 仕様: 1行のみ表示。テキストエリア幅(700px)からアイコン(32px)とgap(20px)を
  // 差し引いた648pxに収まらない場合は、タイトル/本文と同様に末尾を「・・・」に置き換える。
  // データが無い項目は行ごと非表示にする。
  function renderFooter(record) {
    var dateEl = document.getElementById('event-date');
    var timeEl = document.getElementById('event-time');
    var venuesEl = document.getElementById('event-venues');
    var maxWidthPx = 700 - 32 - 20;

    var dateStart = record ? record.dateStart : '';
    var dateEnd = record ? record.dateEnd : '';
    var dateText = (dateStart || dateEnd) ? (dateStart + '～' + dateEnd) : '';
    var timeText = record ? record.time : '';
    // <venues> が空の場合は <place> にフォールバック、両方空なら非表示。
    var venuesText = record ? (record.venues || record.place || '') : '';

    setRowVisible('footer-date-row', !!dateText);
    setRowVisible('footer-time-row', !!timeText);
    setRowVisible('footer-venues-row', !!venuesText);

    if (dateText) setTextTruncatedToWidth(dateEl, dateText, maxWidthPx, '・・・');
    if (timeText) setTextTruncatedToWidth(timeEl, timeText, maxWidthPx, '・・・');
    if (venuesText) setTextTruncatedToWidth(venuesEl, venuesText, maxWidthPx, '・・・');
  }

  // <eventId> からイベントページのWEB QRを生成する(URLベースは assets/tpl/mall-config.js 側の
  // window.MALL_CONFIG.eventUrlBase で定義。テンプレート本体にモール固有URLの文字列を持たせない)。
  // 仕様: <statusWeb> が "1" の記事に限り表示(QR自体・「詳しくはWEBで」ラベルとも)。
  function renderQr(record) {
    var qrEl = document.getElementById('footer-qr');
    var labelEl = document.getElementById('footer-qr-label');
    if (!qrEl) return;

    var shouldShow = !!(record && record.statusWeb === '1' && record.eventId);
    if (!shouldShow) {
      qrEl.innerHTML = '';
      qrEl.style.display = 'none';
      if (labelEl) labelEl.style.display = 'none';
      return;
    }

    qrEl.style.display = '';
    if (labelEl) labelEl.style.display = '';

    var urlBase = (window.MALL_CONFIG && window.MALL_CONFIG.eventUrlBase) || '';
    var url = urlBase + record.eventId;
    var qr = qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    qrEl.innerHTML = qr.createSvgTag({ cellSize: 4, scalable: true });
  }

  function renderRecord(record, assetsMap) {
    renderImage(record, assetsMap);
    renderTitle(record);
    renderBody(record);
    renderFooter(record);
    renderQr(record);
  }

  function getResumeId() {
    if (window.wonderFlow && typeof window.wonderFlow.getState === 'function') {
      try { return window.wonderFlow.getState('last_shown_id'); } catch (e) { return null; }
    }
    return null;
  }

  function setResumeId(id) {
    if (window.wonderFlow && typeof window.wonderFlow.setState === 'function') {
      try { window.wonderFlow.setState('last_shown_id', id); } catch (e) { /* noop */ }
    }
  }

  // 記事IDの大きい順に放映(仕様書通り)。1記事15秒で、末尾まで来たら先頭に戻る。
  function startSlideshow(records, assetsMap) {
    if (!records.length) {
      renderRecord(null, assetsMap);
      return;
    }

    var current = 0;
    var resumeId = getResumeId();
    if (resumeId) {
      var idx = records.findIndex(function (r) { return r.eventId === resumeId; });
      if (idx >= 0) current = (idx + 1) % records.length;
    }

    function showNext() {
      var record = records[current];
      renderRecord(record, assetsMap);
      setResumeId(record.eventId);
      current = (current + 1) % records.length;
    }

    showNext();
    if (records.length > 1) {
      setInterval(showNext, CONFIG.slideDurationMs);
    }
  }

  function loadAndRender(attempt) {
    return loadBundle().then(function (bundle) {
      var allRecords = buildRecords(bundle);
      var recordFilters = bundle.templateConfig.recordFilters;
      // フィードはeventId昇順で並んでいるため、「記事IDの大きい順に放映」(仕様書)を
      // 満たすには反転させる。
      var activeRecords = allRecords
        .filter(function (r) { return isRecordActive(r, recordFilters); })
        .reverse();
      startSlideshow(activeRecords, bundle.assetsMap);
    }).catch(function (err) {
      if (attempt < CONFIG.dataLoadMaxRetries) {
        return new Promise(function (resolve) { setTimeout(resolve, CONFIG.dataLoadRetryDelayMs); })
          .then(function () { return loadAndRender(attempt + 1); });
      }
      console.error('event feed load failed', err);
    });
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

  loadInlineSvgs();
  loadAndRender(0);
})();
