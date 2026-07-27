/**
 * m.blog.naver.com sympathy (공감) helpers.
 * Target: bottom action bar [공감 하트] [댓글] [공유]
 * Empty heart = off · Red heart = on
 *
 * All page.evaluate payloads are string sources (no tsx __name).
 */

import fs from "node:fs";
import path from "node:path";
import type { Frame, Locator, Page } from "playwright";
import {
  holdBrowserForDebug,
  isLikeDebugEnabled,
  runLikeClickEvidence,
} from "./likeClickDebug";
import {
  traceEnter,
  traceReturn,
  traceBlocked,
  traceSkipped,
  traceGate,
  traceSetCondition,
} from "./traceSummary";

export type SympathyState = "on" | "off" | "missing";

export const SYMPATHY_SELECTORS = [
  "a.u_likeit_list_btn._button._sympathyBtn",
  "a.u_likeit_list_btn._sympathyBtn",
  "a.u_likeit_list_btn.off",
  "a.u_likeit_list_btn[data-type='like']",
  "a.u_likeit_list_btn",
  "button.u_likeit_list_btn",
  "a._sympathyBtn",
  '[class*="reaction"] a',
  '[class*="Reaction"] a',
  '[class*="reaction"] button',
  '[class*="Reaction"] button',
  '[class*="btn_area"] a',
  '[class*="post_btn"] a',
  '[class*="sympathy"] a',
  '[class*="likeit"] a',
];

export const UNPRESSED_SYMPATHY_SELECTORS = [
  'a.u_likeit_list_btn[aria-pressed="false"]',
  "a.u_likeit_list_btn.off",
  'a.u_likeit_list_btn[data-type="like"].off',
];

type Root = Page | Frame;

export type DomSnapshot = {
  tag: string;
  className: string;
  ariaPressed: string | null;
  ariaLabel: string | null;
  text: string;
  dataType: string | null;
  innerHTML: string;
  svgFills: string[];
  svgStroke: string[];
  inferred: SympathyState;
  signals: string[];
};

export type BoundingBoxLog = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type SympathyProbeResult = {
  state: SympathyState;
  matchedSelector: string | null;
  root: "page" | "frame";
  locator: Locator | null;
  /** Stable xpath for the actual clickable heart (not reaction wrapper). */
  xpath: string | null;
  snapshot: DomSnapshot | null;
  candidatesLogged: string[];
  box: BoundingBoxLog | null;
  nearbyText: string | null;
};

type RankedHeart = {
  xpath: string;
  score: number;
  tag: string;
  className: string;
  text: string;
  nearbyText: string;
  box: BoundingBoxLog;
  parentClasses: string[];
  hasSvg: boolean;
  hasCommentSibling: boolean;
  hasShareSibling: boolean;
  inActionBar: boolean;
  visible: boolean;
  reason: string;
  reject?: string;
};

function sympathyDebugEnabled(): boolean {
  return isLikeDebugEnabled();
}

function isRedishColor(raw: string): boolean {
  const v = raw.trim().toLowerCase();
  if (!v || v === "none" || v === "transparent" || v.includes("url("))
    return false;
  if (
    v.includes("#f60") ||
    v.includes("#ff5") ||
    v.includes("#e31") ||
    v.includes("#ff2") ||
    v.includes("#f23") ||
    v.includes("#ff0000") ||
    v.includes("rgb(255") ||
    v.includes("rgba(255")
  ) {
    return true;
  }
  const hex = v.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    let h = hex[1];
    if (h.length === 3)
      h = h
        .split("")
        .map((c) => c + c)
        .join("");
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    if (r > 180 && r > g + 40 && r > b + 40) return true;
  }
  const rgb = v.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (rgb) {
    const r = Number(rgb[1]);
    const g = Number(rgb[2]);
    const b = Number(rgb[3]);
    if (r > 180 && r > g + 40 && r > b + 40) return true;
  }
  return false;
}

async function rootsForSympathy(page: Page): Promise<Root[]> {
  const roots: Root[] = [page];
  for (const name of ["mainFrame", "screenFrame", "main"]) {
    const frame = page.frame({ name });
    if (frame) roots.push(frame);
  }
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    const url = frame.url();
    if (
      url.includes("blog.naver.com") ||
      url.includes("PostView") ||
      url.includes("likeit")
    ) {
      if (!roots.includes(frame)) roots.push(frame);
    }
  }
  return roots;
}

/**
 * Debug + ranking in one pass.
 * Returns { debug: [...all probed], ranked: [...accepted] }
 * Why ranked=0 was common:
 *  - viewport filter box.top > innerHeight*4 dropped bottom bar when not scrolled
 *  - required svg under a/button (some UIs put icon as sibling / img)
 *  - score < 25 dropped reaction-only candidates
 */
const SCAN_HEART_CANDIDATES_SOURCE = `(() => {
  var debug = [];
  var ranked = [];

  function xpathOf(el) {
    if (el.id) return '//*[@id="' + el.id + '"]';
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1 && parts.length < 18) {
      var tag = node.tagName.toLowerCase();
      if (tag === 'html') { parts.unshift('html'); break; }
      var parent = node.parentElement;
      if (!parent) { parts.unshift(tag); break; }
      var siblings = Array.from(parent.children).filter(function (c) { return c.tagName === node.tagName; });
      var idx = siblings.indexOf(node) + 1;
      parts.unshift(tag + '[' + idx + ']');
      node = parent;
    }
    return '/' + parts.join('/');
  }

  function clsOf(el) {
    if (!el || !el.className) return '';
    return el.className.toString ? el.className.toString() : String(el.className);
  }

  function parentClasses(el, n) {
    var out = [];
    var p = el ? el.parentElement : null;
    for (var i = 0; i < n && p; i++) {
      out.push(clsOf(p).slice(0, 120));
      p = p.parentElement;
    }
    return out;
  }

  function isVisible(el) {
    var st = window.getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) return false;
    var r = el.getBoundingClientRect();
    return r.width > 2 && r.height > 2;
  }

  function hasIcon(el) {
    return !!(
      el.querySelector('svg') ||
      el.querySelector('img') ||
      el.querySelector('i') ||
      el.querySelector('[class*="ico"]') ||
      el.querySelector('[class*="icon"]')
    );
  }

  function looksLikeHeart(el) {
    var aria = ((el.getAttribute('aria-label') || '') + ' ' + (el.innerText || '') + ' ' + clsOf(el)).toLowerCase();
    if (/공유|share|댓글|comment|비행|보내기|scrap/.test(aria) && !/공감|like|sympath|좋아요|heart|reaction/.test(aria)) {
      return false;
    }
    if (/공감|like|sympath|좋아요|heart|u_likeit|reaction/.test(aria)) return true;
    // heart-shaped svg path often present without text
    if (el.querySelector('svg')) return true;
    return false;
  }

  function actionBarContext(el) {
    var hasComment = false, hasShare = false, horizontal = false, relatedSection = false;
    var nearbyText = '';
    var inReaction = false;
    var iconGroupCount = 0;
    var p = el;
    for (var depth = 0; depth < 10 && p; depth++) {
      var t = (p.innerText || '').replace(/\\s+/g, ' ').trim();
      var html = (p.innerHTML || '').toLowerCase();
      var cls = clsOf(p).toLowerCase();
      if (/reaction|sympath|likeit|btn_area|post_btn|toolbar|action/.test(cls)) inReaction = true;
      if (/함께 보면|카테고리 글|이 블로그|관련 글|추천 글/.test(t) || /related|recommend|category/.test(cls)) relatedSection = true;

      var commentHit =
        /댓글|comment|cbox|reply/.test(html) ||
        /댓글/.test(t) ||
        !!p.querySelector('[aria-label*="댓글"], [class*="comment"], [class*="Comment"], [class*="cbox"]');
      var shareHit =
        /공유|share|비행|scrap|보내기|airplane/.test(html) ||
        /공유/.test(t) ||
        !!p.querySelector('[aria-label*="공유"], [aria-label*="보내기"], [class*="share"], [class*="Share"]');
      if (commentHit) hasComment = true;
      if (shareHit) hasShare = true;

      var kids = Array.from(p.children);
      var iconish = kids.filter(function (k) {
        var r = k.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && (hasIcon(k) || k.tagName === 'A' || k.tagName === 'BUTTON' || k.getAttribute('role') === 'button');
      });
      if (iconish.length >= 2) {
        iconGroupCount = Math.max(iconGroupCount, iconish.length);
        var tops = iconish.map(function (k) { return k.getBoundingClientRect().top; });
        if (Math.max.apply(null, tops) - Math.min.apply(null, tops) < 64) horizontal = true;
      }
      if (depth <= 3 && t) nearbyText = t.slice(0, 80);
      if (hasComment && hasShare && horizontal) break;
      p = p.parentElement;
    }
    return {
      hasComment: hasComment,
      hasShare: hasShare,
      horizontal: horizontal,
      relatedSection: relatedSection,
      nearbyText: nearbyText,
      inReaction: inReaction,
      iconGroupCount: iconGroupCount
    };
  }

  // Broader seed set: clickables + reaction wrappers' anchors
  var seed = Array.from(document.querySelectorAll(
    'a, button, [role="button"], [class*="reaction"] a, [class*="Reaction"] a, [class*="likeit"] a, [class*="sympathy"] a'
  ));
  var seen = new Set();
  var rejectCounts = { noVisible: 0, noIcon: 0, notHeartish: 0, tiny: 0, scoreLow: 0, leftFloat: 0 };

  for (var i = 0; i < seed.length; i++) {
    var el = seed[i];
    if (seen.has(el)) continue;
    seen.add(el);

    var box = el.getBoundingClientRect();
    var text = ((el.innerText || el.textContent || '') + '').replace(/\\s+/g, ' ').trim().slice(0, 40);
    var cls = clsOf(el);
    var parents = parentClasses(el, 3);
    var svg = hasIcon(el);
    var visible = isVisible(el);

    var entry = {
      tag: el.tagName.toLowerCase(),
      className: cls.slice(0, 120),
      text: text,
      box: { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) },
      parentClasses: parents,
      hasSvg: svg,
      visible: visible,
      reject: null,
      score: 0,
      reason: '',
      xpath: '',
      hasCommentSibling: false,
      hasShareSibling: false,
      inActionBar: false,
      nearbyText: ''
    };

    if (!visible) {
      entry.reject = 'noVisible';
      rejectCounts.noVisible++;
      if (debug.length < 40) debug.push(entry);
      continue;
    }
    if (box.width < 6 || box.height < 6) {
      entry.reject = 'tiny';
      rejectCounts.tiny++;
      if (debug.length < 40) debug.push(entry);
      continue;
    }
    // NOTE: do NOT filter by viewport Y — bottom action bar often sits far below fold
    if (!svg && !/reaction|likeit|sympath/i.test(cls + ' ' + parents.join(' '))) {
      entry.reject = 'noIcon';
      rejectCounts.noIcon++;
      if (debug.length < 40) debug.push(entry);
      continue;
    }
    if (!looksLikeHeart(el) && !/reaction|likeit|sympath/i.test(cls + ' ' + parents.join(' '))) {
      entry.reject = 'notHeartish';
      rejectCounts.notHeartish++;
      if (debug.length < 40) debug.push(entry);
      continue;
    }

    var ctx = actionBarContext(el);
    var score = 0;
    var reasons = [];
    if (ctx.hasComment && ctx.hasShare) { score += 120; reasons.push('actionbar:comment+share'); }
    else if (ctx.hasComment) { score += 45; reasons.push('near:comment'); }
    else if (ctx.hasShare) { score += 45; reasons.push('near:share'); }
    if (ctx.horizontal) { score += 35; reasons.push('horizontal'); }
    if (ctx.inReaction) { score += 40; reasons.push('reaction-wrap'); }
    if (ctx.iconGroupCount >= 3) { score += 25; reasons.push('icon-group>=3'); }
    if (svg) { score += 15; reasons.push('has-icon'); }
    if (/u_likeit|sympath|likeit|공감|reaction/i.test(cls)) { score += 30; reasons.push('class:likeit'); }
    if (box.x < 72 && box.width < 90) {
      score -= 150;
      reasons.push('penalty:left-float');
      rejectCounts.leftFloat++;
    }
    if (box.width < 70 && box.height > 48) { score -= 30; reasons.push('penalty:tall-narrow'); }
    if (ctx.relatedSection) { score -= 100; reasons.push('penalty:related'); }
    // Prefer lower on page (글 하단 actionBar over top duplicate)
    if (box.y > 400) { score += 15; reasons.push('lower-y'); }

    entry.score = score;
    entry.reason = reasons.join(',') || 'none';
    entry.xpath = xpathOf(el);
    entry.hasCommentSibling = ctx.hasComment;
    entry.hasShareSibling = ctx.hasShare;
    entry.inActionBar = !!(ctx.hasComment && ctx.hasShare);
    entry.nearbyText = ctx.nearbyText;
    entry.reject = score < 10 ? 'scoreLow' : null;

    if (debug.length < 40) debug.push(entry);

    if (score < 10) {
      rejectCounts.scoreLow++;
      continue;
    }
    if (box.x < 72 && box.width < 90) continue;

    ranked.push({
      xpath: entry.xpath,
      score: score,
      tag: entry.tag,
      className: entry.className,
      text: entry.text,
      nearbyText: ctx.nearbyText,
      box: entry.box,
      parentClasses: parents,
      hasSvg: svg,
      hasCommentSibling: ctx.hasComment,
      hasShareSibling: ctx.hasShare,
      inActionBar: entry.inActionBar,
      visible: true,
      reason: entry.reason
    });
  }

  ranked.sort(function (a, b) {
    if (b.score !== a.score) return b.score - a.score;
    return b.box.y - a.box.y; // bottom bar wins ties
  });

  return {
    debug: debug.slice(0, 30),
    ranked: ranked.slice(0, 12),
    rejectCounts: rejectCounts,
    seedCount: seed.length,
    vh: window.innerHeight,
    scrollY: Math.round(window.scrollY || window.pageYOffset || 0),
    docH: Math.round(document.documentElement.scrollHeight || 0)
  };
})()`;

