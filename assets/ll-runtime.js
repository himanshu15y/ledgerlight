/* Ledgerlight prototype runtime.
 * Renders one screen template: {{path}} holes, <sc-for>, <sc-if>, on* events,
 * and a Component class with state and setState. Small and dependency-free. */
(function () {
  'use strict';

  var tpl = document.getElementById('ll-tpl');
  var root = document.getElementById('ll-root');
  var logic = document.getElementById('ll-logic');
  if (!tpl || !root || !logic) return;

  function DCLogic(props) { this.props = props || {}; this.state = this.state || {}; }
  DCLogic.prototype.setState = function (patch) {
    var next = typeof patch === 'function' ? patch(this.state, this.props) : patch;
    this.state = Object.assign({}, this.state, next);
    schedule();
  };

  var props = {};
  try {
    var decl = JSON.parse(logic.getAttribute('data-props') || '{}');
    Object.keys(decl).forEach(function (k) {
      if (k.charAt(0) !== '$' && decl[k] && 'default' in decl[k]) props[k] = decl[k]['default'];
    });
  } catch (e) { /* no props */ }

  var Component = new Function('DCLogic', logic.textContent + '\n;return Component;')(DCLogic);
  var comp = new Component(props);
  if (!comp.state) comp.state = {};
  if (!comp.setState) comp.setState = DCLogic.prototype.setState;

  var HOLE = /\{\{\s*([^}]+?)\s*\}\}/g;
  var WHOLE = /^\s*\{\{\s*([^}]+?)\s*\}\}\s*$/;

  function lookup(path, scope) {
    path = path.trim();
    if (path === 'true') return true;
    if (path === 'false') return false;
    if (path === 'null') return null;
    if (/^-?\d+(\.\d+)?$/.test(path)) return Number(path);
    var m = /^(['"])(.*)\1$/.exec(path);
    if (m) return m[2];
    var parts = path.split('.');
    var cur = scope;
    for (var i = 0; i < parts.length; i++) {
      if (cur == null) return undefined;
      cur = cur[parts[i]];
    }
    return cur;
  }
  function str(v) { return v == null || v === false ? '' : String(v); }
  function interp(text, scope) { return text.replace(HOLE, function (_, p) { return str(lookup(p, scope)); }); }

  var EVENTS = { onClick: 'click', onKeyDown: 'keydown', onKeyUp: 'keyup', onInput: 'input', onSubmit: 'submit', onFocus: 'focus', onBlur: 'blur' };

  function bindAttrs(el, scope) {
    Array.prototype.slice.call(el.attributes).forEach(function (a) {
      var name = a.name, val = a.value;
      if (name.indexOf('hint-') === 0) { el.removeAttribute(name); return; }
      var whole = WHOLE.exec(val);
      // Attribute names are lower case in the DOM; map them back to the JSX names.
      var jsx = name.replace(/^on([a-z])/, function (_, c) { return 'on' + c.toUpperCase(); })
        .replace(/^onkeydown$/i, 'onKeyDown').replace(/^onkeyup$/i, 'onKeyUp');
      if (/^on[A-Z]/.test(jsx)) {
        el.removeAttribute(name);
        var fn = whole ? lookup(whole[1], scope) : null;
        if (typeof fn !== 'function') return;
        var type = EVENTS[jsx];
        if (jsx === 'onChange') {
          var tag = el.tagName;
          var textual = tag === 'TEXTAREA' || (tag === 'INPUT' && !/^(checkbox|radio)$/i.test(el.type));
          type = textual ? 'input' : 'change';
        }
        if (!type) type = jsx.slice(2).toLowerCase();
        el.addEventListener(type, function (ev) {
          if (type === 'submit') ev.preventDefault();
          if (el.tagName === 'A' && type === 'click' && el.getAttribute('href') === '#') ev.preventDefault();
          fn(ev);
        });
        return;
      }
      if (whole) {
        var v = lookup(whole[1], scope);
        if (name === 'value' && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')) {
          el.removeAttribute(name);
          el.__llValue = str(v);
          return;
        }
        if (name === 'checked' || name === 'disabled' || name === 'selected') {
          if (v) el.setAttribute(name, ''); else el.removeAttribute(name);
          if (name === 'checked') el.checked = !!v;
          return;
        }
        if (v === false || v == null) el.removeAttribute(name); else el.setAttribute(name, str(v));
        return;
      }
      if (val.indexOf('{{') !== -1) el.setAttribute(name, interp(val, scope));
    });
  }

  function renderChildren(src, dest, scope) {
    Array.prototype.forEach.call(src.childNodes, function (n) { renderNode(n, dest, scope); });
  }

  function renderNode(node, dest, scope) {
    if (node.nodeType === 3) {
      var t = node.nodeValue;
      dest.appendChild(document.createTextNode(t.indexOf('{{') === -1 ? t : interp(t, scope)));
      return;
    }
    if (node.nodeType !== 1) return;
    var tag = node.tagName.toLowerCase();
    if (tag === 'sc-for') {
      var listExpr = WHOLE.exec(node.getAttribute('list') || '');
      var list = listExpr ? lookup(listExpr[1], scope) : [];
      var as = node.getAttribute('as') || 'item';
      (Array.isArray(list) ? list : []).forEach(function (item, i) {
        var inner = Object.create(scope);
        inner[as] = item;
        inner.$index = i;
        renderChildren(node, dest, inner);
      });
      return;
    }
    if (tag === 'sc-if') {
      var condExpr = WHOLE.exec(node.getAttribute('value') || '');
      if (condExpr && lookup(condExpr[1], scope)) renderChildren(node, dest, scope);
      return;
    }
    var el = node.cloneNode(false);
    dest.appendChild(el);
    bindAttrs(el, scope);
    var srcKids = tag === 'template' ? node.content : node;
    renderChildren(srcKids, el, scope);
    if (el.__llValue !== undefined) {
      if (el.tagName === 'TEXTAREA') el.textContent = el.__llValue;
      el.value = el.__llValue;
    }
  }

  // Keep scroll positions and the focused field across a render.
  function pathOf(el) {
    var p = [];
    while (el && el !== root) { p.unshift(Array.prototype.indexOf.call(el.parentNode.children, el)); el = el.parentNode; }
    return el === root ? p : null;
  }
  function atPath(p) {
    var el = root;
    for (var i = 0; el && i < p.length; i++) el = el.children[p[i]];
    return el;
  }

  var queued = false;
  function schedule() {
    if (queued) return;
    queued = true;
    Promise.resolve().then(function () { queued = false; render(); });
  }

  function render() {
    var scrolls = [];
    Array.prototype.forEach.call(root.querySelectorAll('*'), function (el) {
      if (el.scrollTop || el.scrollLeft) scrolls.push([pathOf(el), el.scrollTop, el.scrollLeft]);
    });
    var active = document.activeElement && root.contains(document.activeElement) ? document.activeElement : null;
    var focusPath = active ? pathOf(active) : null;
    var sel = active && 'selectionStart' in active ? [active.selectionStart, active.selectionEnd] : null;

    var vals;
    try { vals = comp.renderVals ? comp.renderVals() || {} : {}; } catch (e) { console.error(e); vals = {}; }
    var scope = Object.assign(Object.create(null), vals);
    var frag = document.createDocumentFragment();
    renderChildren(tpl.content, frag, scope);
    root.replaceChildren(frag);

    scrolls.forEach(function (s) {
      if (!s[0]) return;
      var el = atPath(s[0]);
      if (el) { el.scrollTop = s[1]; el.scrollLeft = s[2]; }
    });
    if (focusPath) {
      var f = atPath(focusPath);
      if (f && f.focus) {
        f.focus();
        if (sel && 'setSelectionRange' in f) { try { f.setSelectionRange(sel[0], sel[1]); } catch (e) { /* not a text field */ } }
      }
    }
  }

  render();
  if (typeof comp.componentDidMount === 'function') comp.componentDidMount();
})();
