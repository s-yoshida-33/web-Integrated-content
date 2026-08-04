(function () {
  'use strict';

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

  loadInlineSvgs();
  renderClock();
  setInterval(renderClock, 1000);
})();