const SNAPSHOT_BY_XPATH_SOURCE = `(xpath) => {
  var r = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
  var el = r.singleNodeValue;
  if (!el || el.nodeType !== 1) return null;
  var fills = [];
  var strokes = [];
  var nodes = el.querySelectorAll('svg, path, use, circle, g');
  for (var i = 0; i < nodes.length; i++) {
    var n = nodes[i];
    var cs = window.getComputedStyle(n);
    var fill = n.getAttribute('fill') || cs.fill || '';
    var stroke = n.getAttribute('stroke') || cs.stroke || '';
    if (fill) fills.push(fill);
    if (stroke) strokes.push(stroke);
    if (n.style && n.style.fill) fills.push(n.style.fill);
  }
  var b = el.getBoundingClientRect();
  var st = window.getComputedStyle(el);
  return {
    tag: el.tagName.toLowerCase(),
    className: el.className && el.className.toString ? el.className.toString() : '',
    ariaPressed: el.getAttribute('aria-pressed'),
    ariaLabel: el.getAttribute('aria-label'),
    text: ((el.innerText || el.textContent || '') + '').trim().slice(0, 80),
    dataType: el.getAttribute('data-type'),
    innerHTML: (el.innerHTML || '').slice(0, 500),
    svgFills: fills.slice(0, 12),
    svgStroke: strokes.slice(0, 12),
    visible: st.display !== 'none' && st.visibility !== 'hidden' && b.width > 2 && b.height > 2,
    box: { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) }
  };
}`;

const RESOLVE_CLICKABLE_FROM_XPATH_SOURCE = `(xpath) => {
  function xpathOf(el) {
    if (el.id) return '//*[@id="' + el.id + '"]';
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1 && parts.length < 18) {
      var tag = node.tagName.toLowerCase();
      if (tag === 'html') { parts.unshift('html'); break; }
      var parent = node.parentElement;
      if (!parent) { parts.unshift(tag); break; }
      var siblings = Array.from(parent.children).filter(function (c) { return c.tagName === node.tagName; });
      var idx = siblings.indexOf(node) + 1;
      parts.unshift(tag + '[' + idx + ']');
      node = parent;
    }
    return '/' + parts.join('/');
  }
  function isRed(fill) {
    var v = (fill || '').toLowerCase();
    if (!v || v === 'none' || v === 'transparent') return false;
    if (v.indexOf('rgb(255') >= 0 || v.indexOf('#f') === 0 || v.indexOf('#e') === 0) return true;
    return false;
  }
  function clsOf(el) {
    if (!el) return '';
    var c = el.getAttribute && el.getAttribute('class');
    if (typeof c === 'string') return c;
    if (typeof el.className === 'string') return el.className;
    if (el.className && typeof el.className.baseVal === 'string') return el.className.baseVal;
    return '';
  }
  try {
  var r = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
  var root = r.singleNodeValue;
  if (!root || root.nodeType !== 1) return null;

  var scope = root;
  for (var up = 0; up < 6 && scope; up++) {
    var c = clsOf(scope).toLowerCase();
    if (c.indexOf('reaction') >= 0 || c.indexOf('sympath') >= 0 || c.indexOf('likeit') >= 0 || c.indexOf('btn_area') >= 0) break;
    scope = scope.parentElement;
  }
  if (!scope) scope = root;

  var nodes = Array.from(scope.querySelectorAll('a, button, [role="button"]'));
  if ((root.tagName === 'A' || root.tagName === 'BUTTON' || root.getAttribute('role') === 'button') && nodes.indexOf(root) < 0) {
    nodes.unshift(root);
  }

  var candidates = [];
  for (var i = 0; i < nodes.length; i++) {
    var el = nodes[i];
    var icon = el.querySelector('svg, img, i');
    if (!icon && el !== root) continue;
    var b = el.getBoundingClientRect();
    if (b.width < 6 || b.height < 6) continue;
    var st = window.getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden') continue;
    var aria = ((el.getAttribute('aria-label') || '') + ' ' + (el.innerText || '')).toLowerCase();
    if (/공유|share|댓글|comment|비행/.test(aria) && !/공감|like|sympath|좋아요/.test(aria)) continue;
    var fills = [];
    var svg = el.querySelector('svg');
    if (svg) {
      var paths = svg.querySelectorAll('path, use, circle');
      for (var p = 0; p < paths.length; p++) {
        var cs = window.getComputedStyle(paths[p]);
        fills.push(paths[p].getAttribute('fill') || cs.fill || '');
      }
    }
    var pressed = el.getAttribute('aria-pressed');
    var on = pressed === 'true' || fills.some(isRed);
    candidates.push({
      xpath: xpathOf(el),
      tag: el.tagName.toLowerCase(),
      className: String(clsOf(el)),
      box: { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) },
      on: on,
      fillSample: fills.slice(0, 4),
      visible: true
    });
  }
  if (candidates.length === 0) {
    var rb = root.getBoundingClientRect();
    return {
      xpath: xpathOf(root),
      tag: root.tagName.toLowerCase(),
      className: String(clsOf(root)),
      box: { x: Math.round(rb.x), y: Math.round(rb.y), width: Math.round(rb.width), height: Math.round(rb.height) },
      on: false,
      fillSample: [],
      visible: true
    };
  }
  for (var j = 0; j < candidates.length; j++) {
    if (!candidates[j].on) return candidates[j];
  }
  return candidates[0];
  } catch (_e) {
    return null;
  }
}`;

/** Confirm heart sits in a group that also has comment + share icons. Always returns { ok }. */
const VERIFY_ACTION_BAR_NEAR_XPATH_SOURCE = `(xpath) => {
  try {
    function clsOf(el) {
      if (!el) return '';
      var c = el.getAttribute && el.getAttribute('class');
      if (typeof c === 'string') return c;
      if (typeof el.className === 'string') return el.className;
      if (el.className && typeof el.className.baseVal === 'string') return el.className.baseVal;
      return '';
    }
    if (!xpath || typeof xpath !== 'string') {
      return { ok: false, reason: 'bad-xpath' };
    }
    var r = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
    var el = r.singleNodeValue;
    if (!el || el.nodeType !== 1) return { ok: false, reason: 'not-found' };

    var p = el;
    for (var depth = 0; depth < 10 && p; depth++) {
      var html = (p.innerHTML || '').toLowerCase();
      var t = ((p.innerText || '') + '').replace(/\\s+/g, ' ');
      var cls = clsOf(p).toLowerCase();
      var hasComment = false;
      var hasShare = false;
      try {
        hasComment =
          /댓글|comment|cbox|reply/.test(html) ||
          /댓글/.test(t) ||
          !!p.querySelector('[aria-label*="댓글"], [class*="comment"], [class*="Comment"], [class*="cbox"]');
        hasShare =
          /공유|share|비행|scrap|보내기|airplane/.test(html) ||
          /공유/.test(t) ||
          !!p.querySelector('[aria-label*="공유"], [aria-label*="보내기"], [class*="share"], [class*="Share"]');
      } catch (_q) {
        hasComment = /댓글|comment/.test(html + t);
        hasShare = /공유|share/.test(html + t);
      }

      var kids = Array.from(p.children).filter(function (k) {
        var b = k.getBoundingClientRect();
        return b.width > 0 && b.height > 0 && (k.querySelector('svg,img,i') || k.tagName === 'A' || k.tagName === 'BUTTON');
      });
      var horizontal = false;
      if (kids.length >= 2) {
        var tops = kids.map(function (k) { return k.getBoundingClientRect().top; });
        horizontal = Math.max.apply(null, tops) - Math.min.apply(null, tops) < 64;
      }

      if (hasComment && hasShare && horizontal && kids.length >= 2) {
        return {
          ok: true,
          depth: depth,
          hasComment: true,
          hasShare: true,
          horizontal: true,
          iconKids: kids.length,
          parentClass: String(cls).slice(0, 120),
          nearbyText: String(t).trim().slice(0, 60)
        };
      }
      p = p.parentElement;
    }
    return { ok: false, reason: 'no-actionbar-icon-group', hasComment: false, hasShare: false };
  } catch (e) {
    return { ok: false, reason: 'verify-exception:' + String(e && e.message ? e.message : e) };
  }
}`;

