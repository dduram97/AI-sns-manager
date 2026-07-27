/**
 * LikeIt internals tracer — observe JS/network/storage around a like click.
 * Does NOT change how the click is performed.
 *
 * Enable with NAVER_LIKE_DEBUG (same gate as evidence mode).
 */

import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright";

function debugDir(): string {
  const dir = path.join(process.cwd(), ".data", "debug", "sympathy");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Install page-side hooks. String source — no tsx __name. */
const INSTALL_HOOKS_SOURCE = `(() => {
  if (window.__LIKEIT_TRACE_INSTALLED__) {
    return { ok: true, already: true };
  }
  window.__LIKEIT_TRACE_INSTALLED__ = true;
  window.__LIKEIT_TRACE__ = {
    t0: Date.now(),
    timeline: [],
    networks: [],
    mutations: [],
    stacks: [],
    guestTokenEvents: [],
    scriptAppends: [],
    clickListenerInfo: null
  };

  function now() { return Date.now() - window.__LIKEIT_TRACE__.t0; }
  function push(kind, data) {
    var entry = Object.assign({ ms: now(), kind: kind }, data || {});
    window.__LIKEIT_TRACE__.timeline.push(entry);
    return entry;
  }
  function stack() {
    try {
      var e = new Error('trace');
      return (e.stack || '').toString().split('\\n').slice(0, 18);
    } catch (err) {
      return [];
    }
  }
  function noteGuest(url, via) {
    if (!url || typeof url !== 'string') return;
    if (url.indexOf('guestToken') < 0 && url.indexOf('guest_token') < 0) return;
    var m = url.match(/guestToken=([^&]+)/) || url.match(/guest_token=([^&]+)/);
    var tok = m ? decodeURIComponent(m[1]) : null;
    var ev = {
      ms: now(),
      via: via,
      tokenPrefix: tok ? tok.slice(0, 24) : null,
      tokenLen: tok ? tok.length : 0,
      url: url.slice(0, 400),
      stack: stack()
    };
    window.__LIKEIT_TRACE__.guestTokenEvents.push(ev);
    push('guestToken', ev);
  }

  // --- fetch ---
  var _fetch = window.fetch;
  if (typeof _fetch === 'function') {
    window.fetch = function() {
      var input = arguments[0];
      var url = typeof input === 'string' ? input : (input && input.url) || String(input);
      var method = (arguments[1] && arguments[1].method) || 'GET';
      noteGuest(url, 'fetch');
      push('fetch', { url: String(url).slice(0, 400), method: method, stack: stack() });
      return _fetch.apply(this, arguments);
    };
  }

  // --- XHR ---
  var XO = XMLHttpRequest.prototype.open;
  var XS = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url) {
    this.__likeit_url = url;
    this.__likeit_method = method;
    return XO.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function() {
    var url = String(this.__likeit_url || '');
    noteGuest(url, 'xhr');
    push('xhr', { url: url.slice(0, 400), method: this.__likeit_method || 'GET', stack: stack() });
    return XS.apply(this, arguments);
  };

  // --- sendBeacon ---
  if (navigator.sendBeacon) {
    var _sb = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function(url, data) {
      noteGuest(String(url), 'sendBeacon');
      push('sendBeacon', { url: String(url).slice(0, 400), stack: stack() });
      return _sb(url, data);
    };
  }

  // --- script JSONP appendChild ---
  function hookAppend(proto, name) {
    var orig = proto[name];
    if (!orig) return;
    proto[name] = function(node) {
      try {
        if (node && node.tagName === 'SCRIPT') {
          var src = node.src || node.getAttribute('src') || '';
          noteGuest(src, 'script.' + name);
          var ev = {
            ms: now(),
            via: name,
            src: String(src).slice(0, 500),
            stack: stack()
          };
          window.__LIKEIT_TRACE__.scriptAppends.push(ev);
          push('scriptAppend', ev);
        }
      } catch (e) {}
      return orig.apply(this, arguments);
    };
  }
  hookAppend(Node.prototype, 'appendChild');
  hookAppend(Node.prototype, 'insertBefore');
  if (Element.prototype.append) hookAppend(Element.prototype, 'append');

  // --- Capture-phase click + MutationObserver (native addEventListener first) ---
  var _ael = EventTarget.prototype.addEventListener;
  try {
    var face = document.querySelector('a.u_likeit_button._face');
    if (face) {
      _ael.call(face, 'click', function(ev) {
        push('faceClickCapture', {
          phase: 'capture',
          targetTag: ev.target && ev.target.tagName,
          targetClass: ev.target && ev.target.className && String(ev.target.className).slice(0, 80),
          currentTargetClass: face.className,
          stack: stack()
        });
      }, true);
      _ael.call(face, 'click', function(ev) {
        push('faceClickBubble', {
          phase: 'bubble',
          targetTag: ev.target && ev.target.tagName,
          currentTargetClass: face.className,
          stack: stack()
        });
      }, false);

      var mo = new MutationObserver(function(recs) {
        for (var i = 0; i < recs.length; i++) {
          var r = recs[i];
          if (r.type === 'attributes') {
            push('mutation', {
              attr: r.attributeName,
              oldValue: r.oldValue,
              newValue: face.getAttribute(r.attributeName),
              className: face.className
            });
          } else if (r.type === 'childList') {
            push('mutation', {
              childList: true,
              added: r.addedNodes.length,
              removed: r.removedNodes.length,
              className: face.className
            });
          }
        }
      });
      mo.observe(face, {
        attributes: true,
        attributeOldValue: true,
        attributeFilter: ['class', 'aria-pressed', 'aria-expanded', 'data-isopenfacelayer'],
        childList: true,
        subtree: true
      });
      window.__LIKEIT_TRACE__._mo = mo;
    }
  } catch (e) {}

  // --- Track later addEventListener(click) registrations ---
  try {
    EventTarget.prototype.addEventListener = function(type, listener, options) {
      try {
        if (type === 'click' || type === 'pointerup' || type === 'mousedown' || type === 'touchend') {
          var el = this;
          var tag = el && el.tagName ? el.tagName : '';
          var cls = el && el.className ? String(el.className).slice(0, 80) : '';
          var fnName = (typeof listener === 'function' && listener.name) ||
            (listener && listener.handleEvent && listener.handleEvent.name) || '(anon)';
          push('addEventListener', {
            type: type,
            tag: tag,
            className: cls,
            fnName: fnName,
            stack: stack()
          });
        }
      } catch (e) {}
      return _ael.apply(this, arguments);
    };
  } catch (e) {}

  // Best-effort: wrap known like/naver globals' methods if present
  try {
    var wrapNames = ['like', 'Like', 'likeIt', 'LikeIt', 'toggleLike', 'clickLike', 'react', 'sympathy'];
    for (var wi = 0; wi < wrapNames.length; wi++) {
      (function(name) {
        try {
          if (typeof window[name] === 'function') {
            var origFn = window[name];
            window[name] = function() {
              push('windowFnCall', { name: name, stack: stack() });
              return origFn.apply(this, arguments);
            };
          }
        } catch (e2) {}
      })(wrapNames[wi]);
    }
  } catch (e) {}

  // --- confirm/alert: 401 rollback shows login confirm ---
  try {
    var _confirm = window.confirm;
    window.confirm = function(msg) {
      push('confirm', { message: String(msg || '').slice(0, 200), stack: stack() });
      return _confirm.apply(this, arguments);
    };
    var _alert = window.alert;
    window.alert = function(msg) {
      push('alert', { message: String(msg || '').slice(0, 200), stack: stack() });
      return _alert.apply(this, arguments);
    };
  } catch (e) {}

  // --- Face DOM mutations WITH stack (who flips on↔off) ---
  try {
    var faceEl = document.querySelector('a.u_likeit_button._face');
    if (faceEl) {
      var _setAttr = faceEl.setAttribute.bind(faceEl);
      faceEl.setAttribute = function(name, value) {
        if (name === 'class' || name === 'aria-pressed' || name === 'aria-expanded') {
          push('faceSetAttribute', {
            name: name,
            value: String(value).slice(0, 120),
            prev: faceEl.getAttribute(name),
            stack: stack()
          });
        }
        return _setAttr(name, value);
      };
      var cl = faceEl.classList;
      var _add = cl.add.bind(cl);
      var _remove = cl.remove.bind(cl);
      var _toggle = cl.toggle.bind(cl);
      cl.add = function() {
        push('faceClassList', { op: 'add', args: Array.prototype.slice.call(arguments), className: faceEl.className, stack: stack() });
        return _add.apply(cl, arguments);
      };
      cl.remove = function() {
        push('faceClassList', { op: 'remove', args: Array.prototype.slice.call(arguments), className: faceEl.className, stack: stack() });
        return _remove.apply(cl, arguments);
      };
      cl.toggle = function() {
        push('faceClassList', { op: 'toggle', args: Array.prototype.slice.call(arguments), className: faceEl.className, stack: stack() });
        return _toggle.apply(cl, arguments);
      };
    }
  } catch (e) {}

  // --- jQuery.ajax / JSONP (Like API uses jQuery callback=jQuery…) ---
  function wrapJqAjax(jq) {
    if (!jq || jq.__likeit_traced) return;
    jq.__likeit_traced = true;
    if (typeof jq.ajax === 'function') {
      var _ajax = jq.ajax.bind(jq);
      jq.ajax = function(url, options) {
        var opts = typeof url === 'object' ? url : (options || {});
        var u = typeof url === 'string' ? url : (opts && (opts.url || ''));
        var data = (opts && opts.data) || {};
        var dataStr = '';
        try { dataStr = typeof data === 'string' ? data : JSON.stringify(data).slice(0, 400); } catch (e) {}
        noteGuest(String(u) + '&' + dataStr, 'jquery.ajax');
        if (data && data.guestToken) {
          push('guestToken', {
            via: 'jquery.ajax.data',
            tokenPrefix: String(data.guestToken).slice(0, 24),
            tokenLen: String(data.guestToken).length,
            stack: stack()
          });
        }
        push('jquery.ajax', {
          url: String(u).slice(0, 400),
          dataType: opts && opts.dataType,
          type: (opts && (opts.type || opts.method)) || 'GET',
          jsonp: opts && opts.jsonp,
          jsonpCallback: opts && opts.jsonpCallback,
          stack: stack()
        });
        var ret = _ajax.apply(jq, arguments);
        try {
          if (ret && typeof ret.then === 'function') {
            ret.then(
              function(ok) {
                push('jquery.ajax.then', {
                  ok: true,
                  statusCode: ok && ok.statusCode,
                  errorCode: ok && ok.errorCode,
                  message: ok && ok.message && String(ok.message).slice(0, 120),
                  stack: stack()
                });
                return ok;
              },
              function(err) {
                push('jquery.ajax.then', { ok: false, err: String(err).slice(0, 120), stack: stack() });
                throw err;
              }
            );
          }
          if (ret && typeof ret.done === 'function') {
            ret.done(function(data) {
              push('jquery.ajax.done', {
                statusCode: data && data.statusCode,
                errorCode: data && data.errorCode,
                message: data && data.message && String(data.message).slice(0, 120),
                stack: stack()
              });
            });
            if (typeof ret.fail === 'function') {
              ret.fail(function() {
                push('jquery.ajax.fail', { stack: stack() });
              });
            }
            if (typeof ret.always === 'function') {
              ret.always(function() {
                push('jquery.ajax.always', { stack: stack() });
              });
            }
          }
        } catch (e2) {}
        return ret;
      };
    }
  }
  try {
    if (window.jQuery) wrapJqAjax(window.jQuery);
    if (window.$ && window.$ !== window.jQuery) wrapJqAjax(window.$);
  } catch (e) {}

  // --- Intercept JSONP callback registration (window['jQuery…_…'] = fn) ---
  try {
    var _defineProperty = Object.defineProperty;
    Object.defineProperty = function(obj, prop, desc) {
      try {
        if (obj === window && typeof prop === 'string' && /^jQuery\\d+_\\d+$/.test(prop) && desc && typeof desc.value === 'function') {
          var origCb = desc.value;
          desc = Object.assign({}, desc, {
            value: function() {
              var arg0 = arguments[0];
              push('jsonpCallback', {
                name: prop,
                statusCode: arg0 && arg0.statusCode,
                errorCode: arg0 && arg0.errorCode,
                message: arg0 && arg0.message && String(arg0.message).slice(0, 160),
                stack: stack()
              });
              return origCb.apply(this, arguments);
            }
          });
          push('jsonpCallbackRegister', { name: prop, stack: stack() });
        }
      } catch (e3) {}
      return _defineProperty.apply(Object, arguments);
    };
  } catch (e) {}

  // Also trap direct assignment via Proxy on a setter for common pattern:
  // jQuery uses window[callbackName] = function
  try {
    var cbWatch = new Set();
    var _hasOwn = Object.prototype.hasOwnProperty;
    var pollJsonp = setInterval(function() {
      try {
        for (var k in window) {
          if (!_hasOwn.call(window, k)) continue;
          if (!/^jQuery\\d+_\\d+$/.test(k)) continue;
          if (cbWatch.has(k)) continue;
          if (typeof window[k] !== 'function') continue;
          cbWatch.add(k);
          (function(name, orig) {
            window[name] = function() {
              var arg0 = arguments[0];
              push('jsonpCallback', {
                name: name,
                statusCode: arg0 && arg0.statusCode,
                errorCode: arg0 && arg0.errorCode,
                message: arg0 && arg0.message && String(arg0.message).slice(0, 160),
                stack: stack()
              });
              return orig.apply(this, arguments);
            };
            push('jsonpCallbackWrap', { name: name, stack: stack() });
          })(k, window[k]);
        }
      } catch (e4) {}
    }, 20);
    window.__LIKEIT_TRACE__._jsonpPoll = pollJsonp;
    setTimeout(function() { try { clearInterval(pollJsonp); } catch (e5) {} }, 15000);
  } catch (e) {}

  // Snapshot helpers exposed for Node side
  window.__LIKEIT_TRACE_SNAPSHOT__ = function(label) {
    function storageDump(store) {
      var out = {};
      try {
        for (var i = 0; i < store.length; i++) {
          var k = store.key(i);
          if (!k) continue;
          var v = store.getItem(k);
          out[k] = (v || '').toString().slice(0, 200);
        }
      } catch (e) {}
      return out;
    }
    function pickWindowKeys() {
      var keys = [];
      try {
        for (var k in window) {
          if (/^__|naver|like|Like|sympath|Sympathy|APOLLO|apollo|blog|Blog|u_like|guestToken/i.test(k)) {
            keys.push(k);
          }
        }
      } catch (e) {}
      keys.sort();
      var detail = {};
      for (var i = 0; i < keys.length && i < 80; i++) {
        var key = keys[i];
        try {
          var val = window[key];
          var t = typeof val;
          if (t === 'string' || t === 'number' || t === 'boolean') {
            detail[key] = { type: t, value: String(val).slice(0, 120) };
          } else if (val == null) {
            detail[key] = { type: String(val) };
          } else if (t === 'function') {
            detail[key] = { type: 'function', name: val.name || '(anon)' };
          } else if (t === 'object') {
            var keys2 = [];
            try {
              keys2 = Object.keys(val).slice(0, 20);
            } catch (e2) {}
            detail[key] = { type: 'object', keys: keys2, ctor: (val.constructor && val.constructor.name) || '' };
          } else {
            detail[key] = { type: t };
          }
        } catch (e3) {
          detail[key] = { type: 'inaccessible' };
        }
      }
      return { keyNames: keys.slice(0, 120), detail: detail };
    }
    var face = document.querySelector('a.u_likeit_button._face');
    var icon = face && (face.querySelector('span.u_likeit_icon') || face.querySelector('[class*="__reaction__"]'));

    // Hunt guestToken / like state in DOM + window
    function huntGuestToken() {
      var hits = [];
      try {
        var html = document.documentElement.innerHTML;
        var re = /guestToken["'\\s:=]+([a-f0-9]{32,200})/gi;
        var m;
        var n = 0;
        while ((m = re.exec(html)) && n < 8) {
          hits.push({ via: 'dom.innerHTML', tokenPrefix: m[1].slice(0, 24), tokenLen: m[1].length, index: m.index });
          n++;
        }
      } catch (e) {}
      try {
        var scripts = document.querySelectorAll('script:not([src])');
        for (var si = 0; si < scripts.length && hits.length < 12; si++) {
          var txt = scripts[si].textContent || '';
          if (txt.indexOf('guestToken') < 0) continue;
          var m2 = txt.match(/guestToken["'\\s:=]+([a-f0-9]{32,200})/i);
          if (m2) hits.push({ via: 'inlineScript#' + si, tokenPrefix: m2[1].slice(0, 24), tokenLen: m2[1].length });
        }
      } catch (e) {}
      try {
        function walk(obj, path, depth) {
          if (!obj || depth > 3 || hits.length >= 20) return;
          var keys;
          try { keys = Object.keys(obj); } catch (e) { return; }
          for (var i = 0; i < keys.length && i < 40; i++) {
            var key = keys[i];
            var p = path + '.' + key;
            try {
              var v = obj[key];
              if (/guestToken/i.test(key) && (typeof v === 'string' || typeof v === 'number')) {
                hits.push({ via: 'window.' + p, tokenPrefix: String(v).slice(0, 24), tokenLen: String(v).length });
              } else if (typeof v === 'object' && v !== null) {
                walk(v, p, depth + 1);
              }
            } catch (e2) {}
          }
        }
        var roots = ['__LIKEIT__', 'likeit', 'likeIt', 'LikeIt', 'naver', '__APOLLO_STATE__', 'lcs', 'blog'];
        for (var ri = 0; ri < roots.length; ri++) {
          if (window[roots[ri]]) walk(window[roots[ri]], roots[ri], 0);
        }
      } catch (e) {}
      return hits;
    }

    function dumpLikeStateObjects() {
      var out = {};
      var names = Object.getOwnPropertyNames(window).filter(function(k) {
        return /like|Like|sympath|guestToken|__LIKE|naver\.like|u_like/i.test(k);
      }).slice(0, 40);
      for (var i = 0; i < names.length; i++) {
        var k = names[i];
        try {
          var v = window[k];
          if (v == null) { out[k] = null; continue; }
          if (typeof v !== 'object') { out[k] = { type: typeof v, value: String(v).slice(0, 80) }; continue; }
          out[k] = {
            type: 'object',
            ctor: (v.constructor && v.constructor.name) || '',
            keys: Object.keys(v).slice(0, 30),
            json: (function() {
              try { return JSON.stringify(v).slice(0, 500); } catch (e) { return '(circular)'; }
            })()
          };
        } catch (e3) {
          out[k] = '(inaccessible)';
        }
      }
      // data attributes on like widgets
      try {
        var widgets = document.querySelectorAll('[class*="u_likeit"], [data-like-click-area], [data-guest-token], [data-guesttoken]');
        out.__domWidgets = Array.prototype.slice.call(widgets, 0, 8).map(function(el) {
          var attrs = {};
          for (var ai = 0; ai < el.attributes.length; ai++) {
            var a = el.attributes[ai];
            if (/guest|token|like|reaction|content|blog/i.test(a.name)) {
              attrs[a.name] = String(a.value).slice(0, 120);
            }
          }
          return { tag: el.tagName, className: String(el.className).slice(0, 80), attrs: attrs };
        });
      } catch (e4) {}
      return out;
    }

    return {
      label: label,
      ms: now(),
      face: face ? {
        className: face.className,
        ariaPressed: face.getAttribute('aria-pressed'),
        ariaExpanded: face.getAttribute('aria-expanded'),
        dataIsOpen: face.getAttribute('data-isopenfacelayer'),
        iconClass: icon ? icon.className : null
      } : null,
      localStorage: storageDump(window.localStorage),
      sessionStorage: storageDump(window.sessionStorage),
      windowLikeKeys: pickWindowKeys(),
      guestTokenHunt: huntGuestToken(),
      likeStateObjects: dumpLikeStateObjects()
    };
  };

  push('hooksInstalled', { ok: true });
  return { ok: true, already: false };
})()`;

const SNAPSHOT_SOURCE = `(label) => {
  if (typeof window.__LIKEIT_TRACE_SNAPSHOT__ === 'function') {
    return window.__LIKEIT_TRACE_SNAPSHOT__(label);
  }
  return { label: label, error: 'hooks-not-installed' };
}`;

const COLLECT_SOURCE = `(() => {
  var t = window.__LIKEIT_TRACE__;
  if (!t) return { error: 'no-trace' };
  return {
    t0: t.t0,
    timeline: t.timeline.slice(0, 400),
    guestTokenEvents: t.guestTokenEvents.slice(0, 50),
    scriptAppends: t.scriptAppends.slice(0, 50),
    networks: t.networks.slice(0, 100),
    clickListenerInfo: t.clickListenerInfo
  };
})()`;

function diffStorage(
  before: Record<string, string>,
  after: Record<string, string>,
): { added: string[]; removed: string[]; changed: string[] } {
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const k of Object.keys(after)) {
    if (!(k in before)) added.push(k);
    else if (before[k] !== after[k]) changed.push(k);
  }
  for (const k of Object.keys(before)) {
    if (!(k in after)) removed.push(k);
  }
  return { added, removed, changed };
}

