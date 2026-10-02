(function () {
  'use strict';

  // aeon.jp形式(<eventroot>/<event>、本文・写真が<contents>の入れ子)のXML専用。
  // template.jsonのfieldsは使わず(CMSは入れ子の項目を<contents>1つとしか認識しないため)、
  // data.xmlを直接読んで、描画で使うキーへ下記のパスで対応付ける。
  var CONFIG = {
    // template.jsonにrecordPathが無い場合の既定値
    recordPath: '//eventroot/event',
    // 描画で使うキー → レコード要素(<event>)からのパス。パスは直下の子要素を順にたどり、
    // 同名の要素が複数ある場合(<contents>・<photo>)は先頭を使う。
    fieldPaths: {
      eventId: 'eventId',
      subTitle: 'title',
      bodyShort: 'contents/body',
      date: 'date',
      time: 'time',
      place: 'place',
      updateDate: 'update',
      pubStart: 'pubstart',
      pubEnd: 'pubend',
      image: 'contents/photos/photo/img_path'
    },
    imageField: 'image',
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

  function firstDirectChild(el, tagName) {
    for (var i = 0; i < el.children.length; i++) {
      if (el.children[i].tagName === tagName) return el.children[i];
    }
    return null;
  }

  // 'contents/photos/photo/img_path' のようなパスを、直下の子要素を順にたどって解決する
  // (子孫全体を検索すると、別の階層にある同名タグを拾いうるため)。
  function childPathText(recordEl, path) {
    var cursor = recordEl;
    var segments = path.split('/');
    for (var i = 0; i < segments.length && cursor; i++) cursor = firstDirectChild(cursor, segments[i]);
    return stripText(cursor);
  }

  // 本文はHTMLタグがエスケープされた文字列で入っている(<span style=...>等)ため、
  // タグを除いたプレーンテキストにする。<template>内はスクリプト実行・画像読み込みが
  // 行われないため、文字参照(&amp;等)の解決にそのまま使える。
  function htmlToPlainText(html) {
    if (!html || html.indexOf('<') === -1) return html || '';
    var tpl = document.createElement('template');
    tpl.innerHTML = html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h[1-6])>/gi, '\n');
    return tpl.content.textContent || '';
  }

  // 改行を含む値(本文・<time>等)を1つの流れる文章にする。表示側は white-space:nowrap で
  // 改行を半角スペースとして扱うため、それと同じく空行を除いて半角スペースで連結する。
  function joinLines(text) {
    return (text || '').split(/\r?\n/)
      .map(function (line) { return line.trim(); })
      .filter(Boolean)
      .join(' ');
  }

  // このXMLの日時は 'YYYY-MM-DD-HH-MM-SS' 形式(new Dateでは解釈できない)。
  // 'YYYY-MM-DD HH:MM:SS' 等の区切りでも読めるようにし、端末のローカル時刻として扱う。
  function parseDate(value) {
    var m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[-T ](\d{1,2})[-:](\d{1,2})(?:[-:](\d{1,2}))?)?$/.exec((value || '').trim());
    if (!m) return null;
    var d = new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
    return isNaN(d.getTime()) ? null : d;
  }

  // 日付部分のみのキーに変換する(時刻差は「同日」判定に影響させない)。
  // 不正・空の場合は最も古い扱いとして末尾に回す。
  function dateOnlyKey(d) {
    return d ? (d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate()) : -1;
  }

  // <update> が新しい順(降順)に並べ、同日であれば <eventId> の昇順とする。
  function compareForSlideshow(a, b) {
    var keyA = dateOnlyKey(parseDate(a.updateDate));
    var keyB = dateOnlyKey(parseDate(b.updateDate));
    if (keyA !== keyB) return keyB - keyA;
    // eventIdは英数字の文字列(event_e91622_as等)のため文字列比較で昇順とする。
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
    var recordPath = bundle.templateConfig.recordPath || CONFIG.recordPath;
    var doc = new DOMParser().parseFromString(bundle.raw, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) {
      throw new Error('data.xml の解析に失敗しました(不正なXML)');
    }
    return evaluateXPath(doc, recordPath).map(function (node) {
      var record = {};
      Object.keys(CONFIG.fieldPaths).forEach(function (key) {
        record[key] = childPathText(node, CONFIG.fieldPaths[key]);
      });
      record.bodyShort = joinLines(htmlToPlainText(record.bodyShort));
      record.time = joinLines(record.time);
      record.place = joinLines(record.place);
      return record;
    });
  }

  // このXMLには<statusWeb>/<statusSignage>が無いため、掲載期間(<pubstart>～<pubend>)内の
  // 記事のみを表示する。空欄(<pubend>が空=終了日なし等)・解釈できない値はその側の制限なしとする。
  function isRecordActive(record, now) {
    var start = parseDate(record.pubStart);
    var end = parseDate(record.pubEnd);
    if (start && start > now) return false;
    if (end && end < now) return false;
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

  // 次の記事の画像の先読み(web-Integrated-content #16)。src → 読み込み中またはデコード済みのImage。
  // プレイヤー(WSF)のローカル配信はキャッシュさせない(no-store)ため、同じURLを<img>に指定し直すと
  // 読み込み直しになりうる。そこで、切り替えの瞬間は<img>要素そのものを先読み済みの要素に差し替える。
  var preloadedImages = {};

  function preloadImages(srcs) {
    var kept = {};
    srcs.forEach(function (src) {
      if (!src) return;
      var img = preloadedImages[src];
      if (!img) {
        img = new Image();
        img.src = src;
        if (typeof img.decode === 'function') img.decode().catch(function () { /* noop */ });
      }
      kept[src] = img;
    });
    preloadedImages = kept;
  }

  // 先読みが済んでいれば、el をデコード済みの画像要素に差し替えて true を返す(id・class等は引き継ぐ)。
  function swapInPreloaded(el, src) {
    var img = preloadedImages[src];
    if (!img || !img.complete || !(img.naturalWidth > 0) || !el.parentNode) return false;
    delete preloadedImages[src];
    Array.prototype.forEach.call(el.attributes, function (attr) {
      if (attr.name !== 'src') img.setAttribute(attr.name, attr.value);
    });
    img.style.visibility = '';
    img.dataset.wsfPendingSrc = src;
    el.parentNode.replaceChild(img, el);
    return true;
  }

  // 記事の描画で使う画像のsrc(renderImage・renderQrと同じ条件)。先読み用。
  function recordImageSources(record, assetsMap, qrMap) {
    if (!record) return [];
    return [
      resolveAsset(record[CONFIG.imageField], assetsMap),
      resolveAsset(record.eventId, qrMap)
    ];
  }

  // 画像を差し替える。新しい画像の読み込みが終わるまでは非表示(visibility: hidden)にし、前の記事の
  // 画像・ロゴ・QRが新しい記事のテキストと一緒に見えないようにする。読み込みの完了順が入れ替わっても、
  // 最後に指定したsrcのときだけ表示する。読み込めなかった画像は非表示のまま(web-Integrated-content #14)。
  function setImageSrc(el, src) {
    if (!el) return;
    var next = src || '';
    el.dataset.wsfPendingSrc = next;
    if (!next) {
      el.removeAttribute('src');
      el.style.visibility = 'hidden';
      return;
    }
    if (el.getAttribute('src') === next && el.complete && el.naturalWidth > 0) {
      el.style.visibility = '';
      return;
    }
    if (swapInPreloaded(el, next)) return;
    el.style.visibility = 'hidden';
    el.onload = function () {
      if (el.dataset.wsfPendingSrc === next) el.style.visibility = '';
    };
    el.onerror = null;
    el.src = next;
  }

  function renderClock() {
    var el = document.getElementById('header-clock');
    if (!el) return;
    var now = new Date();
    el.textContent = pad(now.getHours()) + ':' + pad(now.getMinutes());
  }

  // <contents>/<photos>/<photo>/<img_path>(先頭の写真) を image コンテナ(960x960)に描画する。
  // assets-map.json のキーは前後の改行・空白を除いたURLになっている。
  // 比率が1:1でない画像は object-fit:contain (style.css 側) で
  // 枠内に収め、はみ出す分をクロップせず余白(白背景)として残す。
  function renderImage(record, assetsMap) {
    var el = document.getElementById('event-photo');
    if (!el) return;
    setImageSrc(el, record ? resolveAsset(record[CONFIG.imageField], assetsMap) : '');
  }

  // <title> を body コンテナのタイトルに描画する。
  // 仕様: 1行15文字程度を目安に最大2行。行に収まらない場合は末尾を「･･･」に置き換える
  // (実際の折り返しは実測描画幅ベース。wrapByWidthのコメント参照)。
  function renderTitle(record) {
    var el = document.getElementById('event-title');
    if (!el) return;
    wrapByWidth(el, record ? record.subTitle : '', 2, '･･･');
  }

  // <contents>/<body>(タグを除いたテキスト) を body コンテナの本文に描画する。
  // 仕様: 1行25文字程度を目安に最大5行。行に収まらない場合は末尾を「･･･」に置き換える
  // (実際の折り返しは実測描画幅ベース。wrapByWidthのコメント参照)。
  function renderBody(record) {
    var el = document.getElementById('event-body');
    if (!el) return;
    wrapByWidth(el, record ? record.bodyShort : '', 5, '･･･');
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

  // <date> / <time> / <place> を footer コンテナに描画する。
  // <date>は「10月11日（日）」のように表示用に整形済みの文字列のため、そのまま表示する。
  // 仕様: 1行のみ表示。テキストエリア幅(700px)からアイコン(32px)とgap(20px)を
  // 差し引いた648pxに収まらない場合は、タイトル/本文と同様に末尾を「･･･」に置き換える。
  // データが無い項目は行ごと非表示にする。
  function renderFooter(record) {
    var dateEl = document.getElementById('event-date');
    var timeEl = document.getElementById('event-time');
    var venuesEl = document.getElementById('event-venues');
    var maxWidthPx = 700 - 32 - 20;

    var dateText = record ? record.date : '';
    var timeText = record ? record.time : '';
    var venuesText = record ? record.place : '';

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
  // このXMLには<statusWeb>が無いため、QRが解決できた記事は表示する
  // (CMSが<pc_url>からQRを生成する。template.json の urlTemplates.qr 参照)。
  function renderQr(record, qrMap) {
    var qrEl = document.getElementById('footer-qr');
    var labelEl = document.getElementById('footer-qr-label');
    if (!qrEl) return;

    var qrSrc = record ? resolveAsset(record.eventId, qrMap) : '';
    var shouldShow = !!qrSrc;
    if (!shouldShow) {
      setImageSrc(qrEl, '');
      qrEl.style.display = 'none';
      if (labelEl) labelEl.style.display = 'none';
      return;
    }

    qrEl.style.display = '';
    if (labelEl) labelEl.style.display = '';
    setImageSrc(qrEl, qrSrc);
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

  // <update>が新しい順(同日なら<eventId>昇順)に放映する。1記事15秒で、末尾まで来たら先頭に戻る。
  // 最初に表示する記事は、前回最後に表示した記事(再開位置)の次。
  function firstRecordIndex(records) {
    var resumeId = getResumeId();
    if (!resumeId) return 0;
    var idx = records.findIndex(function (r) { return r.eventId === resumeId; });
    return idx >= 0 ? (idx + 1) % records.length : 0;
  }

  // elapsedMs(プレイヤーの予定上、既に進んでいるはずの時間)の分だけ進めた記事の位置。
  function indexAfterElapsed(startIndex, count, elapsedMs) {
    return (startIndex + Math.floor(elapsedMs / CONFIG.slideDurationMs)) % count;
  }

  function normalizeElapsedMs(value) {
    return (typeof value === 'number' && isFinite(value) && value > 0) ? value : 0;
  }

  // rotationMs(プレイヤーがスケジュールから計算した、このコンテンツがこれまでに放映された
  // 合計時間)。届いていなければnull。WSFが送り、Gidoは送らない(web-Integrated-content #12)。
  function normalizeRotationMs(value) {
    return (typeof value === 'number' && isFinite(value) && value >= 0) ? value : null;
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

  // 記事ローテーションを始める。最初に表示する記事は、前面化より前に描画済み
  // (activation.renderedIndex)。elapsedMs の分だけ記事を進め、最初の記事の表示時間を
  // 短くして、以降の切り替わりを予定どおりの位置に揃える(通常の切り替え・Gidoでは0)。
  // 事前に描画した記事と違う場合(gido:prepareが無く、gido:activateで初めて途中からと
  // 分かった場合)だけ描画し直す。
  function startSlideshow(records, assetsMap, qrMap, startIndex, renderedIndex, elapsedMs) {
    if (!records.length) return;

    var current = indexAfterElapsed(startIndex, records.length, elapsedMs);
    var offsetInSlideMs = elapsedMs % CONFIG.slideDurationMs;
    if (current !== renderedIndex) renderRecord(records[current], assetsMap, qrMap);
    setResumeId(records[current].eventId);

    if (records.length <= 1) return;
    current = (current + 1) % records.length;
    preloadImages(recordImageSources(records[current], assetsMap, qrMap));

    function showNext() {
      var record = records[current];
      renderRecord(record, assetsMap, qrMap);
      setResumeId(record.eventId);
      current = (current + 1) % records.length;
      preloadImages(recordImageSources(records[current], assetsMap, qrMap));
    }

    setTimeout(function () {
      showNext();
      setInterval(showNext, CONFIG.slideDurationMs);
    }, CONFIG.slideDurationMs - offsetInSlideMs);
  }

  // プレイヤー側のプリロード機構により、実際に画面へ前面化されるより前にiframeのsrcが
  // 確定してtemplate.jsが動き出すため、データ読み込み完了と同時に記事ローテーションの
  // タイマーを始めると前倒しで進んでしまい、枠の境界がずれる(Gido Issue #36)。これを避けるため、
  //   (a) データ読み込み完了と、最初に表示する記事の事前描画・画像デコード(dataReady)
  //   (b) プレイヤーからの前面化合図{type:'gido:activate'}受信(activated)
  // の両方が揃って初めてタイマーを始める。順序はどちらが先でもよい。
  // 最初に表示する記事の描画は(a)の時点で済ませておき、前面化の瞬間にテキスト・画像が
  // パラパラと描画されるのを防ぐ(web-Integrated-content #10)。途中から表示される場合は、
  // プレイヤーが前面化より前に{type:'gido:prepare', elapsedMs}で知らせるため、その記事を
  // 事前に描画しておく。再開位置(last_shown_id)は、実際に前面化された時点で記録する
  // (前面化されないまま破棄された場合は進めない)。
  var activation = {
    dataReady: false, activated: false, started: false,
    prepareElapsedMs: 0, elapsedMs: 0,
    // rotationMsが届いた場合は、端末に保存した再開位置ではなく、それから記事の位置を決める
    // (端末や再起動をまたいでも同じ記事になる)。
    prepareRotationMs: null, rotationMs: null,
    pendingArgs: null, renderedIndex: -1, renderSeq: 0
  };
  var activateFallbackTimer = null;

  function tryStartSlideshow() {
    if (activation.started || !activation.dataReady || !activation.activated) return;
    activation.started = true;
    var args = activation.pendingArgs;
    if (activation.rotationMs !== null) {
      startSlideshow(args.records, args.assetsMap, args.qrMap, 0, activation.renderedIndex, activation.rotationMs);
      return;
    }
    startSlideshow(args.records, args.assetsMap, args.qrMap, args.startIndex, activation.renderedIndex,
      activation.elapsedMs);
  }

  // 最初に表示する記事(再開位置からprepareElapsedMs分進めた記事)を描画し、画像のデコード
  // まで済ませてからdataReadyにする。gido:prepareで位置が変わった場合は描画し直す。
  function prerenderFirstRecord() {
    var args = activation.pendingArgs;
    if (!args || activation.started) return;
    var records = args.records;
    var index = -1;
    if (records.length) {
      index = activation.prepareRotationMs !== null
        ? indexAfterElapsed(0, records.length, activation.prepareRotationMs)
        : indexAfterElapsed(args.startIndex, records.length, activation.prepareElapsedMs);
    }
    if (index === activation.renderedIndex && activation.dataReady) return;

    activation.dataReady = false;
    activation.renderedIndex = index;
    var seq = ++activation.renderSeq;
    renderRecord(index >= 0 ? records[index] : null, args.assetsMap, args.qrMap);
    decodeRenderedImages().then(function () {
      if (seq !== activation.renderSeq) return; // 途中で描画し直した場合は、新しい方を待つ
      activation.dataReady = true;
      tryStartSlideshow();
    });
  }

  function markDataReady(records, assetsMap, qrMap) {
    var startIndex = records.length ? firstRecordIndex(records) : 0;
    activation.pendingArgs = { records: records, assetsMap: assetsMap, qrMap: qrMap, startIndex: startIndex };
    prerenderFirstRecord();
  }

  function prepare(elapsedMs, rotationMs) {
    if (activation.started || activation.activated) return;
    activation.prepareElapsedMs = normalizeElapsedMs(elapsedMs);
    activation.prepareRotationMs = normalizeRotationMs(rotationMs);
    prerenderFirstRecord();
  }

  function activate(elapsedMs, rotationMs) {
    if (activateFallbackTimer !== null) {
      clearTimeout(activateFallbackTimer);
      activateFallbackTimer = null;
    }
    if (activation.activated) return;
    activation.activated = true;
    activation.elapsedMs = normalizeElapsedMs(elapsedMs);
    activation.rotationMs = normalizeRotationMs(rotationMs);
    tryStartSlideshow();
  }

  // プレイヤー(親フレーム)からの合図のみを受け付ける。gido:prepare・elapsedMs・rotationMs は
  // 省略可(Gidoは送らない)。
  window.addEventListener('message', function (event) {
    if (event.source !== window.parent || !event.data) return;
    if (event.data.type === 'gido:prepare') prepare(event.data.elapsedMs, event.data.rotationMs);
    if (event.data.type === 'gido:activate') activate(event.data.elapsedMs, event.data.rotationMs);
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
      var now = new Date();
      // <update>が新しいものから放映し、同日の場合は<eventId>昇順とする。
      var activeRecords = allRecords
        .filter(function (r) { return isRecordActive(r, now); })
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