const DISPATCH_CLICK_BY_XPATH_SOURCE = `(xpath) => {
  try {
    var r = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
    var el = r.singleNodeValue;
    if (!el || el.nodeType !== 1) return { ok: false, reason: 'not-found' };
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    var opts = { bubbles: true, cancelable: true, view: window, buttons: 1 };
    try {
      if (typeof PointerEvent === 'function') el.dispatchEvent(new PointerEvent('pointerdown', opts));
    } catch (_p0) {}
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    try {
      if (typeof PointerEvent === 'function') el.dispatchEvent(new PointerEvent('pointerup', opts));
    } catch (_p1) {}
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));
    if (typeof el.click === 'function') el.click();
    var cls = '';
    try {
      cls = el.getAttribute('class') || '';
    } catch (_c) {}
    return {
      ok: true,
      tag: el.tagName.toLowerCase(),
      className: String(cls)
    };
  } catch (e) {
    return { ok: false, reason: 'dispatch-exception:' + String(e && e.message ? e.message : e) };
  }
}`;

const XPATH_OF_ELEMENT_SOURCE = `(el) => {
  if (!el) return null;
  if (el.id) return '//*[@id="' + el.id + '"]';
  var parts = [];
  var cur = el;
  while (cur && cur.nodeType === 1 && parts.length < 18) {
    var tag = cur.tagName.toLowerCase();
    if (tag === 'html') { parts.unshift('html'); break; }
    var parent = cur.parentElement;
    if (!parent) { parts.unshift(tag); break; }
    var siblings = Array.from(parent.children).filter(function (c) { return c.tagName === cur.tagName; });
    var idx = siblings.indexOf(cur) + 1;
    parts.unshift(tag + '[' + idx + ']');
    cur = parent;
  }
  return '/' + parts.join('/');
}`;

type ScanResult = {
  debug: Array<{
    tag: string;
    className: string;
    text: string;
    box: BoundingBoxLog;
    parentClasses: string[];
    hasSvg: boolean;
    visible: boolean;
    reject: string | null;
    score: number;
    reason: string;
    hasCommentSibling?: boolean;
    hasShareSibling?: boolean;
  }>;
  ranked: RankedHeart[];
  rejectCounts: Record<string, number>;
  seedCount: number;
  vh: number;
  scrollY: number;
  docH: number;
};

/**
 * Playwright string-evaluate + arg can return undefined in this runtime.
 * IIFE with JSON-inlined arg matches the working SCAN pattern.
 */
function evaluateSourceWithArg(fnSource: string, arg: unknown): string {
  return `(() => { var __arg = ${JSON.stringify(arg)}; return (${fnSource})(__arg); })()`;
}

async function evaluateArg<T>(
  root: Root,
  fnSource: string,
  arg: unknown,
): Promise<T | undefined> {
  try {
    return (await root.evaluate(evaluateSourceWithArg(fnSource, arg))) as T;
  } catch (err) {
    console.log(
      `[sympathy] evaluateArg failed: ${err instanceof Error ? err.message : err}`,
    );
    return undefined;
  }
}

async function scanHeartCandidates(root: Root): Promise<ScanResult> {
  return root.evaluate(SCAN_HEART_CANDIDATES_SOURCE) as Promise<ScanResult>;
}

function logCandidateDebug(rootKind: string, scan: ScanResult) {
  console.log(
    `[sympathy] scan ${rootKind} seed=${scan.seedCount} ranked=${scan.ranked.length} vh=${scan.vh} scrollY=${scan.scrollY} docH=${scan.docH} rejects=${JSON.stringify(scan.rejectCounts)}`,
  );
  if (scan.ranked.length === 0) {
    console.log(
      `[sympathy] ranked=0 원인 후보: viewport 필터 제거됨 · rejects=${JSON.stringify(scan.rejectCounts)} · debug top:`,
    );
  }
  for (const d of scan.debug.slice(0, 12)) {
    console.log(
      `[sympathy] cand tag=${d.tag} class="${d.className}" text="${d.text}" box=${JSON.stringify(d.box)} svg=${d.hasSvg} parents=[${(d.parentClasses || []).join(" | ")}] score=${d.score} reject=${d.reject ?? "-"} reason=${d.reason || "-"} comment=${d.hasCommentSibling ?? "?"} share=${d.hasShareSibling ?? "?"}`,
    );
  }
  for (const r of scan.ranked.slice(0, 5)) {
    console.log(
      `[sympathy] ranked score=${r.score} tag=${r.tag} class="${r.className}" text="${r.text}" box=${JSON.stringify(r.box)} actionBar=${r.inActionBar} comment=${r.hasCommentSibling} share=${r.hasShareSibling} :: ${r.reason}`,
    );
  }
}

async function snapshotByXPath(
  root: Root,
  xpath: string,
): Promise<(DomSnapshot & { visible?: boolean; box?: BoundingBoxLog }) | null> {
  try {
    const raw = (await evaluateArg(
      root,
      SNAPSHOT_BY_XPATH_SOURCE,
      xpath,
    )) as null | {
      tag: string;
      className: string;
      ariaPressed: string | null;
      ariaLabel: string | null;
      text: string;
      dataType: string | null;
      innerHTML: string;
      svgFills: string[];
      svgStroke: string[];
      visible: boolean;
      box: BoundingBoxLog;
    };
    if (!raw) return null;
    const signals: string[] = [];
    let inferred: SympathyState = "off";
    if (raw.ariaPressed === "true") {
      inferred = "on";
      signals.push("aria-pressed=true");
    } else if (raw.ariaPressed === "false") {
      inferred = "off";
      signals.push("aria-pressed=false");
    }
    const cls = (raw.className || "").toLowerCase();
    if (/(?:^|\s)on(?:\s|$)/.test(cls) || cls.includes("is_on")) {
      inferred = "on";
      signals.push("class:on");
    } else if (/(?:^|\s)off(?:\s|$)/.test(cls)) {
      inferred = "off";
      signals.push("class:off");
    }
    const hasRed = [...(raw.svgFills || []), ...(raw.svgStroke || [])].some(
      isRedishColor,
    );
    if (hasRed) {
      inferred = "on";
      signals.push("svg:red");
    } else if (
      (raw.svgFills || []).length ||
      (raw.innerHTML || "").includes("svg")
    ) {
      if (inferred !== "on") {
        inferred = "off";
        signals.push("svg:empty");
      }
    }
    if (signals.length === 0) {
      signals.push("default:off");
      inferred = "off";
    }
    return { ...raw, inferred, signals };
  } catch {
    return null;
  }
}

async function resolveClickableXPath(
  root: Root,
  xpath: string,
): Promise<{
  xpath: string;
  tag: string;
  className: string;
  box: BoundingBoxLog;
  on: boolean;
  fillSample: string[];
  visible: boolean;
} | null> {
  try {
    const raw = await evaluateArg<{
      xpath: string;
      tag: string;
      className: string;
      box: BoundingBoxLog;
      on: boolean;
      fillSample: string[];
      visible: boolean;
    } | null>(root, RESOLVE_CLICKABLE_FROM_XPATH_SOURCE, xpath);
    return raw ?? null;
  } catch {
    return null;
  }
}

type StructureCheck = {
  ok: boolean;
  reason?: string;
  hasComment?: boolean;
  hasShare?: boolean;
  horizontal?: boolean;
  iconKids?: number;
  parentClass?: string;
  nearbyText?: string;
  depth?: number;
};

async function verifyActionBarNear(
  root: Root,
  xpath: string,
): Promise<StructureCheck> {
  const fallback: StructureCheck = {
    ok: false,
    reason: "verify-undefined",
  };
  try {
    const raw = await evaluateArg<StructureCheck | null>(
      root,
      VERIFY_ACTION_BAR_NEAR_XPATH_SOURCE,
      xpath,
    );
    if (!raw || typeof raw !== "object" || typeof raw.ok !== "boolean") {
      return { ...fallback, reason: "verify-empty-or-invalid" };
    }
    return raw;
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : "verify-failed",
    };
  }
}

export async function snapshotLocator(
  loc: Locator,
): Promise<DomSnapshot | null> {
  try {
    const handle = await loc.elementHandle();
    if (!handle) return null;
    const xpath = await handle.evaluate(XPATH_OF_ELEMENT_SOURCE);
    await handle.dispose().catch(() => undefined);
    if (typeof xpath !== "string" || !xpath) return null;
    return snapshotByXPath(loc.page(), xpath);
  } catch {
    return null;
  }
}

function logSnapshot(label: string, snap: DomSnapshot | null) {
  if (!snap) {
    console.log(`[sympathy] ${label}: (no snapshot)`);
    return;
  }
  console.log(
    `[sympathy] ${label}: state=${snap.inferred} <${snap.tag}> class="${snap.className}" aria-pressed=${snap.ariaPressed} fills=[${snap.svgFills.slice(0, 4).join(", ")}] signals=${snap.signals.join(",")}`,
  );
}