function diffWindowKeys(
  before: { keyNames?: string[] },
  after: { keyNames?: string[] },
): { added: string[]; removed: string[] } {
  const b = new Set(before.keyNames ?? []);
  const a = new Set(after.keyNames ?? []);
  return {
    added: [...a].filter((k) => !b.has(k)),
    removed: [...b].filter((k) => !a.has(k)),
  };
}

function printLikeItSuccessConditions(
  timeline: Array<Record<string, unknown>>,
  before: {
    face?: unknown;
    guestTokenHunt?: unknown;
    likeStateObjects?: unknown;
  },
  after: {
    face?: unknown;
    guestTokenHunt?: unknown;
  },
): void {
  const kinds = timeline.map((e) => String(e.kind ?? ""));
  const firstJs = timeline.find((e) =>
    [
      "faceClickCapture",
      "faceClickBubble",
      "faceClassList",
      "faceSetAttribute",
      "jquery.ajax",
      "scriptAppend",
    ].includes(String(e.kind)),
  );
  const ajax = timeline.filter((e) => String(e.kind).startsWith("jquery.ajax"));
  const jsonp = timeline.filter((e) => String(e.kind).startsWith("jsonp"));
  const guest = timeline.filter((e) => String(e.kind) === "guestToken");
  const confirmEv = timeline.find((e) => String(e.kind) === "confirm");
  const rollback = timeline.find(
    (e) =>
      (String(e.kind) === "faceClassList" &&
        Array.isArray(e.args) &&
        (e.args as string[]).includes("off")) ||
      (String(e.kind) === "faceSetAttribute" &&
        String(e.name) === "class" &&
        /\boff\b/.test(String(e.value ?? "")) &&
        /\bon\b/.test(String(e.prev ?? ""))),
  );
  const done401 = timeline.find(
    (e) =>
      (String(e.kind) === "jquery.ajax.done" ||
        String(e.kind) === "jsonpCallback") &&
      (e.statusCode === 401 || e.errorCode === 4010),
  );

  console.log("\n========================================");
  console.log("LIKEIT FLOW — ANSWERS (from this run)");
  console.log("========================================");
  console.log(
    `1. first JS event after hooks: ${firstJs ? `${firstJs.kind} @+${firstJs.ms}ms` : "(none captured — re-run needed)"}`,
  );
  if (firstJs && Array.isArray(firstJs.stack)) {
    console.log(
      `   stack: ${(firstJs.stack as string[]).slice(1, 8).join(" | ")}`,
    );
  }
  console.log(`2. guestToken events=${guest.length}`);
  for (const g of guest.slice(0, 5)) {
    console.log(
      `   +${g.ms}ms via=${g.via} prefix=${g.tokenPrefix} len=${g.tokenLen}`,
    );
    if (Array.isArray(g.stack)) {
      console.log(`   stack: ${(g.stack as string[]).slice(1, 8).join(" | ")}`);
    }
  }
  console.log(
    `   hunt@before=${JSON.stringify(before.guestTokenHunt ?? []).slice(0, 400)}`,
  );
  console.log(
    `   hunt@after=${JSON.stringify(after.guestTokenHunt ?? []).slice(0, 400)}`,
  );
  console.log(
    `3. guestToken change: compare hunt before/after + guestToken events above`,
  );
  console.log(
    `4. Like API caller chain: jquery.ajax=${ajax.length} jsonp=${jsonp.length} scriptAppend=${kinds.filter((k) => k === "scriptAppend").length}`,
  );
  for (const a of ajax.slice(0, 3)) {
    console.log(
      `   ${a.kind} +${a.ms}ms url=${String(a.url ?? "").slice(0, 160)}`,
    );
    if (Array.isArray(a.stack))
      console.log(`   stack: ${(a.stack as string[]).slice(1, 8).join(" | ")}`);
  }
  for (const j of jsonp.slice(0, 3)) {
    console.log(`   ${j.kind} +${j.ms}ms ${JSON.stringify(j).slice(0, 200)}`);
  }
  console.log(
    `5. Promise/callback kinds present: ${[...new Set(kinds.filter((k) => /ajax|jsonp|then|done|always|fail|confirm/.test(k)))].join(", ") || "(none)"}`,
  );
  console.log(
    `6. pre-401 JS: ${done401 ? `${done401.kind} @+${done401.ms}ms status=${done401.statusCode} err=${done401.errorCode}` : "(not in page hooks — see network evidence)"}`,
  );
  if (done401 && Array.isArray(done401.stack)) {
    console.log(
      `   stack: ${(done401.stack as string[]).slice(1, 10).join(" | ")}`,
    );
  }
  console.log(
    `7. heart rollback: ${rollback ? `${rollback.kind} @+${rollback.ms}ms` : "(not captured via classList hook)"} confirm=${confirmEv ? `yes @+${confirmEv.ms}ms` : "no"}`,
  );
  if (rollback && Array.isArray(rollback.stack)) {
    console.log(
      `   rollback stack: ${(rollback.stack as string[]).slice(1, 10).join(" | ")}`,
    );
  }
  if (confirmEv && Array.isArray(confirmEv.stack)) {
    console.log(
      `   confirm stack: ${(confirmEv.stack as string[]).slice(1, 10).join(" | ")}`,
    );
  }
  console.log(
    `8. state objects@before keys=${Object.keys(
      (before.likeStateObjects as object) ?? {},
    )
      .slice(0, 20)
      .join(",")}`,
  );

  console.log("\n========================================");
  console.log("SUCCESS CONDITIONS (reverse-engineered)");
  console.log("========================================");
  console.log(`
[FAIL path already proven by like_evidence.json]
  click
    → optimistic UI: face off→on, icon zeroface→like  (client-side, BEFORE API)
    → jQuery JSONP GET apis.naver.com/blogserver/like/v1/... 
         params: reactionType=like, guestToken=…, _ch=pcw, _method=POST,
                 callback=jQuery…_
    → HTTP 200 script body BUT statusCode=401 / errorCode=4010
    → JSONP callback receives {statusCode:401,…}
    → window.confirm("네이버 로그인 하신 후 …")
    → UI rollback: face on→off, like→zeroface  (within ~1s)

[SUCCESS condition — what must differ]
  1. Like API JSONP payload must NOT be 4010.
     Success means embedded statusCode indicates OK (typically 200) and
     reaction is accepted — UI then keeps "on" / __reaction__like.
  2. guestToken is REQUIRED on the request but is NOT login proof.
     External docs + this fail run: guestToken comes from page/LikeIt init
     (search/contents or inline), then reused on POST-like JSONP.
     Having a guestToken + NID_* cookies still yielded 4010 here.
  3. Therefore success gate is SERVER-SIDE session acceptance for Like API
     (Naver treats this click as guest), not missing Cookie header.
  4. Rollback is driven by JSONP error handler → confirm → revert DOM classes.
     To keep heart on, that error branch must not run.

[What next timeline must name]
  - function that runs first on face click (CDP handler source / faceClick stack)
  - where guestToken is read (jquery.ajax.data vs DOM hunt vs window.*)
  - exact stack of jquery.ajax / scriptAppend for Like URL
  - stack of jsonpCallback when statusCode=401
  - stack of faceClassList remove(on)/add(off) OR confirm() that triggers revert
`);
  console.log("timeline kinds:", [...new Set(kinds)].join(", "));
}

