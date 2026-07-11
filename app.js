(function () {
  'use strict';

  // ============ 配置 ============
  var LS_KEY = 'invoiceApp.webAppUrl';
  var webAppUrl = localStorage.getItem(LS_KEY) || '';

  // ============ 工具函数 ============
  function $(sel) { return document.querySelector(sel); }
  function $all(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }
  function escapeHtml(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function money(n) {
    n = parseFloat(n) || 0;
    return '$' + n.toFixed(2);
  }
  var toastTimer = null;
  function toast(msg, isError) {
    var el = $('#toast');
    el.textContent = msg;
    el.classList.toggle('is-error', !!isError);
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.add('hidden'); }, 2600);
  }

  function fileToBase64(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        var result = reader.result || '';
        var idx = result.indexOf(',');
        resolve(idx >= 0 ? result.slice(idx + 1) : result);
      };
      reader.onerror = function () { reject(new Error('文件读取失败')); };
      reader.readAsDataURL(file);
    });
  }

  // ============ 与 Apps Script 网页应用通信 ============
  // 统一用 POST + text/plain，避免浏览器发送 CORS 预检请求（Apps Script 不处理 OPTIONS）。
  function callApi(action, payload) {
    if (!webAppUrl) {
      return Promise.reject(new Error('还没有设置网页应用网址，请先点右上角 ⚙️ 设置'));
    }
    var body = Object.assign({ action: action }, payload || {});
    return fetch(webAppUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body)
    })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        if (!data || data.ok === false) throw new Error((data && data.error) || '请求失败');
        return data;
      });
  }

  function updateConnStatus(state) {
    var el = $('#connStatus');
    el.classList.remove('conn-status--ok', 'conn-status--fail', 'conn-status--unknown');
    if (state === 'ok') { el.classList.add('conn-status--ok'); el.textContent = '已连接'; }
    else if (state === 'fail') { el.classList.add('conn-status--fail'); el.textContent = '未连接'; }
    else { el.classList.add('conn-status--unknown'); el.textContent = '未设置'; }
  }

  function checkConnection() {
    if (!webAppUrl) { updateConnStatus('unset'); return; }
    callApi('ping').then(function () { updateConnStatus('ok'); })
      .catch(function () { updateConnStatus('fail'); });
  }

  // ============ 底部导航 / 视图切换 ============
  function showView(name) {
    $all('.view').forEach(function (v) { v.classList.add('hidden'); });
    $('#view-' + name).classList.remove('hidden');
    $all('.tab-item').forEach(function (t) {
      t.classList.toggle('is-active', t.getAttribute('data-view') === name);
    });
    if (name === 'review' && !reviewLoadedOnce) {
      loadReview(currentMode);
    }
  }
  $all('.tab-item').forEach(function (btn) {
    btn.addEventListener('click', function () { showView(btn.getAttribute('data-view')); });
  });

  // ============ 设置弹层 ============
  var sheet = $('#settingsSheet');
  function openSettings() {
    $('#webAppUrlInput').value = webAppUrl;
    $('#settingsMsg').textContent = '';
    $('#settingsMsg').className = 'sheet-msg';
    sheet.classList.remove('hidden');
  }
  function closeSettings() { sheet.classList.add('hidden'); }
  $('#btnSettings').addEventListener('click', openSettings);
  $('#settingsBackdrop').addEventListener('click', closeSettings);

  $('#btnSaveSettings').addEventListener('click', function () {
    var val = $('#webAppUrlInput').value.trim();
    if (val && !/^https:\/\/script\.google\.com\/macros\/s\/.+\/exec$/.test(val)) {
      var msg = $('#settingsMsg');
      msg.textContent = '⚠️ 网址格式看起来不太对，应该以 https://script.google.com/macros/s/ 开头、/exec 结尾';
      msg.className = 'sheet-msg is-error';
      return;
    }
    webAppUrl = val;
    localStorage.setItem(LS_KEY, webAppUrl);
    checkConnection();
    toast('已保存设置');
    closeSettings();
  });

  $('#btnTestConn').addEventListener('click', function () {
    var val = $('#webAppUrlInput').value.trim();
    var prev = webAppUrl;
    webAppUrl = val;
    var msg = $('#settingsMsg');
    msg.textContent = '正在测试…';
    msg.className = 'sheet-msg';
    callApi('ping').then(function () {
      msg.textContent = '✅ 连接成功';
      msg.className = 'sheet-msg is-ok';
    }).catch(function (err) {
      msg.textContent = '❌ 连接失败：' + err.message;
      msg.className = 'sheet-msg is-error';
    }).finally(function () { webAppUrl = prev; });
  });

  // ============ 上传逻辑 ============
  var pendingFiles = []; // { id, file }
  var idCounter = 0;

  function iconForFile(file) {
    var t = file.type || '';
    var n = file.name.toLowerCase();
    if (t.indexOf('image') !== -1) return '🖼️';
    if (t === 'application/pdf' || n.endsWith('.pdf')) return '📄';
    if (n.endsWith('.doc') || n.endsWith('.docx')) return '📝';
    if (n.endsWith('.xls') || n.endsWith('.xlsx')) return '📊';
    if (n.endsWith('.csv')) return '🧾';
    return '📎';
  }

  function renderPending() {
    var list = $('#pendingList');
    list.innerHTML = pendingFiles.map(function (p) {
      return '<li class="pending-item" data-id="' + p.id + '">' +
        '<span class="pi-icon">' + iconForFile(p.file) + '</span>' +
        '<span class="pi-name">' + escapeHtml(p.file.name) + '</span>' +
        '<button class="pi-remove" data-remove="' + p.id + '">✕</button>' +
        '</li>';
    }).join('');
    $('#btnUpload').disabled = pendingFiles.length === 0;
  }

  function addFiles(fileList) {
    Array.prototype.forEach.call(fileList, function (f) {
      pendingFiles.push({ id: ++idCounter, file: f });
    });
    renderPending();
  }

  $('#cameraInput').addEventListener('change', function (e) { addFiles(e.target.files); e.target.value = ''; });
  $('#fileInput').addEventListener('change', function (e) { addFiles(e.target.files); e.target.value = ''; });

  $('#pendingList').addEventListener('click', function (e) {
    var id = e.target.getAttribute('data-remove');
    if (!id) return;
    pendingFiles = pendingFiles.filter(function (p) { return String(p.id) !== id; });
    renderPending();
  });

  $('#btnUpload').addEventListener('click', function () {
    if (!webAppUrl) { toast('请先设置网页应用网址', true); openSettings(); return; }
    if (pendingFiles.length === 0) return;

    var files = pendingFiles.slice();
    $('#btnUpload').disabled = true;
    $('#uploadResult').classList.add('hidden');
    var progressBox = $('#uploadProgress');
    var progressText = $('#uploadProgressText');
    progressBox.classList.remove('hidden');

    var chain = Promise.resolve();
    files.forEach(function (p, i) {
      chain = chain.then(function () {
        progressText.textContent = '正在上传 ' + (i + 1) + ' / ' + files.length + '：' + p.file.name;
        return fileToBase64(p.file).then(function (b64) {
          return callApi('uploadOnly', { fileName: p.file.name, mimeType: p.file.type || 'application/octet-stream', base64: b64 });
        });
      });
    });

    chain
      .then(function () {
        progressText.textContent = '正在识别与录入，请稍候…（AI 识别可能需要几十秒）';
        return callApi('runProcess');
      })
      .then(function (resp) {
        progressBox.classList.add('hidden');
        pendingFiles = [];
        renderPending();
        showUploadResult(resp.result);
      })
      .catch(function (err) {
        progressBox.classList.add('hidden');
        var box = $('#uploadResult');
        box.className = 'result-box is-error';
        box.innerHTML = '<h4>❌ 处理失败</h4><p>' + escapeHtml(err.message) + '</p>';
        box.classList.remove('hidden');
      })
      .finally(function () {
        $('#btnUpload').disabled = pendingFiles.length === 0;
      });
  });

  function showUploadResult(result) {
    var box = $('#uploadResult');
    if (!result) { box.classList.add('hidden'); return; }
    box.className = 'result-box';
    var lines = [];
    lines.push('<h4>✅ 处理完成</h4>');
    lines.push('<p>共扫描 ' + result.filesScanned + ' 个文件，成功处理 ' + result.processedInvoiceCount + ' 份，新增 ' + (result.newRecords || []).length + ' 条商品明细。</p>');
    var flaggedCount = (result.newRecords || []).filter(function (r) { return String(r.auditStatus || '').indexOf('⚠️') !== -1; }).length;
    if (flaggedCount > 0) lines.push('<p>⚠️ 其中 ' + flaggedCount + ' 条金额对不上，建议去核对确认。</p>');
    if (result.skippedFiles && result.skippedFiles.length > 0) {
      lines.push('<p>跳过 ' + result.skippedFiles.length + ' 个文件：' + escapeHtml(result.skippedFiles.join('、')) + '</p>');
    }
    if ((result.newRecords || []).length > 0) {
      lines.push('<button class="go-review" id="btnGoReview">去人工核对 →</button>');
    }
    box.innerHTML = lines.join('');
    box.classList.remove('hidden');

    var btn = $('#btnGoReview');
    if (btn) {
      btn.addEventListener('click', function () {
        renderReviewCards(result.newRecords, 'flagged-or-new');
        currentMode = 'justUploaded';
        $all('.filter-tab').forEach(function (t) { t.classList.remove('is-active'); });
        showView('review');
        reviewLoadedOnce = true;
      });
    }
  }

  // ============ 人工核对逻辑 ============
  var currentMode = 'flagged';
  var reviewLoadedOnce = false;

  $all('.filter-tab').forEach(function (tab) {
    tab.addEventListener('click', function () {
      $all('.filter-tab').forEach(function (t) { t.classList.remove('is-active'); });
      tab.classList.add('is-active');
      currentMode = tab.getAttribute('data-mode');
      loadReview(currentMode);
    });
  });
  $('#btnRefreshReview').addEventListener('click', function () { loadReview(currentMode); });

  function loadReview(mode) {
    if (!webAppUrl) {
      toast('请先设置网页应用网址', true);
      openSettings();
      return;
    }
    $('#reviewEmpty').classList.add('hidden');
    $('#reviewList').innerHTML = '';
    $('#reviewLoading').classList.remove('hidden');
    reviewLoadedOnce = true;

    callApi('getReviewData', { mode: mode, limit: 100 })
      .then(function (resp) {
        $('#reviewLoading').classList.add('hidden');
        renderReviewCards(resp.data || [], mode);
      })
      .catch(function (err) {
        $('#reviewLoading').classList.add('hidden');
        toast('读取失败：' + err.message, true);
      });
  }

  function renderReviewCards(rows, mode) {
    var listEl = $('#reviewList');
    var approveBtn = $('#btnApproveAll');
    if (!rows || rows.length === 0) {
      listEl.innerHTML = '';
      $('#reviewEmpty').classList.remove('hidden');
      approveBtn.classList.add('hidden');
      return;
    }
    $('#reviewEmpty').classList.add('hidden');
    listEl.innerHTML = rows.map(cardTemplate).join('');
    bindCardEvents();
    approveBtn.classList.remove('hidden');
    $('#approveAllCount').textContent = rows.length;
  }

  function cardTemplate(r) {
    var flagged = String(r.auditStatus || '').indexOf('⚠️') !== -1;
    var reviewed = String(r.auditStatus || '').indexOf('人工已核对') !== -1;
    var cardClass = flagged ? 'is-flagged' : (reviewed ? 'is-reviewed' : '');
    var badgeClass = flagged ? 'badge--flagged' : 'badge--ok';
    return (
      '<div class="item-card ' + cardClass + '" data-record-id="' + escapeHtml(r.recordId) + '">' +
        '<div class="ic-head">' +
          '<div>' +
            '<div class="ic-title">' + escapeHtml(r.product || '未知商品') + '</div>' +
            '<div class="ic-meta">' +
              '<span>' + escapeHtml(r.supplier || '未识别') + '</span>' +
              '<span>发票 ' + escapeHtml(r.invoiceNum || '-') + '</span>' +
              '<span>' + escapeHtml(String(r.date || '')) + '</span>' +
            '</div>' +
            '<div class="ic-meta"><span>UPC ' + escapeHtml(r.upc || '无') + '</span><span>箱装 ' + escapeHtml(String(r.qtyInCase != null ? r.qtyInCase : '-')) + '</span></div>' +
          '</div>' +
          '<span class="badge ' + badgeClass + '">' + escapeHtml(r.auditStatus || '') + '</span>' +
        '</div>' +
        '<div class="ic-fields">' +
          '<div class="field">' +
            '<label>购买数量</label>' +
            '<input type="number" inputmode="decimal" step="any" class="qty-input" value="' + escapeHtml(r.qty) + '">' +
          '</div>' +
          '<div class="field">' +
            '<label>进货单价</label>' +
            '<input type="number" inputmode="decimal" step="0.01" class="cost-input" value="' + escapeHtml(r.unitCost) + '">' +
          '</div>' +
        '</div>' +
        '<div class="ic-total"><span>总成本</span><strong class="total-display">' + money(r.cost) + '</strong></div>' +
        '<div class="ic-actions"><button class="save-btn" disabled>保存</button></div>' +
      '</div>'
    );
  }

  function bindCardEvents() {
    $all('.item-card').forEach(function (card) {
      var qtyInput = card.querySelector('.qty-input');
      var costInput = card.querySelector('.cost-input');
      var totalDisplay = card.querySelector('.total-display');
      var saveBtn = card.querySelector('.save-btn');

      function recalc() {
        var q = parseFloat(qtyInput.value) || 0;
        var c = parseFloat(costInput.value) || 0;
        totalDisplay.textContent = money(q * c);
        saveBtn.disabled = false;
        saveBtn.classList.remove('is-saved');
        saveBtn.textContent = '保存';
      }
      qtyInput.addEventListener('input', recalc);
      costInput.addEventListener('input', recalc);

      saveBtn.addEventListener('click', function () {
        var recordId = card.getAttribute('data-record-id');
        var qty = qtyInput.value === '' ? null : parseFloat(qtyInput.value);
        var unitCost = costInput.value === '' ? null : parseFloat(costInput.value);
        saveBtn.disabled = true;
        saveBtn.textContent = '保存中…';

        callApi('updateItem', { recordId: recordId, qty: qty, unitCost: unitCost })
          .then(function (resp) {
            var row = resp.row;
            totalDisplay.textContent = money(row.cost);
            saveBtn.textContent = '✓ 已保存';
            saveBtn.classList.add('is-saved');
            var badge = card.querySelector('.badge');
            badge.textContent = row.auditStatus;
            badge.className = 'badge badge--ok';
            card.classList.remove('is-flagged');
            card.classList.add('is-reviewed');
            toast('已保存');
          })
          .catch(function (err) {
            saveBtn.disabled = false;
            saveBtn.textContent = '保存';
            toast('保存失败：' + err.message, true);
          });
      });
    });
  }

  $('#btnApproveAll').addEventListener('click', function () {
    var cards = $all('.item-card');
    if (cards.length === 0) return;

    var confirmed = window.confirm(
      '确认把当前显示的这 ' + cards.length + ' 条记录全部标记为「已人工核对」吗？\n' +
      '会保存每条卡片当前显示的购买数量和进货单价。'
    );
    if (!confirmed) return;

    var items = cards.map(function (card) {
      var qtyInput = card.querySelector('.qty-input');
      var costInput = card.querySelector('.cost-input');
      return {
        recordId: card.getAttribute('data-record-id'),
        qty: qtyInput.value === '' ? null : parseFloat(qtyInput.value),
        unitCost: costInput.value === '' ? null : parseFloat(costInput.value)
      };
    });

    var btn = $('#btnApproveAll');
    btn.disabled = true;
    var originalText = btn.innerHTML;
    btn.textContent = '正在保存…';

    callApi('batchUpdateItems', { items: items })
      .then(function (resp) {
        var updatedMap = {};
        (resp.updated || []).forEach(function (u) { updatedMap[u.recordId] = u; });

        cards.forEach(function (card) {
          var recordId = card.getAttribute('data-record-id');
          var u = updatedMap[recordId];
          if (!u) return;
          card.querySelector('.total-display').textContent = money(u.cost);
          var badge = card.querySelector('.badge');
          badge.textContent = u.auditStatus;
          badge.className = 'badge badge--ok';
          card.classList.remove('is-flagged');
          card.classList.add('is-reviewed');
          var saveBtn = card.querySelector('.save-btn');
          saveBtn.disabled = true;
          saveBtn.textContent = '✓ 已保存';
          saveBtn.classList.add('is-saved');
        });

        toast('已批量核对 ' + (resp.updated || []).length + ' 条');
        btn.innerHTML = originalText;
        btn.disabled = false;
      })
      .catch(function (err) {
        toast('批量核对失败：' + err.message, true);
        btn.innerHTML = originalText;
        btn.disabled = false;
      });
  });

  // ============ 初始化 ============
  checkConnection();
  if (!webAppUrl) {
    setTimeout(openSettings, 400);
  }
})();