export async function saveSympathyDebugScreenshot(
  page: Page,
  reason: string,
): Promise<string | null> {
  try {
    const dir = path.join(process.cwd(), ".data", "debug", "sympathy");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(
      dir,
      `like_${Date.now()}_${reason.replace(/[^\w.-]+/g, "_").slice(0, 40)}.png`,
    );
    await page.screenshot({ path: file, fullPage: true });
    console.log(`[sympathy] screenshot → ${file}`);
    return file;
  } catch (err) {
    console.warn(
      "[sympathy] screenshot failed:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

function toProbeResult(
  root: Root,
  rootKind: "page" | "frame",
  xpath: string,
  matchedSelector: string,
  snap: DomSnapshot | null,
  box: BoundingBoxLog | null,
  nearbyText: string | null,
  candidatesLogged: string[],
): SympathyProbeResult {
  return {
    state: snap?.inferred ?? "off",
    matchedSelector,
    root: rootKind,
    locator: root.locator(`xpath=${xpath}`).first(),
    xpath,
    snapshot: snap,
    candidatesLogged,
    box,
    nearbyText,
  };
}

async function acceptIfActionBar(
  root: Root,
  rootKind: "page" | "frame",
  xpath: string,
  matchedSelector: string,
  candidatesLogged: string[],
  nearbyHint: string | null,
  prechecked?: {
    hasComment: boolean;
    hasShare: boolean;
    box: BoundingBoxLog | null;
    tag: string;
    className: string;
  },
): Promise<SympathyProbeResult | null> {
  try {
    if (!xpath) {
      console.log(
        `[sympathy] structure-check skip: empty xpath via=${matchedSelector}`,
      );
      return null;
    }

    // Prefer scan-time comment+share flags (avoids broken evaluate(arg) path)
    let structure: StructureCheck;
    if (prechecked?.hasComment && prechecked?.hasShare) {
      structure = {
        ok: true,
        hasComment: true,
        hasShare: true,
        horizontal: true,
        reason: "scan-prechecked",
        nearbyText: nearbyHint ?? undefined,
      };
      console.log(
        `[sympathy] structure-check selector=${matchedSelector} ok=true comment=true share=true reason=scan-prechecked tag=${prechecked.tag} class="${prechecked.className}"`,
      );
    } else {
      const resolved = await resolveClickableXPath(root, xpath);
      const clickXpath = resolved?.xpath ?? xpath;
      structure = await verifyActionBarNear(root, clickXpath);
      console.log(
        `[sympathy] structure-check selector=${matchedSelector} ok=${structure.ok} comment=${structure.hasComment} share=${structure.hasShare} horizontal=${structure.horizontal} kids=${structure.iconKids} parent="${structure.parentClass ?? ""}" reason=${structure.reason ?? "ok"}`,
      );
      if (!structure.ok) return null;
      xpath = clickXpath;
      if (!prechecked?.box && resolved?.box) {
        prechecked = {
          hasComment: true,
          hasShare: true,
          box: resolved.box,
          tag: resolved.tag,
          className: resolved.className,
        };
      }
    }

    if (!structure.ok) return null;

    const box = prechecked?.box ?? null;
    if (box && box.x < 72 && box.width < 90) {
      console.log(`[sympathy] reject left-float box=${JSON.stringify(box)}`);
      return null;
    }

    const snap = await snapshotByXPath(root, xpath);
    console.log(
      `[sympathy] chosen tag=${prechecked?.tag ?? snap?.tag} class="${prechecked?.className ?? snap?.className}" box=${JSON.stringify(box)} via=${matchedSelector}`,
    );
    logSnapshot("chosen-state", snap);
    return toProbeResult(
      root,
      rootKind,
      xpath,
      matchedSelector,
      snap,
      box,
      structure.nearbyText ?? nearbyHint,
      candidatesLogged,
    );
  } catch (err) {
    console.log(
      `[sympathy] acceptIfActionBar error via=${matchedSelector}: ${err instanceof Error ? err.message : err}`,
    );
    return null;
  }
}

/**
 * 1) scan + rank (debug why ranked=0)
 * 2) prefer inActionBar / comment+share
 * 3) CSS [class*="reaction"] fallback — still require comment+share before accept
 */
export async function probeSympathyButton(
  page: Page,
): Promise<SympathyProbeResult> {
  const candidatesLogged: string[] = [];
  const roots = await rootsForSympathy(page);

  for (const root of roots) {
    const rootKind: "page" | "frame" = root === page ? "page" : "frame";
    const scan = await scanHeartCandidates(root);
    logCandidateDebug(rootKind, scan);
    candidatesLogged.push(
      `${rootKind}:actionbar-ranked=${scan.ranked.length}`,
      `${rootKind}:seed=${scan.seedCount}:rejects=${JSON.stringify(scan.rejectCounts)}`,
    );

    const ordered = [
      ...scan.ranked.filter(
        (r) =>
          r.inActionBar &&
          /u_likeit_button/i.test(r.className) &&
          r.tag === "a",
      ),
      ...scan.ranked.filter(
        (r) => r.inActionBar && /u_likeit_button/i.test(r.className),
      ),
      ...scan.ranked.filter(
        (r) => r.inActionBar && !/other_reaction/i.test(r.className),
      ),
      ...scan.ranked.filter((r) => r.inActionBar),
      ...scan.ranked.filter((r) => r.hasCommentSibling && r.hasShareSibling),
      ...scan.ranked.filter((r) => r.score >= 40),
    ];
    // dedupe by xpath
    const seen = new Set<string>();
    for (const cand of ordered) {
      if (seen.has(cand.xpath)) continue;
      seen.add(cand.xpath);
      const accepted = await acceptIfActionBar(
        root,
        rootKind,
        cand.xpath,
        `scan:${cand.reason}`,
        candidatesLogged,
        cand.nearbyText,
        {
          hasComment: cand.hasCommentSibling,
          hasShare: cand.hasShareSibling,
          box: cand.box,
          tag: cand.tag,
          className: cand.className,
        },
      );
      if (accepted) return accepted;
    }
  }

  // CSS fallback — keep previous [class*="reaction"] path, but structure-gate before accept
  console.log("[sympathy] scan miss → CSS reaction fallback");
  for (const root of roots) {
    const rootKind: "page" | "frame" = root === page ? "page" : "frame";
    for (const sel of [
      ...UNPRESSED_SYMPATHY_SELECTORS,
      ...SYMPATHY_SELECTORS,
    ]) {
      const all = root.locator(sel);
      const n = await all.count().catch(() => 0);
      candidatesLogged.push(`${rootKind}:css:${sel}=${n}`);
      if (n === 0) continue;
      console.log(`[sympathy] css fallback selector=${sel} count=${n}`);

      // Prefer lower (bottom) matches when multiple
      const indexes = Array.from({ length: Math.min(n, 10) }, (_, i) => i);
      const withBox: { i: number; y: number; box: BoundingBoxLog }[] = [];
      for (const i of indexes) {
        const loc = all.nth(i);
        const visible = await loc.isVisible().catch(() => false);
        const box = await loc.boundingBox().catch(() => null);
        console.log(
          `[sympathy] css cand ${sel}[${i}] visible=${visible} box=${box ? JSON.stringify({ x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) }) : "null"}`,
        );
        if (!visible || !box) continue;
        if (box.x < 72 && box.width < 90) {
          console.log(`[sympathy] css skip left-float ${sel}[${i}]`);
          continue;
        }
        withBox.push({
          i,
          y: box.y,
          box: {
            x: Math.round(box.x),
            y: Math.round(box.y),
            width: Math.round(box.width),
            height: Math.round(box.height),
          },
        });
      }
      withBox.sort((a, b) => b.y - a.y); // bottom first

      for (const item of withBox) {
        const wrapXpath = await evaluateArg<string | null>(
          root,
          `(info) => {
            var list = document.querySelectorAll(info.sel);
            var el = list[info.i];
            if (!el) return null;
            if (el.id) return '//*[@id="' + el.id + '"]';
            var parts = [];
            var cur = el;
            while (cur && cur.nodeType === 1 && parts.length < 18) {
              var tag = cur.tagName.toLowerCase();
              if (tag === 'html') { parts.unshift('html'); break; }
              var parent = cur.parentElement;
              if (!parent) { parts.unshift(tag); break; }
              var siblings = Array.from(parent.children).filter(function (c) { return c.tagName === cur.tagName; });
              var idx = siblings.indexOf(cur) + 1;
              parts.unshift(tag + '[' + idx + ']');
              cur = parent;
            }
            return '/' + parts.join('/');
          }`,
          { sel, i: item.i },
        );
        if (typeof wrapXpath !== "string" || !wrapXpath) {
          console.log(`[sympathy] css ${sel}[${item.i}] xpath resolve failed`);
          continue;
        }

        try {
          const meta = await evaluateArg<{
            tag: string;
            className: string;
            text: string;
            hasSvg: boolean;
            parents: string[];
          } | null>(
            root,
            `(info) => {
              var el = document.querySelectorAll(info.sel)[info.i];
              if (!el) return null;
              function cls(e) {
                var c = e && e.getAttribute ? e.getAttribute('class') : '';
                return typeof c === 'string' ? c : '';
              }
              var parents = [];
              var p = el.parentElement;
              for (var i = 0; i < 3 && p; i++) { parents.push(cls(p).slice(0, 100)); p = p.parentElement; }
              return {
                tag: el.tagName.toLowerCase(),
                className: cls(el),
                text: ((el.innerText || '') + '').trim().slice(0, 40),
                hasSvg: !!(el.querySelector('svg,img,i')),
                parents: parents
              };
            }`,
            { sel, i: item.i },
          );
          if (meta) {
            console.log(
              `[sympathy] css detail ${sel}[${item.i}] tag=${meta.tag} class="${meta.className}" text="${meta.text}" svg=${meta.hasSvg} parents=[${(meta.parents || []).join(" | ")}]`,
            );
          }
        } catch {
          // ignore
        }

        // CSS reaction candidates: require live structure check, but also try scan-like soft accept via verify
        const structure = await verifyActionBarNear(root, wrapXpath);
        const accepted = await acceptIfActionBar(
          root,
          rootKind,
          wrapXpath,
          `css:${sel}`,
          candidatesLogged,
          null,
          structure.ok
            ? {
                hasComment: structure.hasComment === true,
                hasShare: structure.hasShare === true,
                box: item.box,
                tag: "a",
                className: sel,
              }
            : undefined,
        );
        if (accepted) return accepted;
        console.log(
          `[sympathy] css ${sel}[${item.i}] rejected by structure-check reason=${structure.reason}`,
        );
      }
    }
  }

  console.log(
    `[sympathy] missing — probed=${candidatesLogged.length}`,
    candidatesLogged.slice(0, 30).join(" | ") || "(no matches)",
  );
  return {
    state: "missing",
    matchedSelector: null,
    root: "page",
    locator: null,
    xpath: null,
    snapshot: null,
    candidatesLogged,
    box: null,
    nearbyText: null,
  };
}

export async function detectSympathyState(page: Page): Promise<SympathyState> {
  return (await probeSympathyButton(page)).state;
}

export async function waitForSympathyOn(
  page: Page,
  xpath: string | null,
  timeoutMs = 12_000,
): Promise<{
  on: boolean;
  state: SympathyState;
  snapshot: DomSnapshot | null;
}> {
  const deadline = Date.now() + timeoutMs;
  let lastSnap: DomSnapshot | null = null;
  let lastState: SympathyState = "off";

  while (Date.now() < deadline) {
    const live = await readLikeitLiveState(page);
    if (live) {
      lastState = live.on ? "on" : "off";
      lastSnap = {
        tag: "a",
        className: live.className,
        ariaPressed: live.ariaPressed,
        ariaLabel: live.ariaLabel,
        text: live.text,
        dataType: null,
        innerHTML: live.innerHTML.slice(0, 200),
        svgFills: live.svgFills,
        svgStroke: live.svgStroke,
        inferred: live.on ? "on" : "off",
        signals: live.signals,
      };
      if (live.on) {
        console.log(
          `[sympathy] verify-on class="${live.className}" aria=${live.ariaPressed} text="${live.text}" fills=${JSON.stringify(live.svgFills.slice(0, 4))} signals=${live.signals.join(",")}`,
        );
        return { on: true, state: "on", snapshot: lastSnap };
      }
    }

    if (xpath) {
      const snap = await snapshotByXPath(page, xpath);
      if (snap) {
        lastSnap = snap;
        lastState = snap.inferred;
        if (snap.inferred === "on") {
          return { on: true, state: "on", snapshot: snap };
        }
      }
    }

    await new Promise((r) => setTimeout(r, 400));
  }
  return { on: false, state: lastState, snapshot: lastSnap };
}

type LiveLikeState = {
  on: boolean;
  className: string;
  ariaPressed: string | null;
  ariaLabel: string | null;
  text: string;
  innerHTML: string;
  svgFills: string[];
  svgStroke: string[];
  signals: string[];
  box: BoundingBoxLog;
  index: number;
};

const READ_LIKEIT_LIVE_STATE_SOURCE = `(() => {
  function isRed(v) {
    v = (v || '').toLowerCase();
    if (!v || v === 'none' || v === 'transparent' || v.indexOf('url(') >= 0) return false;
    if (v.indexOf('rgb(255') >= 0 || v.indexOf('rgba(255') >= 0) return true;
    if (v.indexOf('#f') === 0 || v.indexOf('#e') === 0 || v.indexOf('#ff') === 0) return true;
    return false;
  }
  function scoreBox(b) {
    if (b.width < 6 || b.height < 6) return -9999;
    if (b.x < 72 && b.width < 90) return -9999; // left float
    return b.y + (b.x > 40 ? 20 : 0);
  }
  var nodes = Array.from(document.querySelectorAll('a.u_likeit_button._face, a.u_likeit_list_btn, a._sympathyBtn'));
  var best = null;
  var bestScore = -1e9;
  var bestIdx = -1;
  for (var i = 0; i < nodes.length; i++) {
    var el = nodes[i];
    var b = el.getBoundingClientRect();
    // convert to document coords for ranking bottom bar
    var docY = b.top + (window.scrollY || window.pageYOffset || 0);
    var score = scoreBox({ x: b.x, y: docY, width: b.width, height: b.height });
    if (score > bestScore) {
      bestScore = score;
      best = el;
      bestIdx = i;
    }
  }
  if (!best) return null;
  var cls = best.getAttribute('class') || '';
  var clsL = cls.toLowerCase();
  var aria = best.getAttribute('aria-pressed');
  var ariaLabel = best.getAttribute('aria-label');
  var text = ((best.innerText || best.textContent || '') + '').trim().slice(0, 40);
  var fills = [];
  var strokes = [];
  var paths = best.querySelectorAll('svg, svg *, path, use, circle, g');
  for (var p = 0; p < paths.length; p++) {
    var n = paths[p];
    var cs = window.getComputedStyle(n);
    fills.push(n.getAttribute('fill') || cs.fill || '');
    strokes.push(n.getAttribute('stroke') || cs.stroke || '');
    if (n.style && n.style.fill) fills.push(n.style.fill);
  }
  var signals = [];
  var on = false;
  if (aria === 'true') { on = true; signals.push('aria-pressed=true'); }
  if (aria === 'false') { signals.push('aria-pressed=false'); }
  if (/(?:^|\\s)on(?:\\s|$)/.test(clsL) || clsL.indexOf('is_on') >= 0) { on = true; signals.push('class:on'); }
  if (/(?:^|\\s)off(?:\\s|$)/.test(clsL)) { signals.push('class:off'); if (!on) on = false; }
  if (fills.concat(strokes).some(isRed)) { on = true; signals.push('svg:red'); }
  if (!signals.length) signals.push('default');
  var br = best.getBoundingClientRect();
  return {
    on: on,
    className: cls,
    ariaPressed: aria,
    ariaLabel: ariaLabel,
    text: text,
    innerHTML: (best.innerHTML || '').slice(0, 400),
    svgFills: fills.filter(Boolean).slice(0, 12),
    svgStroke: strokes.filter(Boolean).slice(0, 12),
    signals: signals,
    box: { x: Math.round(br.x), y: Math.round(br.y), width: Math.round(br.width), height: Math.round(br.height) },
    index: bestIdx
  };
})()`;

async function readLikeitLiveState(page: Page): Promise<LiveLikeState | null> {
  try {
    return (await page.evaluate(
      READ_LIKEIT_LIVE_STATE_SOURCE,
    )) as LiveLikeState | null;
  } catch {
    return null;
  }
}

type AncestorHandlerInfo = {
  depth: number;
  tag: string;
  className: string;
  onclickAttr: string | null;
  hasOnclickProp: boolean;
  href: string | null;
  role: string | null;
  cdpListeners: string[];
};

type ZerofaceTarget = {
  parentIndex: number;
  parentLoc: Locator;
  iconLoc: Locator;
  parentClass: string;
  iconClass: string;
  iconBox: BoundingBoxLog | null;
  ancestors: AncestorHandlerInfo[];
  hint: string;
};

const INSPECT_ZEROFACE_SOURCE = `(() => {
  function boxOf(el) {
    var b = el.getBoundingClientRect();
    return { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) };
  }
  function pickFace() {
    var nodes = Array.from(document.querySelectorAll('a.u_likeit_button._face'));
    var best = -1;
    var bestScore = -1e9;
    var info = [];
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var b = el.getBoundingClientRect();
      var st = window.getComputedStyle(el);
      var visible = st.display !== 'none' && st.visibility !== 'hidden' && b.width > 4 && b.height > 4;
      var docY = b.top + (window.scrollY || 0);
      var leftFloat = b.x < 72 && b.width < 90;
      var cls = el.getAttribute('class') || '';
      info.push({ i: i, visible: visible, leftFloat: leftFloat, cls: cls, box: boxOf(el), docY: Math.round(docY) });
      if (!visible || leftFloat) continue;
      var score = docY + (/\\boff\\b/i.test(cls) ? 50 : 0);
      if (score > bestScore) { bestScore = score; best = i; }
    }
    return { nodes: nodes, best: best, info: info };
  }

  var picked = pickFace();
  if (picked.best < 0) {
    return { ok: false, reason: 'no-face', info: picked.info };
  }
  var parent = picked.nodes[picked.best];
  var icon =
    parent.querySelector('span.u_likeit_icon.__reaction__zeroface') ||
    parent.querySelector('span.__reaction__zeroface') ||
    parent.querySelector('span.u_likeit_icon') ||
    parent.querySelector('span.u_likeit_icons');

  var chain = [];
  var cur = icon || parent;
  for (var d = 0; d < 8 && cur; d++) {
    chain.push({
      depth: d,
      tag: cur.tagName.toLowerCase(),
      className: (cur.getAttribute('class') || '').toString().slice(0, 140),
      onclickAttr: cur.getAttribute('onclick'),
      hasOnclickProp: typeof cur.onclick === 'function',
      href: cur.getAttribute('href'),
      role: cur.getAttribute('role'),
      id: cur.id || null,
      box: boxOf(cur)
    });
    cur = cur.parentElement;
  }

  return {
    ok: true,
    parentIndex: picked.best,
    parentClass: parent.getAttribute('class') || '',
    iconClass: icon ? (icon.getAttribute('class') || '') : '',
    iconFound: !!icon,
    iconBox: icon ? boxOf(icon) : boxOf(parent),
    parentBox: boxOf(parent),
    chain: chain,
    info: picked.info.slice(0, 8),
    outerHTML: (icon || parent).outerHTML.slice(0, 300)
  };
})()`;

async function inspectCdpListeners(
  page: Page,
  selector: string,
): Promise<string[]> {
  try {
    const session = await page.context().newCDPSession(page);
    try {
      await session.send("DOM.enable");
      await session.send("Runtime.enable");
      const doc = (await session.send("DOM.getDocument", {
        depth: 0,
      })) as { root: { nodeId: number } };
      const { nodeId } = (await session.send("DOM.querySelector", {
        nodeId: doc.root.nodeId,
        selector,
      })) as { nodeId: number };
      if (!nodeId) return [];
      const resolved = (await session.send("DOM.resolveNode", { nodeId })) as {
        object?: { objectId?: string };
      };
      const objectId = resolved.object?.objectId;
      if (!objectId) return [];
      const listeners = (await session.send("DOMDebugger.getEventListeners", {
        objectId,
      })) as { listeners?: Array<{ type: string; useCapture?: boolean }> };
      return (listeners.listeners ?? []).map(
        (l) => `${l.type}${l.useCapture ? "(capture)" : ""}`,
      );
    } finally {
      await session.detach().catch(() => undefined);
    }
  } catch (err) {
    console.log(
      `[sympathy] cdp-listeners failed: ${err instanceof Error ? err.message : err}`,
    );
    return [];
  }
}

async function markZerofaceForCdp(
  page: Page,
  parentIndex: number,
): Promise<void> {
  await page.evaluate(`(() => {
    document.querySelectorAll('[data-sympathy-target]').forEach(function (n) {
      n.removeAttribute('data-sympathy-target');
    });
    var nodes = document.querySelectorAll('a.u_likeit_button._face');
    var parent = nodes[${parentIndex}];
    if (!parent) return;
    parent.setAttribute('data-sympathy-target', 'face');
    var icon =
      parent.querySelector('span.u_likeit_icon.__reaction__zeroface') ||
      parent.querySelector('span.__reaction__zeroface') ||
      parent.querySelector('span.u_likeit_icon');
    if (icon) icon.setAttribute('data-sympathy-target', 'zeroface');
    var wrap = parent.querySelector('span.u_likeit_icons');
    if (wrap) wrap.setAttribute('data-sympathy-target', 'icons');
  })()`);
}

/**
 * Resolve bottom-bar a.u_likeit_button._face + span.__reaction__zeroface,
 * and inspect ancestors for handlers (attr/prop + CDP listeners).
 */
async function resolveLikeClickLocator(
  page: Page,
  _xpath: string | null,
): Promise<ZerofaceTarget> {
  const inspected = (await page.evaluate(INSPECT_ZEROFACE_SOURCE)) as {
    ok: boolean;
    reason?: string;
    parentIndex?: number;
    parentClass?: string;
    iconClass?: string;
    iconFound?: boolean;
    iconBox?: BoundingBoxLog;
    parentBox?: BoundingBoxLog;
    chain?: Array<{
      depth: number;
      tag: string;
      className: string;
      onclickAttr: string | null;
      hasOnclickProp: boolean;
      href: string | null;
      role: string | null;
      id: string | null;
      box: BoundingBoxLog;
    }>;
    info?: unknown;
    outerHTML?: string;
  };

  console.log(
    `[sympathy] zeroface-inspect ok=${inspected.ok} iconFound=${inspected.iconFound} parent="${inspected.parentClass}" icon="${inspected.iconClass}" html=${inspected.outerHTML ?? inspected.reason}`,
  );
  console.log(
    `[sympathy] like-targets info=${JSON.stringify(inspected.info ?? [])}`,
  );

  const parentIndex = inspected.parentIndex ?? -1;
  if (parentIndex >= 0) {
    await markZerofaceForCdp(page, parentIndex);
  }

  const cdpFace = await inspectCdpListeners(
    page,
    '[data-sympathy-target="face"]',
  );
  const cdpIcon = await inspectCdpListeners(
    page,
    '[data-sympathy-target="zeroface"]',
  );
  const cdpIcons = await inspectCdpListeners(
    page,
    '[data-sympathy-target="icons"]',
  );
  console.log(
    `[sympathy] cdp-listeners face=[${cdpFace.join(",")}] zeroface=[${cdpIcon.join(",")}] icons=[${cdpIcons.join(",")}]`,
  );

  const ancestors: AncestorHandlerInfo[] = [];
  if (inspected.chain) {
    for (const node of inspected.chain) {
      let cdpListeners: string[] = [];
      if (node.depth === 0) cdpListeners = cdpIcon;
      else if (/u_likeit_icons/.test(node.className)) cdpListeners = cdpIcons;
      else if (/u_likeit_button/.test(node.className)) cdpListeners = cdpFace;

      const info: AncestorHandlerInfo = {
        depth: node.depth,
        tag: node.tag,
        className: node.className,
        onclickAttr: node.onclickAttr,
        hasOnclickProp: node.hasOnclickProp,
        href: node.href,
        role: node.role,
        cdpListeners,
      };
      ancestors.push(info);
      console.log(
        `[sympathy] handler-chain depth=${node.depth} <${node.tag}> class="${node.className}" onclickAttr=${node.onclickAttr} onclickProp=${node.hasOnclickProp} href=${node.href} role=${node.role} cdp=[${cdpListeners.join(",")}] box=${JSON.stringify(node.box)}`,
      );
    }
  }

  const parentLoc =
    parentIndex >= 0
      ? page.locator("a.u_likeit_button._face").nth(parentIndex)
      : page.locator("a.u_likeit_button._face.off").last();
  const iconLoc = parentLoc
    .locator(
      "span.u_likeit_icon.__reaction__zeroface, span.__reaction__zeroface, span.u_likeit_icon",
    )
    .first();

  return {
    parentIndex,
    parentLoc,
    iconLoc,
    parentClass: inspected.parentClass ?? "",
    iconClass: inspected.iconClass ?? "",
    iconBox: inspected.iconBox ?? null,
    ancestors,
    hint: inspected.iconFound
      ? `zeroface@face[${parentIndex}]`
      : `face[${parentIndex}]-no-icon`,
  };
}

export type ClickSympathyResult = {
  /** Always present — caller-safe */
  ok: boolean;
  clicked: boolean;
  verifiedOn: boolean;
  selector: string | null;
  method?: string;
  error?: string;
  before: DomSnapshot | null;
  after: DomSnapshot | null;
  screenshotPath: string | null;
  beforeScreenshotPath: string | null;
};

function clickResult(
  partial: Omit<ClickSympathyResult, "ok"> & { ok?: boolean },
): ClickSympathyResult {
  const verifiedOn = partial.verifiedOn === true;
  const clicked = partial.clicked === true;
  const ok =
    typeof partial.ok === "boolean"
      ? partial.ok
      : verifiedOn || (clicked && verifiedOn);
  return {
    ok,
    clicked,
    verifiedOn,
    selector: partial.selector ?? null,
    method: partial.method,
    error: partial.error,
    before: partial.before ?? null,
    after: partial.after ?? null,
    screenshotPath: partial.screenshotPath ?? null,
    beforeScreenshotPath: partial.beforeScreenshotPath ?? null,
  };
}

function isLikeNetworkUrl(url: string): boolean {
  return /likeit|sympathy|\/like[\/?]|emotion|react|공감|u_like/i.test(url);
}

async function logViewportBox(page: Page, loc: Locator, label: string) {
  const box = await loc.boundingBox().catch(() => null);
  const vp = (await page
    .evaluate(
      `(() => ({
    w: window.innerWidth,
    h: window.innerHeight,
    scrollX: Math.round(window.scrollX || window.pageXOffset || 0),
    scrollY: Math.round(window.scrollY || window.pageYOffset || 0)
  }))()`,
    )
    .catch(() => null)) as {
    w: number;
    h: number;
    scrollX: number;
    scrollY: number;
  } | null;
  const inView =
    box && vp
      ? box.y >= 0 &&
        box.x >= 0 &&
        box.y + box.height <= vp.h &&
        box.x + box.width <= vp.w
      : false;
  console.log(
    `[sympathy] ${label} viewportBox=${box ? JSON.stringify({ x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) }) : "null"} vp=${vp ? JSON.stringify(vp) : "null"} inView=${inView}`,
  );
  return box;
}

async function verifyAfterClick(
  page: Page,
  before: LiveLikeState | null,
  networkHits: string[],
  beforeNet: number,
  methodLabel: string,
): Promise<boolean> {
  const checkOnce = async (): Promise<boolean> => {
    const after = await readLikeitLiveState(page);
    const iconState = (await page
      .evaluate(
        `(() => {
    var face = document.querySelector('a.u_likeit_button._face');
    if (!face) return null;
    var icon = face.querySelector('span.u_likeit_icon') || face.querySelector('[class*="__reaction__"]');
    return {
      faceClass: face.getAttribute('class') || '',
      aria: face.getAttribute('aria-pressed'),
      iconClass: icon ? (icon.getAttribute('class') || '') : ''
    };
  })()`,
      )
      .catch(() => null)) as {
      faceClass: string;
      aria: string | null;
      iconClass: string;
    } | null;

    const classFlipped =
      !!before?.className &&
      !!after?.className &&
      /\boff\b/i.test(before.className) &&
      /\bon\b/i.test(after.className) &&
      !/\boff\b/i.test(after.className);
    const ariaOn = after?.ariaPressed === "true" || iconState?.aria === "true";
    const iconLiked =
      !!iconState?.iconClass &&
      /__reaction__like\b/i.test(iconState.iconClass) &&
      !/__reaction__zeroface\b/i.test(iconState.iconClass);
    const netDelta = networkHits.slice(beforeNet);
    console.log(
      `[sympathy] after ${methodLabel}: class="${after?.className ?? ""}" aria=${after?.ariaPressed ?? "null"} icon="${iconState?.iconClass ?? ""}" fills=${JSON.stringify(after?.svgFills?.slice(0, 4) ?? [])} signals=${(after?.signals ?? []).join(",")} classOffToOn=${classFlipped} ariaOn=${ariaOn} iconLiked=${iconLiked} redHeart=${after?.on === true} networkHits=${netDelta.length} ${netDelta.slice(0, 3).join(" | ")}`,
    );

    if (after?.on || classFlipped || ariaOn || iconLiked) return true;
    return false;
  };

  // Poll for liked state instead of fixed 1200ms + 800ms sleeps.
  const ok = await (async () => {
    const deadline = Date.now() + 3_500;
    while (Date.now() < deadline) {
      if (await checkOnce()) return true;
      await new Promise((r) => setTimeout(r, 200));
    }
    return false;
  })();
  if (ok) return true;

  await page
    .waitForLoadState("networkidle", { timeout: 1_500 })
    .catch(() => undefined);

  const netDelta = networkHits.slice(beforeNet);
  if (netDelta.length > 0) {
    const followDeadline = Date.now() + 1_500;
    while (Date.now() < followDeadline) {
      const again = await readLikeitLiveState(page);
      console.log(
        `[sympathy] network-followup class="${again?.className ?? ""}" on=${again?.on} aria=${again?.ariaPressed} fills=${JSON.stringify(again?.svgFills?.slice(0, 4) ?? [])}`,
      );
      if (again?.on || again?.ariaPressed === "true") return true;
      await new Promise((r) => setTimeout(r, 200));
    }
  } else if (await checkOnce()) {
    return true;
  }
  return false;
}

async function centerOf(
  loc: Locator,
): Promise<{ x: number; y: number; box: BoundingBoxLog }> {
  await loc.scrollIntoViewIfNeeded({ timeout: 8_000 }).catch(() => undefined);
  await new Promise((r) => setTimeout(r, 150));
  const box = await loc.boundingBox();
  if (!box || box.width < 1 || box.height < 1) {
    throw new Error("no-bounding-box");
  }
  return {
    x: box.x + box.width / 2,
    y: box.y + box.height / 2,
    box: {
      x: Math.round(box.x),
      y: Math.round(box.y),
      width: Math.round(box.width),
      height: Math.round(box.height),
    },
  };
}

async function enableTouchEmulation(page: Page): Promise<void> {
  try {
    const session = await page.context().newCDPSession(page);
    await session.send("Emulation.setTouchEmulationEnabled", {
      enabled: true,
      maxTouchPoints: 5,
    });
    // Keep session attached for subsequent Input.* calls on same page via fresh sessions
    await session.detach().catch(() => undefined);
    console.log("[sympathy] CDP Emulation.setTouchEmulationEnabled=true");
  } catch (err) {
    console.log(
      `[sympathy] touch-emulation failed: ${err instanceof Error ? err.message : err}`,
    );
  }
  await page
    .evaluate(
      `(() => {
      try {
        Object.defineProperty(navigator, 'maxTouchPoints', { get: function () { return 5; }, configurable: true });
      } catch (e) {}
      try {
        if (!('ontouchstart' in window)) {
          window.ontouchstart = null;
        }
      } catch (e2) {}
    })()`,
    )
    .catch(() => undefined);
}

async function cdpMouseClick(
  page: Page,
  x: number,
  y: number,
  pointerType: "mouse" | "touch",
): Promise<void> {
  const session = await page.context().newCDPSession(page);
  try {
    // Playwright CDP typings omit pointerType:'touch'; Chromium accepts it at runtime.
    const cdp = session as unknown as {
      send: (
        method: string,
        params?: Record<string, unknown>,
      ) => Promise<unknown>;
    };
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
      button: "left",
      clickCount: 1,
      pointerType,
    });
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      clickCount: 1,
      buttons: 1,
      pointerType,
    });
    await new Promise((r) => setTimeout(r, 40));
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      clickCount: 1,
      buttons: 0,
      pointerType,
    });
  } finally {
    await session.detach().catch(() => undefined);
  }
}

