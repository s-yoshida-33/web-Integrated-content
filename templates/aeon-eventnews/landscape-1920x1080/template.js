(function () {
  'use strict';

  // ここを変えれば表示間隔・切替時間を調整できる(サーバー側に自動反映される仕組みは無い)
  var CONFIG = {
    slideDurationMs: 10000,
    imageField: 'photo1ThumbW1080'
  };

  var slideEls = [document.getElementById('slideA'), document.getElementById('slideB')];
  var activeIndex = 0;

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
    // eventId は resume キーとして常に読む(マッピングでrole="id"が未設定でも必要)
    if (sourcePaths.indexOf('eventId') === -1) sourcePaths.push('eventId');

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
      // JSON フィード向けの簡易対応。recordPath を "/" 区切りのキーとして辿る
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
  // マッピング画面でrecordFiltersを設定すればそちらが優先される。
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

  function renderSlide(el, record, assetsMap) {
    if (!record) {
      el.innerHTML = '<div class="empty-state">表示できるイベント情報がありません</div>';
      return;
    }
    var imgSrc = resolveAsset(record[CONFIG.imageField], assetsMap);
    el.innerHTML =
      '<div class="slide-bg" style="' + (imgSrc ? 'background-image:url(\'' + imgSrc + '\')' : '') + '"></div>' +
      '<div class="slide-overlay">' +
      (record.categories ? '<span class="slide-category">' + escapeHtml(record.categories) + '</span>' : '') +
      '<h1 class="slide-title">' + escapeHtml(record.title) + '</h1>' +
      (record.bodyShort ? '<p class="slide-body">' + escapeHtml(record.bodyShort) + '</p>' : '') +
      '<div class="slide-meta">' +
      (record.time ? '<span>' + escapeHtml(record.time) + '</span>' : '') +
      (record.place ? '<span>' + escapeHtml(record.place) + '</span>' : '') +
      '</div></div>';
  }

  function escapeHtml(s) {
    return (s || '').replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
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

  function startSlideshow(records, assetsMap) {
    if (!records.length) {
      renderSlide(slideEls[0], null, assetsMap);
      slideEls[0].classList.add('is-active');
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
      var nextEl = slideEls[(activeIndex + 1) % 2];
      var curEl = slideEls[activeIndex];
      renderSlide(nextEl, record, assetsMap);
      nextEl.classList.add('is-active');
      curEl.classList.remove('is-active');
      activeIndex = (activeIndex + 1) % 2;
      setResumeId(record.eventId);
      current = (current + 1) % records.length;
    }

    showNext();
    setInterval(showNext, CONFIG.slideDurationMs);
  }

  loadBundle().then(function (bundle) {
    var allRecords = buildRecords(bundle);
    var recordFilters = bundle.templateConfig.recordFilters;
    var activeRecords = allRecords.filter(function (r) { return isRecordActive(r, recordFilters); });
    startSlideshow(activeRecords, bundle.assetsMap);
  }).catch(function (err) {
    document.getElementById('ws-root').innerHTML =
      '<div class="empty-state">データの読み込みに失敗しました: ' + escapeHtml(String(err && err.message || err)) + '</div>';
  });
})();
