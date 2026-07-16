(function () {
  'use strict';

  // ここを変えれば表示間隔・1画面あたりの件数を調整できる(サーバー側に自動反映される仕組みは無い)
  var CONFIG = {
    pageDurationMs: 8000,
    itemsPerPage: 3,
    imageField: 'photo1ThumbW640'
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

  function renderCard(record, assetsMap) {
    var imgSrc = resolveAsset(record[CONFIG.imageField], assetsMap);
    return (
      '<div class="card">' +
      '<div class="card-thumb" style="' + (imgSrc ? 'background-image:url(\'' + imgSrc + '\')' : '') + '"></div>' +
      '<div class="card-text">' +
      (record.categories ? '<span class="card-category">' + escapeHtml(record.categories) + '</span>' : '') +
      '<div class="card-title">' + escapeHtml(record.title) + '</div>' +
      '<div class="card-meta">' +
      (record.time ? '<span>' + escapeHtml(record.time) + '</span>' : '') +
      (record.place ? '<span>' + escapeHtml(record.place) + '</span>' : '') +
      '</div></div></div>'
    );
  }

  function renderPage(el, pageRecords, assetsMap) {
    if (!pageRecords || !pageRecords.length) {
      el.innerHTML = '<div class="empty-state">表示できるイベント情報がありません</div>';
      return;
    }
    el.innerHTML = pageRecords.map(function (r) { return renderCard(r, assetsMap); }).join('');
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

  function startTicker(records, assetsMap) {
    if (!records.length) {
      renderPage(slideEls[0], null, assetsMap);
      slideEls[0].classList.add('is-active');
      return;
    }

    var perPage = CONFIG.itemsPerPage;
    var pageCount = Math.ceil(records.length / perPage);
    var currentPage = 0;

    var resumeId = getResumeId();
    if (resumeId) {
      var idx = records.findIndex(function (r) { return r.eventId === resumeId; });
      if (idx >= 0) currentPage = (Math.floor(idx / perPage) + 1) % pageCount;
    }

    function showNextPage() {
      var start = currentPage * perPage;
      var pageRecords = records.slice(start, start + perPage);
      var nextEl = slideEls[(activeIndex + 1) % 2];
      var curEl = slideEls[activeIndex];
      renderPage(nextEl, pageRecords, assetsMap);
      nextEl.classList.add('is-active');
      curEl.classList.remove('is-active');
      activeIndex = (activeIndex + 1) % 2;
      setResumeId(pageRecords[0].eventId);
      currentPage = (currentPage + 1) % pageCount;
    }

    showNextPage();
    setInterval(showNextPage, CONFIG.pageDurationMs);
  }

  loadBundle().then(function (bundle) {
    var allRecords = buildRecords(bundle);
    var recordFilters = bundle.templateConfig.recordFilters;
    var activeRecords = allRecords.filter(function (r) { return isRecordActive(r, recordFilters); });
    startTicker(activeRecords, bundle.assetsMap);
  }).catch(function (err) {
    document.getElementById('ws-root').innerHTML =
      '<div class="empty-state">データの読み込みに失敗しました: ' + escapeHtml(String(err && err.message || err)) + '</div>';
  });
})();