async function cdpTouchTap(page: Page, x: number, y: number): Promise<void> {
  const session = await page.context().newCDPSession(page);
  try {
    await session.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x, y, id: 0, radiusX: 2, radiusY: 2, force: 1 }],
    });
    await new Promise((r) => setTimeout(r, 50));
    await session.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
  } finally {
    await session.detach().catch(() => undefined);
  }
}

/**
 * Mobile-user-like activation of LikeIt (m.blog).
 * Prefer trusted CDP / touchscreen / pointer sequences over synthetic MouseEvent-only.
 * Target order: parent a (has click listener) → zeroface icon → icons wrap.
 */
async function clickWithFallbacks(
  page: Page,
  resolved: ZerofaceTarget,
  networkHits: string[],
): Promise<{
  method: string;
  ok: boolean;
  verifiedOn: boolean;
  error?: string;
}> {
  await enableTouchEmulation(page);

  const targets: Array<{ label: string; loc: Locator }> = [
    // CDP showed click listener on <a.u_likeit_button._face>, not the icon span
    { label: "parent-face-a", loc: resolved.parentLoc },
    { label: "zeroface-icon", loc: resolved.iconLoc },
    {
      label: "icons-wrap",
      loc: resolved.parentLoc.locator("span.u_likeit_icons").first(),
    },
  ];

  const handlerish = resolved.ancestors.filter(
    (a) =>
      a.hasOnclickProp ||
      !!a.onclickAttr ||
      a.cdpListeners.length > 0 ||
      (a.href && a.href !== "#"),
  );
  console.log(
    `[sympathy] handlerish-ancestors=${handlerish.length} ${JSON.stringify(handlerish.slice(0, 4))}`,
  );
  console.log(
    "[sympathy] event strategy: touchscreen.tap → pointer sequence → CDP mouse(touch) → CDP touch → DOM touchstart/end",
  );

  let lastError = "no-method-tried";

  for (const target of targets) {
    const count = await target.loc.count().catch(() => 0);
    if (count === 0) {
      console.log(`[sympathy] skip ${target.label}: not found`);
      continue;
    }

    let coords: { x: number; y: number; box: BoundingBoxLog };
    try {
      coords = await centerOf(target.loc);
    } catch (err) {
      console.log(
        `[sympathy] skip ${target.label}: ${err instanceof Error ? err.message : err}`,
      );
      continue;
    }
    console.log(
      `[sympathy] click-target ${target.label} center=(${Math.round(coords.x)},${Math.round(coords.y)}) box=${JSON.stringify(coords.box)}`,
    );

    const methods: Array<{ name: string; run: () => Promise<void> }> = [
      {
        name: `${target.label}|touchscreen.tap`,
        run: async () => {
          // Requires hasTouch on context; may throw on desktop profile
          await page.touchscreen.tap(coords.x, coords.y);
        },
      },
      {
        name: `${target.label}|pointer-seq`,
        run: async () => {
          // hover → pointerdown → pointerup → click (Playwright mouse = trusted)
          await page.mouse.move(coords.x, coords.y);
          await new Promise((r) => setTimeout(r, 80));
          await page.mouse.down();
          await new Promise((r) => setTimeout(r, 60));
          await page.mouse.up();
          await new Promise((r) => setTimeout(r, 40));
          await page.mouse.click(coords.x, coords.y, { delay: 40 });
        },
      },
      {
        name: `${target.label}|cdp.mouse.pointerType=mouse`,
        run: async () => {
          await cdpMouseClick(page, coords.x, coords.y, "mouse");
        },
      },
      {
        name: `${target.label}|cdp.mouse.pointerType=touch`,
        run: async () => {
          // LikeIt on m.blog may filter by pointerType === 'touch'
          await cdpMouseClick(page, coords.x, coords.y, "touch");
        },
      },
      {
        name: `${target.label}|cdp.touchTap`,
        run: async () => {
          await cdpTouchTap(page, coords.x, coords.y);
        },
      },
      {
        name: `${target.label}|dom.touch+click`,
        run: async () => {
          const src = evaluateSourceWithArg(
            `(p) => {
              var x = p.x, y = p.y;
              var el = document.elementFromPoint(x, y);
              if (!el) return { ok: false, reason: 'no-el-at-point' };
              var face = el.closest ? el.closest('a.u_likeit_button') : null;
              var target = face || el;
              try {
                var t = new Touch({
                  identifier: 1,
                  target: target,
                  clientX: x,
                  clientY: y,
                  radiusX: 2.5,
                  radiusY: 2.5,
                  force: 1
                });
                var touchOpts = { bubbles: true, cancelable: true, composed: true };
                target.dispatchEvent(new TouchEvent('touchstart', Object.assign({}, touchOpts, {
                  touches: [t], changedTouches: [t], targetTouches: [t]
                })));
                target.dispatchEvent(new TouchEvent('touchend', Object.assign({}, touchOpts, {
                  touches: [], changedTouches: [t], targetTouches: []
                })));
                target.dispatchEvent(new TouchEvent('touchcancel', Object.assign({}, touchOpts, {
                  touches: [], changedTouches: [t], targetTouches: []
                })));
              } catch (e) {}
              try {
                var popts = {
                  bubbles: true, cancelable: true, composed: true, view: window,
                  pointerId: 1, pointerType: 'touch', isPrimary: true,
                  clientX: x, clientY: y, buttons: 1
                };
                target.dispatchEvent(new PointerEvent('pointerdown', popts));
                target.dispatchEvent(new PointerEvent('pointerup', Object.assign({}, popts, { buttons: 0 })));
                target.dispatchEvent(new MouseEvent('click', {
                  bubbles: true, cancelable: true, composed: true, view: window,
                  clientX: x, clientY: y, buttons: 0
                }));
              } catch (e2) {}
              if (typeof target.click === 'function') target.click();
              return {
                ok: true,
                tag: target.tagName.toLowerCase(),
                cls: (target.getAttribute && target.getAttribute('class') || '').toString().slice(0, 80)
              };
            }`,
            { x: coords.x, y: coords.y },
          );
          const result = (await page.evaluate(src)) as {
            ok?: boolean;
            reason?: string;
            tag?: string;
            cls?: string;
          };
          console.log(
            `[sympathy] dom.touch+click result ok=${result?.ok} tag=${result?.tag} class="${result?.cls ?? ""}" reason=${result?.reason ?? ""}`,
          );
          if (!result?.ok)
            throw new Error(result?.reason ?? "dom.touch+click failed");
        },
      },
      {
        name: `${target.label}|locator.click`,
        run: async () => {
          await target.loc.click({
            timeout: 6_000,
            force: true,
            position: { x: 4, y: 4 },
          });
        },
      },
    ];

    for (const m of methods) {
      const beforeNet = networkHits.length;
      const before = await readLikeitLiveState(page);
      console.log(
        `[sympathy] try-click method=${m.name} beforeClass="${before?.className ?? ""}" beforeAria=${before?.ariaPressed ?? "null"}`,
      );
      try {
        await m.run();
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        console.log(`[sympathy] ${m.name} threw: ${lastError}`);
        continue;
      }

      const ok = await verifyAfterClick(
        page,
        before,
        networkHits,
        beforeNet,
        m.name,
      );
      if (ok) {
        return { method: m.name, ok: true, verifiedOn: true };
      }
      lastError = `clicked-but-still-off after ${m.name}`;
    }
  }

  return {
    method: "all-failed",
    ok: false,
    verifiedOn: false,
    error: lastError,
  };
}

