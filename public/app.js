'use strict';

(function () {
  var POLL_MS = 5000;
  var state = {
    address: null,
    expiresAt: null,
    extended: false,
    pollTimer: null,
    countdownTimer: null,
    lastEmails: [],
  };

  var $ = function (id) { return document.getElementById(id); };

  var toastTimer = null;
  function toast(msg) {
    var el = $('toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.add('hidden'); }, 2500);
  }

  function copyText(text, msg) {
    function done() { toast(msg || 'Copiado'); }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text); done(); });
    } else {
      fallbackCopy(text);
      done();
    }
  }
  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) { /* ignore */ }
    document.body.removeChild(ta);
  }

  function fmtRemaining(ms) {
    if (ms <= 0) return '00:00';
    var s = Math.floor(ms / 1000);
    var m = Math.floor(s / 60);
    var r = s % 60;
    return String(m).padStart(2, '0') + ':' + String(r).padStart(2, '0');
  }

  function stopTimers() {
    if (state.pollTimer) clearInterval(state.pollTimer);
    if (state.countdownTimer) clearInterval(state.countdownTimer);
    state.pollTimer = null;
    state.countdownTimer = null;
  }

  function showExpired() {
    stopTimers();
    $('countdown').textContent = '00:00';
    $('inbox-empty').textContent = 'La dirección expiró. Genera una nueva para seguir recibiendo correos.';
    $('btn-extend').disabled = true;
    try { localStorage.removeItem('tempmail_address'); } catch (e) { /* ignore */ }
  }

  function startTimers() {
    stopTimers();
    state.countdownTimer = setInterval(function () {
      var remaining = new Date(state.expiresAt).getTime() - Date.now();
      $('countdown').textContent = fmtRemaining(remaining);
      if (remaining <= 0) showExpired();
    }, 1000);
    state.pollTimer = setInterval(loadInbox, POLL_MS);
  }

  function renderInbox(emails) {
    state.lastEmails = emails;
    $('inbox-count').textContent = emails.length + (emails.length === 1 ? ' correo' : ' correos');
    $('inbox-empty').classList.toggle('hidden', emails.length > 0);
    var list = $('mail-list');
    list.innerHTML = '';
    emails.forEach(function (email) {
      var li = document.createElement('li');
      var pill = email.hasCode && email.code
        ? '<span class="code-pill">Código: ' + escapeHtml(email.code) + '</span>'
        : '';
      li.innerHTML =
        '<div class="mail-subject">' + escapeHtml(email.subject || '(sin asunto)') + pill + '</div>' +
        '<div class="mail-meta">' + escapeHtml(email.from) + ' · ' + escapeHtml(new Date(email.receivedAt).toLocaleString()) + '</div>' +
        '<div class="mail-snippet">' + escapeHtml(email.snippet || '') + '</div>';
      li.addEventListener('click', function () { openEmail(email.id); });
      list.appendChild(li);
    });
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function loadInbox() {
    if (!state.address) return;
    fetch('/api/inbox/' + encodeURIComponent(state.address))
      .then(function (res) {
        if (res.status === 404) { showExpired(); return null; }
        return res.json();
      })
      .then(function (data) {
        if (!data || !data.ok) return;
        state.expiresAt = data.expiresAt;
        state.extended = !!data.extended;
        $('extended-badge').classList.toggle('hidden', !state.extended);
        $('btn-extend').disabled = state.extended;
        renderInbox(data.emails || []);
      })
      .catch(function () { /* next poll retries */ });
  }

  function openEmail(id) {
    fetch('/api/inbox/' + encodeURIComponent(state.address) + '/' + encodeURIComponent(id))
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (!data || !data.ok) { toast('No se pudo abrir el correo'); return; }
        $('reader-subject').textContent = data.subject || '(sin asunto)';
        $('reader-from').textContent = data.from || '';
        $('reader-date').textContent = data.receivedAt ? new Date(data.receivedAt).toLocaleString() : '';
        var codeBox = $('code-box');
        if (data.code) {
          codeBox.classList.remove('hidden');
          $('reader-code').textContent = data.code;
        } else {
          codeBox.classList.add('hidden');
        }
        // Show the plain-text body only; HTML is never injected raw (it comes from untrusted senders).
        $('reader-body').textContent = data.text || '(sin contenido de texto)';
        $('reader-card').classList.remove('hidden');
        $('inbox-card').classList.add('hidden');
        window.scrollTo({ top: 0, behavior: 'smooth' });
      })
      .catch(function () { toast('No se pudo abrir el correo'); });
  }

  function setAddress(address, expiresAt, extended) {
    state.address = address;
    state.expiresAt = expiresAt;
    state.extended = !!extended;
    $('address').textContent = address;
    $('generate-card').classList.add('hidden');
    $('address-card').classList.remove('hidden');
    $('inbox-card').classList.remove('hidden');
    $('reader-card').classList.add('hidden');
    $('extended-badge').classList.toggle('hidden', !state.extended);
    $('btn-extend').disabled = state.extended;
    try { localStorage.setItem('tempmail_address', address); } catch (e) { /* ignore */ }
    startTimers();
    loadInbox();
  }

  function clearAddress() {
    stopTimers();
    state.address = null;
    state.expiresAt = null;
    state.extended = false;
    try { localStorage.removeItem('tempmail_address'); } catch (e) { /* ignore */ }
    $('address-card').classList.add('hidden');
    $('inbox-card').classList.add('hidden');
    $('reader-card').classList.add('hidden');
    $('generate-card').classList.remove('hidden');
    $('mail-list').innerHTML = '';
    $('inbox-count').textContent = '0 correos';
    $('inbox-empty').classList.remove('hidden');
    $('inbox-empty').textContent = 'Sin correos todavía. Cuando llegue uno aparecerá aquí.';
  }

  function generate() {
    var btn = $('btn-generate');
    btn.disabled = true;
    btn.textContent = 'Generando…';
    fetch('/api/inbox', { method: 'POST' })
      .then(function (res) { return res.json().then(function (d) { return { status: res.status, data: d }; }); })
      .then(function (r) {
        if (!r.data.ok) {
          toast(r.data.error === 'rate_limited' ? 'Demasiadas direcciones creadas. Espera un poco.' : 'No se pudo crear la dirección');
          return;
        }
        setAddress(r.data.address, r.data.expiresAt, r.data.extended);
        toast('Correo temporal creado');
      })
      .catch(function () { toast('Error de conexión'); })
      .finally(function () {
        btn.disabled = false;
        btn.textContent = 'Generar correo temporal';
      });
  }

  $('btn-generate').addEventListener('click', generate);
  $('btn-new').addEventListener('click', generate);
  $('btn-copy-address').addEventListener('click', function () {
    if (state.address) copyText(state.address, 'Dirección copiada');
  });
  $('btn-copy-code').addEventListener('click', function () {
    copyText($('reader-code').textContent, 'Código copiado');
  });
  $('btn-back').addEventListener('click', function () {
    $('reader-card').classList.add('hidden');
    $('inbox-card').classList.remove('hidden');
  });
  $('btn-delete').addEventListener('click', function () {
    if (!state.address) return;
    fetch('/api/inbox/' + encodeURIComponent(state.address), { method: 'DELETE' })
      .finally(function () {
        clearAddress();
        toast('Dirección eliminada');
      });
  });
  $('btn-extend').addEventListener('click', function () {
    if (!state.address) return;
    fetch('/api/inbox/' + encodeURIComponent(state.address) + '/extend', { method: 'POST' })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (!data.ok) {
          toast(data.error === 'already_extended' ? 'Ya usaste tu única extensión' : 'No se pudo extender');
          return;
        }
        state.expiresAt = data.expiresAt;
        state.extended = true;
        $('extended-badge').classList.remove('hidden');
        $('btn-extend').disabled = true;
        toast('Dirección extendida +30 minutos');
      })
      .catch(function () { toast('No se pudo extender'); });
  });

  // Restore the previous address after a reload, if it is still alive.
  try {
    var saved = localStorage.getItem('tempmail_address');
    if (saved) {
      fetch('/api/inbox/' + encodeURIComponent(saved))
        .then(function (res) { return res.ok ? res.json() : null; })
        .then(function (data) {
          if (data && data.ok) setAddress(data.address, data.expiresAt, data.extended);
          else localStorage.removeItem('tempmail_address');
        })
        .catch(function () { /* stay on the generate screen */ });
    }
  } catch (e) { /* ignore */ }
})();