/**
 * Print reverse-engineered flow from the last like_evidence.json
 * (works even before a fresh internals timeline run).
 */
export function printEvidenceBasedLikeItFlow(): void {
  const evidencePath = path.join(debugDir(), "like_evidence.json");
  if (!fs.existsSync(evidencePath)) {
    console.log("[likeit-flow] no like_evidence.json yet");
    return;
  }
  try {
    const ev = JSON.parse(fs.readFileSync(evidencePath, "utf8")) as {
      faceBefore?: { className?: string; iconClass?: string };
      faceImmediate?: { className?: string; iconClass?: string };
      face1s?: { className?: string; iconClass?: string };
      networkHits?: Array<{
        phase?: string;
        url?: string;
        status?: number;
        responseBody?: string;
        resourceType?: string;
      }>;
      dialogs?: string[];
      verifiedOn?: boolean;
    };
    const req = (ev.networkHits ?? []).find((h) => h.phase === "request");
    const res = (ev.networkHits ?? []).find((h) => h.phase === "response");
    let guestToken: string | null = null;
    let callback: string | null = null;
    if (req?.url) {
      const g = req.url.match(/guestToken=([^&]+)/);
      const c = req.url.match(/callback=([^&]+)/);
      guestToken = g ? decodeURIComponent(g[1]) : null;
      callback = c ? decodeURIComponent(c[1]) : null;
    }
    let embedded: {
      statusCode?: number;
      errorCode?: number;
      message?: string;
    } | null = null;
    if (res?.responseBody) {
      const m = res.responseBody.match(/\{[\s\S]*\}/);
      if (m) {
        try {
          embedded = JSON.parse(m[0]) as typeof embedded;
        } catch {
          embedded = null;
        }
      }
    }

    console.log("\n========================================");
    console.log("LIKEIT TIMELINE (from last like_evidence)");
    console.log("========================================");
    console.log(
      `T0  face BEFORE: ${ev.faceBefore?.className} / ${ev.faceBefore?.iconClass}`,
    );
    console.log(
      `T1  click → optimistic ON: ${ev.faceImmediate?.className} / ${ev.faceImmediate?.iconClass}`,
    );
    console.log(`T2  Like API call type=${req?.resourceType} (JSONP script)`);
    console.log(`    callback=${callback}`);
    console.log(
      `    guestToken prefix=${guestToken?.slice(0, 24)} len=${guestToken?.length ?? 0}`,
    );
    console.log(
      `    url host path contains blogserver/like/v1 + _method=POST + _ch=pcw`,
    );
    console.log(
      `T3  response http=${res?.status} embedded=${JSON.stringify(embedded)}`,
    );
    console.log(`T4  dialogs=${JSON.stringify(ev.dialogs ?? [])}`);
    console.log(
      `T5  face @1s (rollback): ${ev.face1s?.className} / ${ev.face1s?.iconClass}`,
    );
    console.log(`verifiedOn=${ev.verifiedOn}`);
    console.log(`
INFERRED CALL CHAIN (until deeper stacks arrive):
  [click listener on a.u_likeit_button._face]
    → optimistic setState(on) / class on + __reaction__like
    → jQuery.ajax({ dataType:'jsonp', url: apis.naver.com/.../like/v1/... })
         OR equivalent that appendChild(<script src=…callback=jQuery…>)
    → window[callback]( { statusCode:401, errorCode:4010, message:'로그인…' } )
    → error handler → window.confirm('네이버 로그인…')
    → revert setState(off) / class off + __reaction__zeroface

SUCCESS iff T3 embedded statusCode is success (not 4010), so T4/T5 do not run.
guestToken is an anti-abuse/page token, not a substitute for Like API login acceptance.
`);
  } catch (err) {
    console.warn(
      "[likeit-flow] evidence parse failed",
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Install hooks + CDP listener dump. Call BEFORE the like click.
 */
export async function installLikeItInternalsHooks(page: Page): Promise<{
  installed: boolean;
  cdpListeners: unknown;
}> {
  console.log("[likeit-trace] installing page hooks …");
  const installed = (await page.evaluate(INSTALL_HOOKS_SOURCE).catch((err) => {
    console.warn("[likeit-trace] install failed", err);
    return { ok: false };
  })) as { ok?: boolean; already?: boolean };

  // CDP: event listeners currently on face <a>
  let cdpListeners: unknown = null;
  try {
    const session = await page.context().newCDPSession(page);
    await session.send("DOM.enable");
    await session.send("Runtime.enable");
    const { root } = (await session.send("DOM.getDocument", {
      depth: 0,
    })) as { root: { nodeId: number } };
    const { nodeId } = (await session.send("DOM.querySelector", {
      nodeId: root.nodeId,
      selector: "a.u_likeit_button._face",
    })) as { nodeId: number };
    if (nodeId) {
      const { object } = (await session.send("DOM.resolveNode", {
        nodeId,
      })) as {
        object: { objectId: string };
      };
      const listeners = await session.send("DOMDebugger.getEventListeners", {
        objectId: object.objectId,
      });
      cdpListeners = listeners;
      console.log(
        `[likeit-trace] CDP getEventListeners=${JSON.stringify(listeners).slice(0, 1500)}`,
      );
      // Enrich with handler function names via Runtime
      try {
        const listenerList =
          (
            listeners as {
              listeners?: Array<{
                type: string;
                handler?: { objectId?: string };
                useCapture?: boolean;
              }>;
            }
          ).listeners ?? [];
        const enriched: Array<Record<string, unknown>> = [];
        for (const li of listenerList) {
          const row: Record<string, unknown> = {
            type: li.type,
            useCapture: li.useCapture,
          };
          if (li.handler?.objectId) {
            try {
              const props = (await session.send("Runtime.getProperties", {
                objectId: li.handler.objectId,
                ownProperties: false,
              })) as {
                result?: Array<{
                  name: string;
                  value?: { description?: string; type?: string };
                }>;
              };
              const desc = (await session.send("Runtime.callFunctionOn", {
                objectId: li.handler.objectId,
                functionDeclaration: `function() {
                  return {
                    name: this.name || '(anon)',
                    length: this.length,
                    source: Function.prototype.toString.call(this).slice(0, 400)
                  };
                }`,
                returnByValue: true,
              })) as { result?: { value?: unknown } };
              row.handler = desc.result?.value ?? null;
              row.handlerPropsSample = (props.result ?? [])
                .filter((p) => p.name === "name" || p.name === "length")
                .map((p) => ({ name: p.name, value: p.value }));
            } catch {
              row.handler = "(unreadable)";
            }
          }
          enriched.push(row);
        }
        cdpListeners = { listeners: enriched, raw: listeners };
        console.log(
          `[likeit-trace] CDP listeners enriched=${JSON.stringify(enriched).slice(0, 2000)}`,
        );
      } catch (enrichErr) {
        console.warn(
          "[likeit-trace] listener enrich failed:",
          enrichErr instanceof Error ? enrichErr.message : enrichErr,
        );
      }
      await page
        .evaluate(
          `(() => { window.__LIKEIT_TRACE__ && (window.__LIKEIT_TRACE__.clickListenerInfo = ${JSON.stringify(cdpListeners)}); })()`,
        )
        .catch(() => undefined);
    }
    await session.detach().catch(() => undefined);
  } catch (err) {
    console.warn(
      "[likeit-trace] CDP listeners failed:",
      err instanceof Error ? err.message : err,
    );
  }

  console.log(
    `[likeit-trace] hooks ok=${Boolean(installed?.ok)} already=${Boolean((installed as { already?: boolean })?.already)}`,
  );
  return { installed: Boolean(installed?.ok), cdpListeners };
}

export async function snapshotLikeItState(
  page: Page,
  label: string,
): Promise<unknown> {
  const src = `((label) => {
    if (typeof window.__LIKEIT_TRACE_SNAPSHOT__ === 'function') {
      return window.__LIKEIT_TRACE_SNAPSHOT__(label);
    }
    return { label: label, error: 'hooks-not-installed' };
  })(${JSON.stringify(label)})`;
  return page.evaluate(src).catch((err) => ({
    label,
    error: err instanceof Error ? err.message : String(err),
  }));
}

export async function collectLikeItInternals(page: Page): Promise<unknown> {
  return page.evaluate(COLLECT_SOURCE).catch((err) => ({
    error: err instanceof Error ? err.message : String(err),
  }));
}

/**
 * Print + persist Timeline report after click observation window.
 */
export type LikeItInternalsReport = {
  installed: boolean;
  before: unknown;
  after: unknown;
  collected: unknown;
  cdpListeners: unknown;
  timelinePrinted: boolean;
};

export async function finishLikeItInternalsTrace(
  page: Page,
  beforeSnap: unknown,
  afterSnap: unknown,
  cdpListeners: unknown,
): Promise<LikeItInternalsReport> {
  const collected = (await collectLikeItInternals(page)) as {
    timeline?: Array<Record<string, unknown>>;
    guestTokenEvents?: unknown[];
    scriptAppends?: unknown[];
    clickListenerInfo?: unknown;
    error?: string;
  };

  const before = beforeSnap as {
    localStorage?: Record<string, string>;
    sessionStorage?: Record<string, string>;
    windowLikeKeys?: { keyNames?: string[]; detail?: unknown };
    face?: unknown;
  };
  const after = afterSnap as typeof before;

  const lsDiff = diffStorage(
    before.localStorage ?? {},
    after.localStorage ?? {},
  );
  const ssDiff = diffStorage(
    before.sessionStorage ?? {},
    after.sessionStorage ?? {},
  );
  const winDiff = diffWindowKeys(
    before.windowLikeKeys ?? {},
    after.windowLikeKeys ?? {},
  );

  console.log("\n==========================");
  console.log("LIKEIT INTERNALS TIMELINE");
  console.log("==========================\n");

  console.log("[likeit-trace] CDP click listeners:");
  console.log(
    JSON.stringify(cdpListeners ?? collected.clickListenerInfo, null, 2)?.slice(
      0,
      2000,
    ),
  );

  console.log("\n[likeit-trace] face BEFORE:", JSON.stringify(before.face));
  console.log("[likeit-trace] face AFTER:", JSON.stringify(after.face));

  console.log("\n[likeit-trace] localStorage diff:", JSON.stringify(lsDiff));
  console.log("[likeit-trace] sessionStorage diff:", JSON.stringify(ssDiff));
  console.log("[likeit-trace] window like-related keys added:", winDiff.added);
  console.log(
    "[likeit-trace] window like-related keys removed:",
    winDiff.removed,
  );
  console.log(
    "[likeit-trace] window keys AFTER:",
    JSON.stringify((after.windowLikeKeys?.keyNames ?? []).slice(0, 60)),
  );

  const timeline = collected.timeline ?? [];
  console.log(`\n[likeit-trace] timeline events=${timeline.length}`);
  for (const ev of timeline) {
    const ms = ev.ms ?? "?";
    const kind = ev.kind ?? "?";
    if (
      kind === "fetch" ||
      kind === "xhr" ||
      kind === "sendBeacon" ||
      kind === "scriptAppend"
    ) {
      console.log(
        `  +${ms}ms ${kind} ${(ev.method as string) ?? ""} ${(ev.url as string) || (ev.src as string) || ""}`.slice(
          0,
          220,
        ),
      );
      if (Array.isArray(ev.stack) && (ev.stack as string[]).length) {
        console.log(
          `         stack: ${(ev.stack as string[]).slice(1, 6).join(" | ")}`,
        );
      }
    } else if (kind === "guestToken") {
      console.log(
        `  +${ms}ms guestToken via=${ev.via} len=${ev.tokenLen} prefix=${ev.tokenPrefix}`,
      );
      if (Array.isArray(ev.stack)) {
        console.log(
          `         stack: ${(ev.stack as string[]).slice(1, 8).join(" | ")}`,
        );
      }
    } else if (kind === "mutation") {
      console.log(
        `  +${ms}ms mutation attr=${ev.attr ?? "childList"} class=${ev.className} ${ev.oldValue ?? ""} → ${ev.newValue ?? ""}`,
      );
    } else if (kind === "faceClickCapture" || kind === "faceClickBubble") {
      console.log(
        `  +${ms}ms ${kind} phase=${ev.phase} target=${ev.targetTag} class=${ev.currentTargetClass}`,
      );
      if (Array.isArray(ev.stack)) {
        console.log(
          `         stack: ${(ev.stack as string[]).slice(1, 10).join(" | ")}`,
        );
      }
    } else if (kind === "windowFnCall") {
      console.log(`  +${ms}ms windowFnCall name=${ev.name}`);
      if (Array.isArray(ev.stack)) {
        console.log(
          `         stack: ${(ev.stack as string[]).slice(1, 8).join(" | ")}`,
        );
      }
    } else if (
      kind === "jquery.ajax" ||
      kind === "jquery.ajax.done" ||
      kind === "jquery.ajax.then" ||
      kind === "jquery.ajax.fail" ||
      kind === "jquery.ajax.always" ||
      kind === "jsonpCallback" ||
      kind === "jsonpCallbackRegister" ||
      kind === "jsonpCallbackWrap" ||
      kind === "confirm" ||
      kind === "alert" ||
      kind === "faceSetAttribute" ||
      kind === "faceClassList"
    ) {
      console.log(`  +${ms}ms ${kind} ${JSON.stringify(ev).slice(0, 280)}`);
      if (Array.isArray(ev.stack)) {
        console.log(
          `         stack: ${(ev.stack as string[]).slice(1, 10).join(" | ")}`,
        );
      }
    } else {
      console.log(`  +${ms}ms ${kind} ${JSON.stringify(ev).slice(0, 180)}`);
    }
  }

  // Reverse-engineer summary from this timeline
  printLikeItSuccessConditions(timeline, before, after);

  console.log("\n[likeit-trace] guestToken events:");
  console.log(
    JSON.stringify(collected.guestTokenEvents ?? [], null, 2).slice(0, 3000),
  );

  console.log("\n[likeit-trace] script appends (JSONP):");
  for (const s of (collected.scriptAppends as Array<Record<string, unknown>>) ??
    []) {
    console.log(
      `  +${s.ms}ms via=${s.via} src=${String(s.src ?? "").slice(0, 200)}`,
    );
    if (Array.isArray(s.stack)) {
      console.log(
        `         stack: ${(s.stack as string[]).slice(1, 10).join(" | ")}`,
      );
    }
  }

  const report = {
    at: new Date().toISOString(),
    pageUrl: page.url(),
    cdpListeners: cdpListeners ?? collected.clickListenerInfo,
    before,
    after,
    diffs: {
      localStorage: lsDiff,
      sessionStorage: ssDiff,
      windowKeys: winDiff,
    },
    timeline,
    guestTokenEvents: collected.guestTokenEvents,
    scriptAppends: collected.scriptAppends,
  };

  const out = path.join(debugDir(), "likeit_internals_timeline.json");
  fs.writeFileSync(out, JSON.stringify(report, null, 2), "utf8");
  console.log(`\n[likeit-trace] wrote ${out}`);
  console.log("==========================\n");

  return {
    installed: true,
    before: beforeSnap,
    after: afterSnap,
    collected,
    cdpListeners,
    timelinePrinted: true,
  };
}

// silence unused if any
void SNAPSHOT_SOURCE;