export async function clickSympathyIfOff(
  page: Page,
): Promise<ClickSympathyResult> {
  traceEnter("clickSympathyIfOff", `url=${page.url()}`);
  const networkHits: string[] = [];
  const onRequest = (req: { url: () => string; method: () => string }) => {
    const url = req.url();
    if (isLikeNetworkUrl(url)) {
      const line = `${req.method()} ${url.slice(0, 180)}`;
      networkHits.push(line);
      console.log(`[sympathy] network-like ${line}`);
    }
  };
  page.on("request", onRequest);

  try {
    const probe = await probeSympathyButton(page);
    console.log(
      `[TRACE] clickSympathyIfOff probe.state=${probe.state} xpath=${probe.xpath ? "yes" : "no"} locator=${probe.locator ? "yes" : "no"}`,
    );
    traceSetCondition("probeState", probe.state);
    traceSetCondition("targetFound", Boolean(probe.xpath && probe.locator));
    traceSetCondition("alreadyLiked", probe.state === "on");

    if (probe.state === "missing" || !probe.xpath || !probe.locator) {
      traceBlocked(
        "selector-missing",
        `state=${probe.state} xpath=${!!probe.xpath} locator=${!!probe.locator}`,
      );
      traceReturn("clickSympathyIfOff", "no_target");
      return clickResult({
        ok: false,
        clicked: false,
        verifiedOn: false,
        selector: null,
        error: "selector-missing",
        before: null,
        after: null,
        screenshotPath: await saveSympathyDebugScreenshot(page, "no_locator"),
        beforeScreenshotPath: null,
      });
    }

    if (probe.state === "on") {
      traceSkipped("already_liked", "probe.state=on");
      console.log("[sympathy] already red heart — skip");
      traceReturn("clickSympathyIfOff", "already_liked");
      return clickResult({
        ok: true,
        clicked: false,
        verifiedOn: true,
        selector: probe.matchedSelector,
        method: "already-on",
        before: probe.snapshot,
        after: probe.snapshot,
        screenshotPath: null,
        beforeScreenshotPath: null,
      });
    }

    const resolved = await resolveLikeClickLocator(page, probe.xpath);
    const loc = resolved.iconLoc;
    const beforeLive = await readLikeitLiveState(page);
    const before: DomSnapshot | null = beforeLive
      ? {
          tag: "a",
          className: beforeLive.className,
          ariaPressed: beforeLive.ariaPressed,
          ariaLabel: beforeLive.ariaLabel,
          text: beforeLive.text,
          dataType: null,
          innerHTML: beforeLive.innerHTML.slice(0, 200),
          svgFills: beforeLive.svgFills,
          svgStroke: beforeLive.svgStroke,
          inferred: beforeLive.on ? "on" : "off",
          signals: beforeLive.signals,
        }
      : ((await snapshotByXPath(page, probe.xpath)) ?? probe.snapshot);

    const scanTrusted = (probe.matchedSelector ?? "").startsWith("scan:");
    console.log(`[TRACE] clickSympathyIfOff scanTrusted=${scanTrusted}`);
    if (!scanTrusted) {
      const structure = await verifyActionBarNear(page, probe.xpath);
      console.log(
        `[sympathy] pre-click structure ok=${structure.ok} reason=${structure.reason ?? "ok"}`,
      );
      if (!structure.ok) {
        traceBlocked(
          "structure_fail",
          `reason=${structure.reason ?? "unknown"}`,
        );
        traceReturn("clickSympathyIfOff", "structure_fail");
        return clickResult({
          ok: false,
          clicked: false,
          verifiedOn: false,
          selector: probe.matchedSelector,
          error: `structure-fail:${structure.reason ?? "unknown"}`,
          before,
          after: null,
          screenshotPath: await saveSympathyDebugScreenshot(
            page,
            "structure_fail",
          ),
          beforeScreenshotPath: null,
        });
      }
    }

    console.log(
      `[sympathy] before-click class="${before?.className}" aria=${before?.ariaPressed} text="${before?.text}" fills=${JSON.stringify(before?.svgFills?.slice(0, 4) ?? [])} target=${resolved.hint} icon="${resolved.iconClass}"`,
    );
    logSnapshot("before-click", before);

    try {
      await resolved.parentLoc.scrollIntoViewIfNeeded({ timeout: 8_000 });
      await loc
        .scrollIntoViewIfNeeded({ timeout: 5_000 })
        .catch(() => undefined);
    } catch {
      await page
        .evaluate(`() => { window.scrollTo(0, document.body.scrollHeight); }`)
        .catch(() => undefined);
      await resolved.parentLoc
        .scrollIntoViewIfNeeded({ timeout: 5_000 })
        .catch(() => undefined);
    }
    await logViewportBox(page, loc, "pre-click-icon");
    await logViewportBox(page, resolved.parentLoc, "pre-click-parent");

    // Debug mode: ONE click + full evidence (no rapid fallback spray)
    const debugOn = sympathyDebugEnabled();
    traceSetCondition("debugEnabled", debugOn);
    traceSetCondition(
      "NAVER_LIKE_DEBUG",
      process.env.NAVER_LIKE_DEBUG ?? "(unset)",
    );
    traceSetCondition(
      "BROWSER_HEADLESS",
      process.env.BROWSER_HEADLESS ?? "(unset)",
    );
    traceGate(
      `evidence-gate debugOn=${debugOn} NAVER_LIKE_DEBUG=${process.env.NAVER_LIKE_DEBUG ?? "(unset)"} BROWSER_HEADLESS=${process.env.BROWSER_HEADLESS ?? "(unset)"}`,
    );
    if (!debugOn) {
      traceSkipped("debug_disabled", "using clickWithFallbacks");
    }
    if (debugOn) {
      console.log(
        "[sympathy] NAVER_LIKE_DEBUG active — single-click evidence mode (no fallback spray)",
      );
      console.log(`[TRACE] clickSympathyIfOff calling runLikeClickEvidence`);
      const evidence = await runLikeClickEvidence(page, resolved.parentLoc, {
        methodLabel: "parent-face-a|locator.click",
      });
      const afterSnap: DomSnapshot | null = evidence.face5s.found
        ? {
            tag: "a",
            className: evidence.face5s.className ?? "",
            ariaPressed: evidence.face5s.ariaPressed ?? null,
            ariaLabel: evidence.face5s.ariaLabel ?? null,
            text: "",
            dataType: null,
            innerHTML: (evidence.face5s.outerHTML ?? "").slice(0, 200),
            svgFills: [],
            svgStroke: [],
            inferred: evidence.verifiedOn ? "on" : "off",
            signals: [],
          }
        : null;

      if (!evidence.verifiedOn) {
        console.log(`[TRACE] evidence verifiedOn=false — hold then return`);
        await holdBrowserForDebug("like-still-off-after-evidence");
      }

      traceReturn(
        "clickSympathyIfOff",
        "evidence_done",
        `verifiedOn=${evidence.verifiedOn} error=${evidence.error ?? ""}`,
      );
      return clickResult({
        ok: evidence.verifiedOn,
        clicked: true,
        verifiedOn: evidence.verifiedOn,
        selector: `${probe.matchedSelector}|${evidence.method}`,
        method: evidence.method,
        error: evidence.error,
        before,
        after: afterSnap,
        screenshotPath: evidence.afterPath ?? evidence.after5sPath,
        beforeScreenshotPath: evidence.beforePath,
      });
    }

    const perfBefore = await page
      .evaluate(
        `(() => {
        try {
          var entries = performance.getEntriesByType('resource').length;
          return { resourceCount: entries, t: Date.now() };
        } catch (e) { return { resourceCount: -1, t: Date.now() }; }
      })()`,
      )
      .catch(() => ({ resourceCount: -1, t: Date.now() }));
    console.log(
      `[sympathy] perf-before resources=${(perfBefore as { resourceCount: number }).resourceCount}`,
    );

    const click = await clickWithFallbacks(page, resolved, networkHits);
    console.log(
      `[sympathy] click method=${click.method} ok=${click.ok} verifiedOn=${click.verifiedOn} networkTotal=${networkHits.length}`,
    );

    const perfAfter = await page
      .evaluate(
        `(() => {
        try {
          var entries = performance.getEntriesByType('resource');
          var likeish = [];
          for (var i = Math.max(0, entries.length - 40); i < entries.length; i++) {
            var n = entries[i].name || '';
            if (/likeit|sympathy|\\/like|emotion|react/i.test(n)) likeish.push(n.slice(0, 160));
          }
          return { resourceCount: entries.length, likeish: likeish.slice(0, 8) };
        } catch (e) { return { resourceCount: -1, likeish: [] }; }
      })()`,
      )
      .catch(() => ({ resourceCount: -1, likeish: [] as string[] }));
    console.log(
      `[sympathy] perf-after resources=${(perfAfter as { resourceCount: number }).resourceCount} likeish=${JSON.stringify((perfAfter as { likeish: string[] }).likeish)}`,
    );
    if (networkHits.length) {
      console.log(
        `[sympathy] network-like summary (${networkHits.length}): ${networkHits.slice(0, 5).join(" || ")}`,
      );
    } else {
      console.log("[sympathy] network-like summary: (none captured)");
    }

    if (!click.ok && !click.verifiedOn) {
      traceBlocked("click_failed", `method=${click.method}`);
      traceReturn("clickSympathyIfOff", "click_failed");
      return clickResult({
        ok: false,
        clicked: false,
        verifiedOn: false,
        selector: probe.matchedSelector,
        method: click.method,
        error: click.error ?? "click-failed",
        before,
        after: null,
        screenshotPath: await saveSympathyDebugScreenshot(page, "click_failed"),
        beforeScreenshotPath: await saveSympathyDebugScreenshot(
          page,
          "before_click",
        ),
      });
    }

    const verified = click.verifiedOn
      ? {
          on: true,
          state: "on" as SympathyState,
          snapshot: await readLikeitLiveState(page).then((s) =>
            s
              ? {
                  tag: "a",
                  className: s.className,
                  ariaPressed: s.ariaPressed,
                  ariaLabel: s.ariaLabel,
                  text: s.text,
                  dataType: null,
                  innerHTML: s.innerHTML.slice(0, 200),
                  svgFills: s.svgFills,
                  svgStroke: s.svgStroke,
                  inferred: "on" as SympathyState,
                  signals: s.signals,
                }
              : null,
          ),
        }
      : await waitForSympathyOn(page, probe.xpath, 5_000);

    const afterLive = await readLikeitLiveState(page);
    console.log(
      `[sympathy] after-click verify redHeart=${verified.on} class="${afterLive?.className ?? verified.snapshot?.className}" aria=${afterLive?.ariaPressed ?? verified.snapshot?.ariaPressed} text="${afterLive?.text ?? ""}" fills=${JSON.stringify((afterLive?.svgFills ?? verified.snapshot?.svgFills ?? []).slice(0, 4))} offToOn=${Boolean(before?.className && afterLive?.className && /\boff\b/i.test(before.className) && /\bon\b/i.test(afterLive.className) && !/\boff\b/i.test(afterLive.className))}`,
    );
    logSnapshot("after-click", verified.snapshot);

    let screenshotPath: string | null = null;
    if (!verified.on || sympathyDebugEnabled()) {
      screenshotPath = await saveSympathyDebugScreenshot(
        page,
        verified.on ? "after_ok" : "still_empty_heart",
      );
    }

    console.log(
      `[TRACE] RETURN reason=${verified.on ? "fallback_click_ok" : "still_empty_heart"}`,
    );
    traceReturn(
      "clickSympathyIfOff",
      verified.on ? "fallback_click_ok" : "still_empty_heart",
    );
    return clickResult({
      ok: verified.on,
      clicked: true,
      verifiedOn: verified.on,
      selector: `${probe.matchedSelector}|${click.method}`,
      method: click.method,
      error: verified.on
        ? undefined
        : networkHits.length
          ? "still-empty-heart-but-network-seen"
          : "still-empty-heart",
      before,
      after: verified.snapshot,
      screenshotPath,
      beforeScreenshotPath: null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`[sympathy] clickSympathyIfOff fatal: ${message}`);
    traceBlocked("fatal", message.slice(0, 200));
    if (sympathyDebugEnabled()) {
      await holdBrowserForDebug(`fatal:${message}`).catch(() => undefined);
    }
    traceReturn("clickSympathyIfOff", "fatal");
    return clickResult({
      ok: false,
      clicked: false,
      verifiedOn: false,
      selector: null,
      error: message,
      before: null,
      after: null,
      screenshotPath: await saveSympathyDebugScreenshot(page, "fatal").catch(
        () => null,
      ),
      beforeScreenshotPath: null,
    });
  } finally {
    page.off("request", onRequest);
  }
}

export async function waitForSympathyArea(
  page: Page,
  timeoutMs = 14_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await page
      .evaluate(
        `() => { window.scrollBy(0, Math.floor(window.innerHeight * 0.85)); }`,
      )
      .catch(() => undefined);
    const probe = await probeSympathyButton(page);
    if (probe.state !== "missing" && probe.xpath) return;
    await new Promise((r) => setTimeout(r, 300));
  }
}
