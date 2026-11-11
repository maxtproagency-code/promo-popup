/*!
 * Promo Popup v1.2.1 — легкий попап
 * Автор: maxt.pro
 *
 * Режими:
 *   mode: 'promo' — текст + промокод, який копіюється (v1.0, поведінка незмінна)
 *   mode: 'email' — текст + поле email, відправка на endpoint (Apps Script)
 *
 * Підключення: спочатку window.PromoPopupConfig = {...}, потім цей скрипт.
 * autoShow:false — показ лише тоді, коли спрацював тег GTM (повторні спрацювання безпечні).
 * Налагодження: ?promo_debug=1 — показати одразу (ігнорує дати, частоту, виключення, кошик)
 *               ?promo_reset=1 — очистити історію показів для цього попапу
 */
(function (w, d) {
  'use strict';

  if (w.PromoPopup && w.PromoPopup.__loaded) return; // захист від повторного запуску GTM

  var VERSION = '1.2.1';
  var STORAGE_PREFIX = 'promo_popup_';
  var QUEUE_KEY = 'promo_popup_queue';

  var DEFAULTS = {
    id: 'promo',
    mode: 'promo',            // 'promo' | 'email'
    disabled: false,
    title: '',
    text: '',
    closeLabel: 'Закрити',

    // --- режим promo ---
    code: '',
    copiedText: 'Скопійовано ✓',
    copyHint: 'Натисніть, щоб скопіювати промокод',

    // --- режим email ---
    form: {
      label: 'Ваш email',
      placeholder: 'ваш@email.com',
      button: 'Надіслати',
      buttonSending: 'Надсилаємо…',
      consentMode: 'checkbox',   // 'checkbox' | 'notice' | 'none'
      consentChecked: false,     // чекбокс позначений за умовчуванням
      consentText: '',           // дозволено <a>, <b>, <i>, <br>
      errorEmail: 'Перевірте, будь ласка, адресу',
      errorConsent: 'Потрібна ваша згода',
      errorSend: 'Не вдалося надіслати. Спробуйте ще раз',
      successTitle: 'Готово!',
      successText: 'Лист уже в дорозі.',
      successCloseSec: 5
    },

    submit: {
      endpoint: '',              // URL веб-додатку Apps Script
      token: '',                 // той самий рядок, що в CFG.TOKEN скрипта
      type: 'subscribe',
      minSeconds: 2,             // сабміт раніше — вважаємо ботом
      retry: true                // невдалі сабміти складаємо в чергу й пробуємо потім
    },

    // --- кошик (режим email) ---
    cart: {
      storageKey: 'hv_cart',     // пише тег GTM: {items:[{id,name,price,qty}], ts}
      ttlDays: 7,
      required: true,            // без товарів у кошику попап не показуємо
      waitSec: 3,                // autoShow:false — скільки секунд чекати запису кошика тегом GTM
      watchMinutes: 20,          // autoShow:true — скільки хвилин чекати, поки товар додадуть
      maxItems: 6
    },

    // --- умови показу ---
    autoShow: true,              // true — самі таймери нижче (delaySec, exitIntent…)
                                 // false — показ одразу при запуску тегу; момент задає тригер GTM
    start: null,                 // 'YYYY-MM-DD' — включно
    end: null,                   // 'YYYY-MM-DD' — включно
    delaySec: 10,                // показ через N секунд на сторінці
    scrollPercent: 0,            // або після прокрутки N% (0 — вимкнено)
    exitIntent: false,           // або коли курсор іде за верхню межу (десктоп)
    inactivitySec: 0,            // або після N секунд без дій (0 — вимкнено)
    hideDaysAfterClose: 3,
    hideDaysAfterCopy: 30,       // режим promo
    hideDaysAfterSubmit: 30,     // режим email
    closeOnOverlay: true,
    excludeUrls: [],

    dataLayer: true,             // пуші подій у dataLayer
    eventPrefix: 'promo_popup',

    theme: {
      fontFamily: "'Montserrat', Arial, sans-serif",
      fontUrl: '',
      overlay: 'rgba(0, 0, 0, 0.7)',
      background: '#FFF0EC',
      accent: '#F07BA6',         // заголовок і промокод
      accentText: '#ffffff',
      button: '',                // фон кнопки ('' — як accent)
      buttonText: '',            // текст кнопки ('' — як accentText)
      titleSize: 30,             // кегль заголовка, px
      titleTransform: 'uppercase',
      text: '#222222',
      muted: '#6b7280',
      error: '#d02020',
      codeBorder: '#222222',
      inputBorder: '#c9c2bf',
      radius: 16,                // кути вікна
      fieldRadius: 10,           // кути поля, кнопки, рамки промокоду
      maxWidth: 350,
      zIndex: 2147483000
    }
  };

  /* ---------- утиліти ---------- */

  function merge(base, extra) {
    var out = {}, k;
    for (k in base) out[k] = base[k];
    for (k in extra || {}) {
      if (extra[k] && typeof extra[k] === 'object' && !Array.isArray(extra[k]) && base[k] && typeof base[k] === 'object') {
        out[k] = merge(base[k], extra[k]);
      } else if (extra[k] !== undefined) {
        out[k] = extra[k];
      }
    }
    return out;
  }

  function hasParam(name) {
    return new RegExp('[?&]' + name + '=1(&|$)').test(w.location.search);
  }

  var DEBUG = hasParam('promo_debug');

  function log() {
    if (!DEBUG || !w.console) return;
    var args = ['[PromoPopup]'].concat([].slice.call(arguments));
    w.console.log.apply(w.console, args);
  }

  function esc(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Дозволяємо в тексті лише <br>, <b>, <strong>, <i>, <em> та <a href="...">
  function richText(str) {
    return esc(str)
      .replace(/&lt;br\s*\/?&gt;/gi, '<br>')
      .replace(/&lt;(\/?)(b|strong|i|em)&gt;/gi, '<$1$2>')
      .replace(/&lt;a\s+href=&quot;((?:https?:\/\/|\/)\S*?)&quot;\s*&gt;/gi,
        '<a href="$1" target="_blank" rel="noopener">')
      .replace(/&lt;\/a&gt;/gi, '</a>')
      .replace(/\n/g, '<br>');
  }

  function ls(key) {
    return {
      get: function () {
        try { return JSON.parse(w.localStorage.getItem(key)) || null; } catch (e) { return null; }
      },
      set: function (data) {
        try { w.localStorage.setItem(key, JSON.stringify(data)); } catch (e) {}
      },
      clear: function () {
        try { w.localStorage.removeItem(key); } catch (e) {}
      }
    };
  }

  function store(cfg) {
    var raw = ls(STORAGE_PREFIX + cfg.id);
    return {
      get: function () { return raw.get() || {}; },
      set: raw.set,
      clear: raw.clear
    };
  }

  function parseDate(str, endOfDay) {
    if (!str) return null;
    var p = String(str).split('-');
    return new Date(+p[0], +p[1] - 1, +p[2], endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0).getTime();
  }

  var DAY = 864e5;
  var EMAIL_RE = /^[^\s@]{1,64}@[a-z0-9.-]+\.[a-z]{2,}$/i;

  function validEmail(v) {
    var e = String(v || '').trim();
    return EMAIL_RE.test(e) && e.indexOf('..') === -1 ? e.toLowerCase() : '';
  }

  // Причина, чому попап не показано: видно в GTM Preview як подію <eventPrefix>_skip
  function skip(cfg, reason) {
    log('не показано:', reason);
    pushDL(cfg, 'skip', { reason: reason, version: VERSION });
    return false;
  }

  function pushDL(cfg, name, extra) {
    if (!cfg.dataLayer) return;
    w.dataLayer = w.dataLayer || [];
    var o = { event: cfg.eventPrefix + '_' + name, popup_id: cfg.id };
    for (var k in extra || {}) o[k] = extra[k];
    w.dataLayer.push(o);
    log('dataLayer', o.event);
  }

  /* ---------- кошик і client_id ---------- */

  function readCart(cfg) {
    var s = ls(cfg.cart.storageKey).get();
    if (!s || !s.items || !s.items.length) return [];
    if (s.ts && Date.now() - s.ts > cfg.cart.ttlDays * DAY) return [];
    return s.items.filter(function (i) {
      return i && /^[\w\-]{1,60}$/.test(String(i.id || ''));
    }).slice(0, cfg.cart.maxItems).map(function (i) {
      return { id: String(i.id), qty: Math.max(1, parseInt(i.qty, 10) || 1) };
    });
  }

  // _ga=GA1.1.123456789.1700000000 → '123456789.1700000000'
  function clientId() {
    var m = d.cookie.match(/(?:^|;\s*)_ga=GA\d\.\d\.(\d+\.\d+)/);
    return m ? m[1] : '';
  }

  /* ---------- відправка ---------- */

  function postJson(url, payload) {
    var body = JSON.stringify(payload);
    if (w.fetch) {
      return w.fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // без preflight
        body: body
      }).then(function (r) {
        return r.text().then(function (t) {
          return { ok: r.ok && /^ok/i.test(t.trim()), body: t.trim() };
        });
      }, function (err) {
        // CORS / мережа — пробуємо beacon: доставка ймовірна, але відповіді не бачимо
        if (w.navigator.sendBeacon) {
          try {
            var blob = new Blob([body], { type: 'text/plain;charset=utf-8' });
            if (w.navigator.sendBeacon(url, blob)) return { ok: true, body: 'beacon', blind: true };
          } catch (e) {}
        }
        return { ok: false, body: 'network: ' + (err && err.message) };
      });
    }
    return new Promise(function (resolve) {
      try {
        var x = new XMLHttpRequest();
        x.open('POST', url, true);
        x.setRequestHeader('Content-Type', 'text/plain;charset=utf-8');
        x.onload = function () {
          resolve({ ok: x.status >= 200 && x.status < 300 && /^ok/i.test(x.responseText), body: x.responseText });
        };
        x.onerror = function () { resolve({ ok: false, body: 'xhr error' }); };
        x.send(body);
      } catch (e) { resolve({ ok: false, body: 'xhr: ' + e.message }); }
    });
  }

  // Невдалі сабміти складаємо в чергу й пробуємо при наступному завантаженні сторінки
  function queueAdd(payload) {
    var q = ls(QUEUE_KEY).get() || [];
    q.push({ at: Date.now(), payload: payload });
    ls(QUEUE_KEY).set(q.slice(-5));
  }

  function queueFlush(cfg) {
    var q = ls(QUEUE_KEY).get();
    if (!q || !q.length || !cfg.submit.endpoint) return;
    var keep = [];
    var done = 0;
    q.forEach(function (item) {
      if (Date.now() - item.at > 3 * DAY) return;            // надто старе — викидаємо
      postJson(cfg.submit.endpoint, item.payload).then(function (res) {
        if (!res.ok) keep.push(item);
        if (++done === q.length) ls(QUEUE_KEY).set(keep);
        log('черга', res.ok ? 'відправлено' : 'лишається', res.body);
      });
    });
  }

  /* ---------- перевірки показу ---------- */

  // ignoreCart: перевіряємо все, крім наявності кошика (його чекає watchCart)
  function canShow(cfg, st, ignoreCart) {
    if (cfg.disabled) return skip(cfg, 'disabled');
    if (cfg.mode === 'promo' && !cfg.code) return skip(cfg, 'no_code');
    if (cfg.mode === 'email' && !cfg.submit.endpoint) return skip(cfg, 'no_endpoint');
    if (DEBUG) return true;

    var now = Date.now();
    var start = parseDate(cfg.start, false);
    var end = parseDate(cfg.end, true);
    if (start && now < start) return skip(cfg, 'not_started');
    if (end && now > end) return skip(cfg, 'ended');

    var url = w.location.href;
    for (var i = 0; i < cfg.excludeUrls.length; i++) {
      if (url.indexOf(cfg.excludeUrls[i]) !== -1) return skip(cfg, 'excluded_url');
    }

    if (!ignoreCart && cfg.mode === 'email' && cfg.cart.required && !readCart(cfg).length) {
      return skip(cfg, 'empty_cart');
    }

    var s = st.get();
    if (s.submittedAt && now - s.submittedAt < cfg.hideDaysAfterSubmit * DAY) return skip(cfg, 'recently_submitted');
    if (s.copiedAt && now - s.copiedAt < cfg.hideDaysAfterCopy * DAY) return skip(cfg, 'recently_copied');
    if (s.closedAt && now - s.closedAt < cfg.hideDaysAfterClose * DAY) return skip(cfg, 'recently_closed');
    return true;
  }

  /* ---------- копіювання ---------- */

  function legacyCopy(text) {
    var ta = d.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none;';
    d.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length); // iOS
    var ok = false;
    try { ok = d.execCommand('copy'); } catch (e) {}
    d.body.removeChild(ta);
    return ok;
  }

  function copyText(text) {
    if (w.navigator.clipboard && w.isSecureContext) {
      return w.navigator.clipboard.writeText(text).then(
        function () { return true; },
        function () { return legacyCopy(text); }
      );
    }
    return Promise.resolve(legacyCopy(text));
  }

  /* ---------- розмітка і стилі ---------- */

  var ICON_COPY = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">' +
    '<rect x="8" y="8" width="12" height="13" rx="2.5" fill="none" stroke="currentColor" stroke-width="2.2"/>' +
    '<path d="M16 8V5.5A2.5 2.5 0 0 0 13.5 3h-7A2.5 2.5 0 0 0 4 5.5v9A2.5 2.5 0 0 0 6.5 17H8" fill="none" stroke="currentColor" stroke-width="2.2"/></svg>';

  var ICON_CLOSE = '<svg viewBox="0 0 32 32" width="32" height="32" aria-hidden="true" focusable="false">' +
    '<circle cx="16" cy="16" r="14" fill="none" stroke="currentColor" stroke-width="2.5"/>' +
    '<path d="M11 11l10 10M21 11L11 21" stroke="currentColor" stroke-width="2.8" stroke-linecap="round"/></svg>';

  var ICON_OK = '<svg viewBox="0 0 48 48" width="56" height="56" aria-hidden="true" focusable="false">' +
    '<circle cx="24" cy="24" r="21" fill="none" stroke="currentColor" stroke-width="3"/>' +
    '<path d="M14 25l7 7 14-15" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function css(t) {
    var bBg = t.button || t.accent;             // кнопка може мати власний колір
    var bFg = t.buttonText || t.accentText;
    var fR = t.fieldRadius;
    return '' +
      ':host{all:initial;}' +
      '*,*::before,*::after{box-sizing:border-box;}' +
      '.ov{position:fixed;inset:0;z-index:' + t.zIndex + ';background:' + t.overlay + ';display:flex;align-items:center;justify-content:center;overflow-y:auto;padding:56px 16px 16px;' +
        'font-family:' + t.fontFamily + ';-webkit-font-smoothing:antialiased;opacity:0;transition:opacity .25s ease;}' +
      '.ov.on{opacity:1;}' +
      '.box{position:relative;width:100%;max-width:' + t.maxWidth + 'px;background:' + t.background + ';border-radius:' + t.radius + 'px;' +
        'padding:26px 24px 24px;text-align:center;color:' + t.text + ';box-shadow:0 20px 60px rgba(0,0,0,.25);' +
        'transform:translateY(12px) scale(.97);transition:transform .25s ease;}' +
      '.ov.on .box{transform:none;}' +
      '.box:focus{outline:none;}' +
      '.ttl{margin:0 0 12px;font-size:' + t.titleSize + 'px;line-height:1.15;font-weight:800;text-transform:' + t.titleTransform + ';color:' + t.accent + ';letter-spacing:.01em;}' +
      '.txt{margin:0 0 24px;font-size:16px;line-height:1.45;font-weight:500;}' +
      // промокод
      '.code{all:unset;box-sizing:border-box;width:100%;display:flex;align-items:center;justify-content:center;gap:10px;min-height:62px;padding:12px 16px;' +
        'border:2px dashed ' + t.codeBorder + ';border-radius:' + fR + 'px;cursor:pointer;font-family:inherit;transition:background-color .2s ease;}' +
      '.code:hover{background:rgba(255,255,255,.55);}' +
      '.code:focus-visible{outline:3px solid ' + t.accent + ';outline-offset:3px;}' +
      '.val{font-size:24px;font-weight:800;letter-spacing:.04em;color:' + t.accent + ';user-select:all;-webkit-user-select:all;}' +
      '.ico{display:inline-flex;color:' + t.codeBorder + ';}' +
      '.code.ok .val{font-size:20px;letter-spacing:0;}' +
      // форма email
      '.frm{display:block;text-align:left;}' +
      '.in{all:unset;box-sizing:border-box;display:block;width:100%;min-height:52px;padding:14px 16px;background:#fff;color:' + t.text + ';' +
        'font-family:inherit;font-size:16px;font-weight:500;border:1.5px solid ' + t.inputBorder + ';border-radius:' + fR + 'px;-webkit-appearance:none;}' +
      '.in::placeholder{color:' + t.muted + ';opacity:1;}' +
      '.in:focus-visible{outline:none;border-color:' + t.accent + ';box-shadow:0 0 0 3px rgba(0,0,0,.06);}' +
      '.in[aria-invalid="true"]{border-color:' + t.error + ';}' +
      '.btn{all:unset;box-sizing:border-box;display:flex;align-items:center;justify-content:center;width:100%;min-height:52px;margin-top:10px;padding:14px 18px;' +
        'background:' + bBg + ';color:' + bFg + ';font-family:inherit;font-size:16px;font-weight:800;text-align:center;' +
        'border-radius:' + fR + 'px;cursor:pointer;transition:opacity .2s ease;}' +
      '.btn:hover{opacity:.9;}' +
      '.btn:focus-visible{outline:3px solid ' + t.text + ';outline-offset:2px;}' +
      '.btn[disabled]{opacity:.6;cursor:default;}' +
      '.chk{display:flex;align-items:flex-start;gap:8px;margin-top:14px;font-size:12.5px;line-height:1.4;color:' + t.muted + ';}' +
      '.chk input{all:unset;flex:0 0 auto;width:17px;height:17px;margin-top:1px;border:1.5px solid ' + t.inputBorder + ';border-radius:' + Math.min(4, fR) + 'px;background:#fff;cursor:pointer;-webkit-appearance:none;appearance:none;}' +
      '.chk input:checked{background:' + t.accent + ';border-color:' + t.accent + ';}' +
      '.chk input:checked::after{content:"";display:block;width:5px;height:9px;margin:1px 0 0 5px;border:solid ' + t.accentText + ';border-width:0 2px 2px 0;transform:rotate(45deg);}' +
      '.chk input:focus-visible{outline:2px solid ' + t.accent + ';outline-offset:2px;}' +
      '.chk label{cursor:pointer;}' +
      '.chk a,.note a{color:inherit;text-decoration:underline;}' +
      '.note{margin:12px 0 0;font-size:12.5px;line-height:1.4;color:' + t.muted + ';text-align:center;}' +
      '.err{margin:8px 0 0;font-size:13px;line-height:1.35;font-weight:600;color:' + t.error + ';min-height:0;}' +
      '.hp{position:absolute;left:-9999px;width:1px;height:1px;opacity:0;}' +
      // успіх
      '.okw{display:flex;flex-direction:column;align-items:center;gap:14px;padding:6px 0 2px;color:' + t.accent + ';}' +
      '.okw .ttl{margin:0;}' +
      '.okw .txt{margin:0;color:' + t.text + ';}' +
      // загальне
      '.x{all:unset;position:absolute;top:-46px;right:-8px;width:36px;height:36px;display:flex;align-items:center;justify-content:center;' +
        'color:#fff;cursor:pointer;border-radius:50%;}' +
      '.x:focus-visible{outline:3px solid #fff;outline-offset:2px;}' +
      '.x svg{display:block;}' +
      '.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;}' +
      '@media (min-width:600px){.x{right:-46px;top:-40px;}.ov{padding:56px 60px 16px;}}' +
      '@media (max-width:380px){.ttl{font-size:' + Math.round(t.titleSize * 0.84) + 'px;}.txt{font-size:15px;}}' +
      '@media (prefers-reduced-motion:reduce){.ov,.box{transition:none;}}';
  }

  function promoBody(cfg) {
    return '<button class="code" type="button" aria-label="' + esc(cfg.copyHint) + ': ' + esc(cfg.code) + '">' +
      '<span class="val">' + esc(cfg.code) + '</span>' +
      '<span class="ico">' + ICON_COPY + '</span>' +
    '</button>';
  }

  function emailBody(cfg) {
    var f = cfg.form;
    var eid = 'pp-err-' + cfg.id;
    var cid = 'pp-chk-' + cfg.id;
    var consent = '';
    if (f.consentText && f.consentMode === 'checkbox') {
      consent = '<div class="chk"><input type="checkbox" id="' + cid + '"' +
        (f.consentChecked ? ' checked' : '') + '>' +
        '<label for="' + cid + '">' + richText(f.consentText) + '</label></div>';
    } else if (f.consentText && f.consentMode === 'notice') {
      consent = '<p class="note">' + richText(f.consentText) + '</p>';
    }
    return '<form class="frm" novalidate>' +
      '<input class="in" type="email" name="email" inputmode="email" autocomplete="email" ' +
        'spellcheck="false" aria-label="' + esc(f.label) + '" aria-describedby="' + eid + '" ' +
        'placeholder="' + esc(f.placeholder) + '">' +
      '<input class="hp" type="text" name="company" tabindex="-1" autocomplete="off" aria-hidden="true">' +
      '<button class="btn" type="submit">' + esc(f.button) + '</button>' +
      consent +
      '<p class="err" id="' + eid + '" role="alert"></p>' +
    '</form>';
  }

  function template(cfg) {
    var tid = 'pp-title-' + cfg.id;
    return '' +
      '<div class="ov" part="overlay">' +
        '<div class="box" role="dialog" aria-modal="true" tabindex="-1" aria-labelledby="' + tid + '">' +
          '<button class="x" type="button" aria-label="' + esc(cfg.closeLabel) + '">' + ICON_CLOSE + '</button>' +
          '<div class="main">' +
            (cfg.title ? '<h2 class="ttl" id="' + tid + '">' + richText(cfg.title) + '</h2>' : '') +
            (cfg.text ? '<p class="txt">' + richText(cfg.text) + '</p>' : '') +
            (cfg.mode === 'email' ? emailBody(cfg) : promoBody(cfg)) +
          '</div>' +
          '<span class="sr" aria-live="polite"></span>' +
        '</div>' +
      '</div>';
  }

  /* ---------- попап ---------- */

  function Popup(cfg) {
    this.cfg = cfg;
    this.st = store(cfg);
    this.shown = false;
    this.host = null;
  }

  Popup.prototype.show = function () {
    if (this.shown) return;
    this.shown = true;
    var self = this, cfg = this.cfg;

    if (cfg.theme.fontUrl && !d.querySelector('link[data-promo-font]')) {
      var l = d.createElement('link');
      l.rel = 'stylesheet';
      l.href = cfg.theme.fontUrl;
      l.setAttribute('data-promo-font', '');
      d.head.appendChild(l);
    }

    this.prevFocus = d.activeElement;
    this.shownAt = Date.now();
    var host = this.host = d.createElement('div');
    host.setAttribute('data-promo-popup', cfg.id);
    var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
    root.innerHTML = '<style>' + css(cfg.theme) + '</style>' + template(cfg);
    d.body.appendChild(host);

    this.root = root;
    this.ov = root.querySelector('.ov');
    this.live = root.querySelector('.sr');

    root.querySelector('.x').addEventListener('click', function () { self.close('button'); });
    this.ov.addEventListener('click', function (e) { if (cfg.closeOnOverlay && e.target === self.ov) self.close('overlay'); });

    if (cfg.mode === 'email') this.bindForm();
    else {
      this.codeBtn = root.querySelector('.code');
      this.codeBtn.addEventListener('click', function () { self.copy(); });
    }

    this.onKey = function (e) {
      if (e.key === 'Escape') return self.close('esc');
      if (e.key === 'Tab') self.trapFocus(e);
    };
    d.addEventListener('keydown', this.onKey, true);

    var s = this.st.get();
    s.views = (s.views || 0) + 1;
    s.lastViewAt = Date.now();
    this.st.set(s);

    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        self.ov.classList.add('on');
        var box = self.root.querySelector('.box');
        try { box.focus({ preventScroll: true }); } catch (e) { box.focus(); }
      });
    });
    pushDL(cfg, 'view', cfg.mode === 'email' ? { cart_items: readCart(cfg).length } : null);
    log('показано', cfg.id);
  };

  Popup.prototype.trapFocus = function (e) {
    var f = this.root.querySelectorAll('button, input:not(.hp), a[href]');
    if (!f.length) return;
    var first = f[0], last = f[f.length - 1];
    var active = this.root.activeElement;
    if (e.shiftKey && (active === first || !active)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (active === last || !active)) { e.preventDefault(); first.focus(); }
  };

  /* --- режим promo --- */

  Popup.prototype.copy = function () {
    var self = this, cfg = this.cfg, btn = this.codeBtn, val = btn.querySelector('.val');
    copyText(cfg.code).then(function (ok) {
      if (ok) {
        var s = self.st.get();
        s.copiedAt = Date.now();
        self.st.set(s);
        btn.classList.add('ok');
        val.textContent = cfg.copiedText;
        self.live.textContent = cfg.copiedText;
        clearTimeout(self.t);
        self.t = setTimeout(function () {
          btn.classList.remove('ok');
          val.textContent = cfg.code;
        }, 2000);
        pushDL(cfg, 'copy', { promo_code: cfg.code });
        log('скопійовано', cfg.code);
      } else {
        try {
          var r = d.createRange();
          r.selectNodeContents(val);
          var sel = w.getSelection();
          sel.removeAllRanges();
          sel.addRange(r);
        } catch (e) {}
        log('копіювання не вдалось, код виділено');
      }
    });
  };

  /* --- режим email --- */

  Popup.prototype.bindForm = function () {
    var self = this;
    this.form = this.root.querySelector('.frm');
    this.input = this.root.querySelector('.in');
    this.btn = this.root.querySelector('.btn');
    this.hp = this.root.querySelector('.hp');
    this.chk = this.root.querySelector('.chk input');
    this.err = this.root.querySelector('.err');

    this.form.addEventListener('submit', function (e) {
      e.preventDefault();
      self.submit();
    });
    this.input.addEventListener('input', function () {
      self.input.setAttribute('aria-invalid', 'false');
      self.err.textContent = '';
    });
  };

  Popup.prototype.fail = function (msg, invalidInput) {
    this.err.textContent = msg;
    if (invalidInput) {
      this.input.setAttribute('aria-invalid', 'true');
      try { this.input.focus(); } catch (e) {}
    }
    this.btn.removeAttribute('disabled');
    this.btn.textContent = this.cfg.form.button;
  };

  Popup.prototype.submit = function () {
    var self = this, cfg = this.cfg, f = cfg.form;
    if (this.sending) return;

    var email = validEmail(this.input.value);
    if (!email) return this.fail(f.errorEmail, true);
    if (this.chk && !this.chk.checked) return this.fail(f.errorConsent);

    // приманка для ботів + надто швидкий сабміт
    var tooFast = Date.now() - this.shownAt < cfg.submit.minSeconds * 1000;
    if (this.hp.value || tooFast) {
      log('відкинуто: ' + (this.hp.value ? 'honeypot' : 'надто швидко'));
      return this.success(true);   // боту показуємо «успіх», нічого не відправляючи
    }

    this.sending = true;
    this.err.textContent = '';
    this.btn.setAttribute('disabled', 'disabled');
    this.btn.textContent = f.buttonSending;

    var payload = {
      token: cfg.submit.token,
      type: cfg.submit.type,
      popup: cfg.id,
      email: email,
      cid: clientId(),
      items: readCart(cfg),
      page: w.location.pathname + w.location.search,
      consent: this.chk ? true : (f.consentMode === 'notice'),
      ms: Date.now() - this.shownAt,
      ts: Date.now()
    };

    postJson(cfg.submit.endpoint, payload).then(function (res) {
      self.sending = false;
      if (res.ok) {
        pushDL(cfg, 'submit', { cart_items: payload.items.length });
        return self.success();
      }
      if (cfg.submit.retry) queueAdd(payload);
      pushDL(cfg, 'error', { reason: String(res.body).slice(0, 80) });
      log('помилка відправки', res.body);
      self.fail(f.errorSend);
    });
  };

  Popup.prototype.success = function (silent) {
    var self = this, cfg = this.cfg, f = cfg.form;
    if (!silent) {
      var s = this.st.get();
      s.submittedAt = Date.now();
      this.st.set(s);
    }
    var main = this.root.querySelector('.main');
    main.innerHTML = '<div class="okw">' +
      ICON_OK +
      '<h2 class="ttl">' + richText(f.successTitle) + '</h2>' +
      '<p class="txt">' + richText(f.successText) + '</p>' +
    '</div>';
    this.live.textContent = f.successTitle + '. ' + f.successText;
    try { this.root.querySelector('.box').focus({ preventScroll: true }); } catch (e) {}
    if (f.successCloseSec > 0) {
      setTimeout(function () { self.close('success'); }, f.successCloseSec * 1000);
    }
    log('успішно надіслано');
  };

  /* --- закриття --- */

  Popup.prototype.close = function (how) {
    if (!this.host) return;
    var self = this, host = this.host;
    this.host = null;
    var s = this.st.get();
    if (how !== 'success') s.closedAt = Date.now();
    this.st.set(s);
    d.removeEventListener('keydown', this.onKey, true);
    this.ov.classList.remove('on');
    setTimeout(function () { if (host.parentNode) host.parentNode.removeChild(host); }, 260);
    if (this.prevFocus && this.prevFocus.focus) { try { this.prevFocus.focus({ preventScroll: true }); } catch (e) {} }
    if (how !== 'success') pushDL(this.cfg, 'close', { how: how || '' });
    log('закрито', how || '');
  };

  /* ---------- тригери ---------- */

  function arm(popup) {
    var cfg = popup.cfg, fired = false, timer, idle;

    function fire(src) {
      if (fired) return;
      fired = true;
      clearTimeout(timer);
      clearTimeout(idle);
      w.removeEventListener('scroll', onScroll);
      d.removeEventListener('mouseout', onOut);
      ACTIVITY.forEach(function (ev) { d.removeEventListener(ev, bumpIdle, true); });
      log('тригер:', src || 'delay');
      popup.show();
    }

    function onScroll() {
      var h = d.documentElement.scrollHeight - w.innerHeight;
      if (h <= 0) return;
      if ((w.pageYOffset / h) * 100 >= cfg.scrollPercent) fire('scroll');
    }

    function onOut(e) {
      if (e.clientY <= 0 && !e.relatedTarget && !e.toElement) fire('exit');
    }

    var ACTIVITY = ['mousemove', 'keydown', 'scroll', 'touchstart', 'click'];
    function bumpIdle() {
      clearTimeout(idle);
      idle = setTimeout(function () { fire('idle'); }, cfg.inactivitySec * 1000);
    }

    if (DEBUG) return fire('debug');
    if (typeof cfg.delaySec === 'number' && cfg.delaySec >= 0) timer = setTimeout(function () { fire('delay'); }, cfg.delaySec * 1000);
    if (cfg.scrollPercent > 0) w.addEventListener('scroll', onScroll, { passive: true });
    if (cfg.exitIntent && !('ontouchstart' in w)) d.addEventListener('mouseout', onOut);
    if (cfg.inactivitySec > 0) {
      ACTIVITY.forEach(function (ev) { d.addEventListener(ev, bumpIdle, true); });
      bumpIdle();
    }
  }

  // Сторінка відкрилась без кошика — чекаємо, поки тег GTM запише товар
  function watchCart(cfg, popup) {
    var left = Math.ceil(cfg.cart.watchMinutes * 30);   // перевірка кожні 2 с
    log('кошик порожній — чекаємо', cfg.cart.watchMinutes, 'хв');
    var t = setInterval(function () {
      if (readCart(cfg).length) { clearInterval(t); log('товар додано'); arm(popup); }
      else if (--left <= 0) { clearInterval(t); log('кошик так і не зʼявився'); }
    }, 2000);
  }

  // autoShow:false — тег GTM спрацював і кошик може з'явитися за мить: чекаємо до waitSec
  function whenCart(cfg, ok, fail) {
    if (DEBUG || cfg.mode !== 'email' || !cfg.cart.required || readCart(cfg).length) return ok();
    var left = Math.ceil(cfg.cart.waitSec * 5);          // перевірка кожні 200 мс
    var t = setInterval(function () {
      if (readCart(cfg).length) { clearInterval(t); ok(); }
      else if (--left <= 0) { clearInterval(t); skip(cfg, 'empty_cart'); fail(); }
    }, 200);
  }

  /* ---------- старт ---------- */

  var flushed = false;

  function init(userCfg) {
    // тег GTM може спрацьовувати багато разів: поки попап на очікуванні чи на екрані — нічого не робимо
    if (api.current && (api.current.pending || (api.current.shown && api.current.host))) {
      log('попап уже активний');
      return api.current;
    }
    var cfg = merge(DEFAULTS, userCfg || {});
    var st = store(cfg);
    if (hasParam('promo_reset')) { st.clear(); ls(QUEUE_KEY).clear(); log('історію очищено'); }
    if (cfg.mode === 'email' && cfg.submit.retry && !flushed) { flushed = true; queueFlush(cfg); }  // дотягуємо невдалі сабміти
    if (!canShow(cfg, st, true)) return null;      // кошик перевіряють whenCart / watchCart
    var p = new Popup(cfg);
    var start = function () {
      if (!cfg.autoShow) {
        p.pending = true;
        return whenCart(cfg,
          function () { p.pending = false; p.show(); },
          function () { p.pending = false; });
      }
      if (!DEBUG && cfg.mode === 'email' && cfg.cart.required && !readCart(cfg).length) return watchCart(cfg, p);
      arm(p);
    };
    if (d.readyState === 'loading') d.addEventListener('DOMContentLoaded', start);
    else start();
    api.current = p;
    return p;
  }

  var api = w.PromoPopup = {
    __loaded: true,
    version: VERSION,
    init: init,
    current: null,
    show: function () { if (api.current) api.current.show(); },
    cart: function () { return api.current ? readCart(api.current.cfg) : []; }
  };

  if (w.PromoPopupConfig) init(w.PromoPopupConfig);
})(window, document);
