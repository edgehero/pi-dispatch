/**
 * The browser script's world, without a browser (issue #737): a small DOM that parses the console's own markup, a CSS
 * selector matcher for the selectors the script uses, events that bubble, focus, and stubs for `EventSource`, `fetch`,
 * the timers, `Date`, `location` and `history`. `runConsoleScript` runs the real `CONSOLE_SCRIPT` over a page the
 * server drew (`page()` output, a golden), so a test can drive it (a stream event, a fetch answered, a click, two
 * seconds passing) and read what the page shows.
 *
 * WHY EVERY GLOBAL IS A PARAMETER. The script is run with `new Function(...GLOBALS, CONSOLE_SCRIPT)`, and each name the
 * script could reach outside the language itself is in `GLOBALS`, bound to a stub. A name left out would be Node's own:
 * Node 22 has a global `fetch`, which reaches the network, so a probe test that forgot it would take the real network
 * path (or fail it) in silence. `trapGlobalFetch` turns that mistake into a failure.
 *
 * WHAT IT IS NOT. It parses what `html.mjs` writes (well-formed, quoted attributes, the five entities it emits and
 * numeric ones), not arbitrary HTML; it has no layout (no `getBoundingClientRect`, which the script checks for before
 * using, so the navigation and More placement stay out of it: `console-live-pill.test.mjs` drives those with boxes of
 * its own; `scrollIntoView` only records what it was asked, in `document.scrolls`); and a selector it does not
 * understand throws, so a script change that needs more of CSS says so here instead of matching nothing.
 */

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
/** Elements whose content is text, never markup, for a browser running scripts (`noscript` included). */
const RAW = new Set(["script", "style", "noscript"]);
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" };

function decode(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, e) => {
    if (e[0] === "#") return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return Object.hasOwn(ENTITIES, e) ? ENTITIES[e] : m;
  });
}
const escText = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\u00a0/g, "&nbsp;");
const escAttr = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/\u00a0/g, "&nbsp;");

// ---- events ---------------------------------------------------------------------------------------------------------

export class Event {
  constructor(type, init = {}) {
    const { bubbles = false, ...rest } = init;
    Object.assign(this, rest);
    this.type = type;
    this.bubbles = bubbles;
    this.defaultPrevented = false;
    this.target = null;
    this.currentTarget = null;
    this.stopped = false;
  }

  preventDefault() {
    this.defaultPrevented = true;
  }

  stopPropagation() {
    this.stopped = true;
  }
}

// ---- nodes ----------------------------------------------------------------------------------------------------------

class Node {
  constructor(doc) {
    this.ownerDocument = doc;
    this.parentNode = null;
    this.childNodes = [];
    this.listeners = new Map();
  }

  get parentElement() {
    return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null;
  }

  /**
   * A node as `console.log` and a test's own message print it: its tag, id and class, never the whole tree (a node
   * holds its document and its parent, so the default inspection walks the page, sprite and all). An assertion's diff
   * turns custom inspection off, so a test compares elements with `===` inside `assert.ok` instead of handing two of
   * them to `assert.equal`, whose failure would spend minutes formatting.
   */
  [Symbol.for("nodejs.util.inspect.custom")]() {
    if (this.nodeType === 3) return `#text ${JSON.stringify(this.data.slice(0, 40))}`;
    if (this.nodeType !== 1) return this.nodeType === 9 ? "#document" : "#fragment";
    const id = this.getAttribute("id");
    const cls = this.getAttribute("class");
    return `<${this.localName}${id ? ` id="${id}"` : ""}${cls ? ` class="${cls}"` : ""}>`;
  }

  get firstChild() {
    return this.childNodes[0] ?? null;
  }

  get lastChild() {
    return this.childNodes.at(-1) ?? null;
  }

  get children() {
    return this.childNodes.filter((n) => n.nodeType === 1);
  }

  get firstElementChild() {
    return this.children[0] ?? null;
  }

  get nextSibling() {
    const p = this.parentNode;
    return p ? (p.childNodes[p.childNodes.indexOf(this) + 1] ?? null) : null;
  }

  get previousSibling() {
    const p = this.parentNode;
    return p ? (p.childNodes[p.childNodes.indexOf(this) - 1] ?? null) : null;
  }

  get nextElementSibling() {
    for (let n = this.nextSibling; n; n = n.nextSibling) if (n.nodeType === 1) return n;
    return null;
  }

  get previousElementSibling() {
    for (let n = this.previousSibling; n; n = n.previousSibling) if (n.nodeType === 1) return n;
    return null;
  }

  insertBefore(node, ref) {
    if (ref !== null && ref !== undefined && ref.parentNode !== this) throw new Error("insertBefore: the reference is not a child");
    const nodes = node.nodeType === 11 ? [...node.childNodes] : [node];
    for (const n of nodes) {
      if (n === this || n.contains(this)) throw new Error("insertBefore: a node cannot hold itself");
      if (n.parentNode) n.parentNode.removeChild(n);
      const at = ref === null || ref === undefined ? this.childNodes.length : this.childNodes.indexOf(ref);
      this.childNodes.splice(at, 0, n);
      n.parentNode = this;
    }
    return node;
  }

  appendChild(node) {
    return this.insertBefore(node, null);
  }

  removeChild(node) {
    const at = this.childNodes.indexOf(node);
    if (at < 0) throw new Error("removeChild: not a child");
    this.childNodes.splice(at, 1);
    node.parentNode = null;
    return node;
  }

  remove() {
    this.parentNode?.removeChild(this);
  }

  append(...nodes) {
    for (const n of nodes) this.appendChild(typeof n === "string" ? this.ownerDocument.createTextNode(n) : n);
  }

  prepend(...nodes) {
    const first = this.firstChild;
    for (const n of nodes) this.insertBefore(typeof n === "string" ? this.ownerDocument.createTextNode(n) : n, first);
  }

  after(...nodes) {
    const p = this.parentNode;
    if (!p) return;
    // The DOM's viable next sibling: the first one after this that is not being moved, so a node that already follows
    // this one stays where it is (the slot asked for twice after the same card).
    let next = this.nextSibling;
    while (next && nodes.includes(next)) next = next.nextSibling;
    for (const n of nodes) p.insertBefore(n, next);
  }

  before(...nodes) {
    const p = this.parentNode;
    if (!p) return;
    for (const n of nodes) p.insertBefore(n, this);
  }

  replaceChildren(...nodes) {
    for (const n of [...this.childNodes]) this.removeChild(n);
    this.append(...nodes);
  }

  contains(node) {
    for (let a = node; a; a = a.parentNode) if (a === this) return true;
    return false;
  }

  get textContent() {
    return this.childNodes.map((n) => n.textContent).join("");
  }

  set textContent(v) {
    for (const n of [...this.childNodes]) this.removeChild(n);
    const text = String(v ?? "");
    if (text !== "") this.appendChild(this.ownerDocument.createTextNode(text));
  }

  addEventListener(type, fn) {
    if (typeof fn !== "function") return;
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }

  removeEventListener(type, fn) {
    const list = this.listeners.get(type);
    if (list) this.listeners.set(type, list.filter((f) => f !== fn));
  }

  /** Dispatch `ev` at this node, then (when it bubbles) at each ancestor, up to the document. */
  dispatchEvent(ev) {
    ev.target = this;
    const path = [];
    for (let n = this; n; n = n.parentNode) {
      path.push(n);
      if (!ev.bubbles) break;
    }
    for (const n of path) {
      ev.currentTarget = n;
      for (const fn of [...(n.listeners.get(ev.type) ?? [])]) fn.call(n, ev);
      if (ev.stopped) break;
    }
    return !ev.defaultPrevented;
  }

  /** The descendant elements, in document order (a template's content is not among them, as in a browser). */
  *descendants() {
    for (const n of this.childNodes) {
      if (n.nodeType !== 1) continue;
      yield n;
      yield* n.descendants();
    }
  }

  querySelectorAll(selector) {
    const list = parseSelectors(selector);
    return [...this.descendants()].filter((el) => list.some((c) => matchComplex(el, c)));
  }

  querySelector(selector) {
    const list = parseSelectors(selector);
    for (const el of this.descendants()) if (list.some((c) => matchComplex(el, c))) return el;
    return null;
  }
}

class Text extends Node {
  constructor(doc, data) {
    super(doc);
    this.nodeType = 3;
    this.data = String(data);
  }

  get nodeValue() {
    return this.data;
  }

  set nodeValue(v) {
    this.data = String(v);
  }

  get textContent() {
    return this.data;
  }

  set textContent(v) {
    this.data = String(v ?? "");
  }

  cloneNode() {
    return new Text(this.ownerDocument, this.data);
  }
}

class Fragment extends Node {
  constructor(doc) {
    super(doc);
    this.nodeType = 11;
  }

  cloneNode(deep = false) {
    const f = new Fragment(this.ownerDocument);
    if (deep) for (const n of this.childNodes) f.appendChild(n.cloneNode(true));
    return f;
  }
}

class Element extends Node {
  constructor(doc, localName) {
    super(doc);
    this.nodeType = 1;
    this.localName = localName;
    this.attrs = new Map();
    this.style = {};
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.clientHeight = 0;
    // The live state of a form control, as a browser keeps it apart from its attributes.
    this.liveValue = null;
    this.liveChecked = null;
    if (localName === "template") this.content = new Fragment(doc);
  }

  get tagName() {
    return this.localName.toUpperCase();
  }

  getAttribute(name) {
    return this.attrs.has(name) ? this.attrs.get(name) : null;
  }

  setAttribute(name, value) {
    this.attrs.set(String(name), String(value));
  }

  removeAttribute(name) {
    this.attrs.delete(name);
  }

  hasAttribute(name) {
    return this.attrs.has(name);
  }

  toggleAttribute(name, on) {
    const want = on === undefined ? !this.attrs.has(name) : Boolean(on);
    if (want) this.attrs.set(name, this.attrs.get(name) ?? "");
    else this.attrs.delete(name);
    return want;
  }

  get id() {
    return this.getAttribute("id") ?? "";
  }

  set id(v) {
    this.setAttribute("id", v);
  }

  get className() {
    return this.getAttribute("class") ?? "";
  }

  set className(v) {
    this.setAttribute("class", v);
  }

  get classList() {
    const el = this;
    const list = () => el.className.split(/\s+/).filter(Boolean);
    const write = (l) => el.setAttribute("class", l.join(" "));
    return {
      contains: (c) => list().includes(c),
      add: (...cs) => write([...new Set([...list(), ...cs])]),
      remove: (...cs) => write(list().filter((c) => !cs.includes(c))),
      toggle: (c, on) => {
        const want = on === undefined ? !list().includes(c) : Boolean(on);
        if (want) write([...new Set([...list(), c])]);
        else write(list().filter((x) => x !== c));
        return want;
      },
    };
  }

  get hidden() {
    return this.hasAttribute("hidden");
  }

  set hidden(v) {
    this.toggleAttribute("hidden", Boolean(v));
  }

  get disabled() {
    return this.hasAttribute("disabled");
  }

  set disabled(v) {
    this.toggleAttribute("disabled", Boolean(v));
  }

  get name() {
    return this.getAttribute("name") ?? "";
  }

  get type() {
    if (this.localName === "input") return (this.getAttribute("type") ?? "text").toLowerCase();
    if (this.localName === "button") return (this.getAttribute("type") ?? "submit").toLowerCase();
    if (this.localName === "textarea") return "textarea";
    if (this.localName === "select") return "select-one";
    return this.getAttribute("type") ?? "";
  }

  get defaultValue() {
    if (this.localName === "textarea") return this.textContent;
    return this.getAttribute("value") ?? "";
  }

  get value() {
    if (this.localName === "select") {
      const options = this.querySelectorAll("option");
      const chosen = options.find((o) => o.liveSelected ?? o.hasAttribute("selected")) ?? options[0];
      return chosen ? (chosen.getAttribute("value") ?? chosen.textContent) : "";
    }
    return this.liveValue ?? this.defaultValue;
  }

  set value(v) {
    this.liveValue = String(v);
  }

  get checked() {
    return this.liveChecked ?? this.hasAttribute("checked");
  }

  set checked(v) {
    this.liveChecked = Boolean(v);
  }

  /** A form's controls, in document order. */
  get elements() {
    return this.querySelectorAll("input, textarea, select, button");
  }

  matches(selector) {
    return parseSelectors(selector).some((c) => matchComplex(this, c));
  }

  closest(selector) {
    const list = parseSelectors(selector);
    for (let el = this; el && el.nodeType === 1; el = el.parentElement) if (list.some((c) => matchComplex(el, c))) return el;
    return null;
  }

  get innerHTML() {
    return (this.localName === "template" ? this.content : this).childNodes.map(serialize).join("");
  }

  set innerHTML(markup) {
    const into = this.localName === "template" ? this.content : this;
    for (const n of [...into.childNodes]) into.removeChild(n);
    parseInto(this.ownerDocument, into, String(markup), this.localName);
  }

  get outerHTML() {
    return serialize(this);
  }

  insertAdjacentHTML(position, markup) {
    if (position !== "beforeend") throw new Error(`insertAdjacentHTML: only beforeend is stubbed, not ${position}`);
    parseInto(this.ownerDocument, this, String(markup), this.localName);
  }

  cloneNode(deep = false) {
    const el = new Element(this.ownerDocument, this.localName);
    for (const [k, v] of this.attrs) el.attrs.set(k, v);
    if (deep) {
      for (const n of this.childNodes) el.appendChild(n.cloneNode(true));
      if (this.content) el.content = this.content.cloneNode(true);
    }
    return el;
  }

  focus() {
    this.ownerDocument.moveFocus(this);
  }

  /** No layout here, so a scroll is recorded, not made: the element and the options it was asked with. */
  scrollIntoView(options) {
    this.ownerDocument.scrolls.push({ el: this, options });
  }

  blur() {
    if (this.ownerDocument.activeElement === this) this.ownerDocument.moveFocus(this.ownerDocument.body);
  }

  /** A click as a browser runs it: the event, then (a submit button in a form, not prevented) the form's submit. */
  click() {
    if (this.disabled) return;
    const ev = new Event("click", { bubbles: true });
    const go = this.dispatchEvent(ev);
    const form = this.closest("form");
    if (go && form && this.localName === "button" && this.type === "submit") form.dispatchEvent(new Event("submit", { bubbles: true, submitter: this }));
  }
}

class Document extends Node {
  constructor() {
    super(null);
    this.ownerDocument = this;
    this.nodeType = 9;
    this.cookies = [];
    this.activeElement = null;
    // Each `scrollIntoView` asked of an element, in order.
    this.scrolls = [];
  }

  get documentElement() {
    return this.children.find((n) => n.localName === "html") ?? null;
  }

  get head() {
    return this.documentElement?.children.find((n) => n.localName === "head") ?? null;
  }

  get body() {
    return this.documentElement?.children.find((n) => n.localName === "body") ?? null;
  }

  /** The theme cookie is only ever written (`console-shell.test.mjs` holds that); a read here is a failure. */
  get cookie() {
    throw new Error("the script never reads document.cookie");
  }

  set cookie(v) {
    this.cookies.push(String(v));
  }

  createElement(name) {
    return new Element(this, String(name).toLowerCase());
  }

  createTextNode(data) {
    return new Text(this, data);
  }

  createDocumentFragment() {
    return new Fragment(this);
  }

  getElementById(id) {
    for (const el of this.descendants()) if (el.getAttribute("id") === id) return el;
    return null;
  }

  /** Focus moves from the active element to `to`: focusout on the one it leaves, focusin on the one it reaches. */
  moveFocus(to) {
    const from = this.activeElement;
    if (from === to) return;
    this.activeElement = to;
    if (from && from !== this.body) from.dispatchEvent(new Event("focusout", { bubbles: true, relatedTarget: to }));
    if (to && to !== this.body) to.dispatchEvent(new Event("focusin", { bubbles: true, relatedTarget: from }));
  }
}

// ---- parsing and serializing ---------------------------------------------------------------------------------------

const ATTR_RE = /\s*([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/y;

/** Parse `markup` into `parent` (a child list of the element `context`, whose own content model may be raw text). */
function parseInto(doc, parent, markup, context = null) {
  if (RAW.has(context) || context === "textarea") {
    if (markup !== "") parent.appendChild(doc.createTextNode(context === "textarea" ? decode(markup) : markup));
    return;
  }
  const stack = [parent];
  const top = () => stack.at(-1);
  const into = (el) => (el.localName === "template" ? el.content : el);
  let i = 0;
  while (i < markup.length) {
    const lt = markup.indexOf("<", i);
    if (lt < 0 || lt > i) {
      const end = lt < 0 ? markup.length : lt;
      into(top()).appendChild(doc.createTextNode(decode(markup.slice(i, end))));
      i = end;
      continue;
    }
    if (markup.startsWith("<!--", i)) {
      const end = markup.indexOf("-->", i + 4);
      i = end < 0 ? markup.length : end + 3;
      continue;
    }
    if (markup.startsWith("<!", i)) {
      const end = markup.indexOf(">", i);
      i = end < 0 ? markup.length : end + 1;
      continue;
    }
    const close = /^<\/([a-zA-Z][\w:-]*)\s*>/.exec(markup.slice(i));
    if (close) {
      const name = close[1].toLowerCase();
      // Close the nearest open element of that name; a stray end tag closes nothing.
      for (let d = stack.length - 1; d > 0; d--) {
        if (stack[d].localName === name) {
          stack.length = d;
          break;
        }
      }
      i += close[0].length;
      continue;
    }
    const open = /^<([a-zA-Z][\w:-]*)/.exec(markup.slice(i));
    if (!open) {
      into(top()).appendChild(doc.createTextNode("<"));
      i += 1;
      continue;
    }
    const el = doc.createElement(open[1]);
    let at = i + open[0].length;
    for (;;) {
      ATTR_RE.lastIndex = at;
      const m = ATTR_RE.exec(markup);
      if (!m || m.index !== at || m[0].trim() === "") break;
      const v = m[2] ?? m[3] ?? m[4] ?? "";
      el.attrs.set(m[1].toLowerCase(), decode(v));
      at = ATTR_RE.lastIndex;
    }
    const gt = markup.indexOf(">", at);
    if (gt < 0) throw new Error(`script-dom: an unclosed <${open[1]}> tag`);
    const selfClosed = markup[gt - 1] === "/";
    into(top()).appendChild(el);
    i = gt + 1;
    const name = el.localName;
    if (RAW.has(name) || name === "textarea") {
      const endTag = markup.toLowerCase().indexOf(`</${name}`, i);
      const end = endTag < 0 ? markup.length : endTag;
      let text = markup.slice(i, end);
      // The parser drops the first newline after <textarea> (kit.mjs `textarea` relies on it).
      if (name === "textarea" && text.startsWith("\n")) text = text.slice(1);
      if (text !== "") el.appendChild(doc.createTextNode(name === "textarea" ? decode(text) : text));
      const after = endTag < 0 ? markup.length : markup.indexOf(">", endTag);
      i = after < 0 ? markup.length : after + 1;
      continue;
    }
    if (!VOID.has(name) && !selfClosed) stack.push(el);
  }
}

function serialize(n) {
  if (n.nodeType === 3) return RAW.has(n.parentNode?.localName) ? n.data : escText(n.data);
  if (n.nodeType === 11) return n.childNodes.map(serialize).join("");
  const attrs = [...n.attrs].map(([k, v]) => ` ${k}="${escAttr(v)}"`).join("");
  if (VOID.has(n.localName)) return `<${n.localName}${attrs}>`;
  const kids = (n.localName === "template" ? n.content : n).childNodes.map(serialize).join("");
  return `<${n.localName}${attrs}>${kids}</${n.localName}>`;
}

/** A whole page (`page()`'s output, a golden) as a document. */
export function parseDocument(markup) {
  const doc = new Document();
  parseInto(doc, doc, String(markup));
  if (!doc.body) throw new Error("script-dom: the page has no <body>");
  doc.activeElement = doc.body;
  return doc;
}

// ---- selectors ------------------------------------------------------------------------------------------------------

const cache = new Map();

/** A selector list split at its top-level commas, each a list of `{ comb, compound }` read left to right. */
function parseSelectors(selector) {
  const key = String(selector);
  if (cache.has(key)) return cache.get(key);
  const parts = [];
  let depth = 0;
  let quote = null;
  let from = 0;
  for (let i = 0; i < key.length; i++) {
    const c = key[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (c === "," && depth === 0) {
      parts.push(key.slice(from, i));
      from = i + 1;
    }
  }
  parts.push(key.slice(from));
  const list = parts.map((p) => parseComplex(p.trim(), key));
  cache.set(key, list);
  return list;
}

function parseComplex(s, whole) {
  const out = [];
  let i = 0;
  let comb = null;
  while (i < s.length) {
    const ws = /^\s*([>+~])?\s*/.exec(s.slice(i));
    if (ws[0].length > 0) {
      if (out.length > 0) comb = ws[1] ?? " ";
      i += ws[0].length;
      continue;
    }
    const { compound, length } = parseCompound(s.slice(i), whole);
    out.push({ comb: out.length === 0 ? null : (comb ?? " "), compound });
    comb = null;
    i += length;
  }
  if (out.length === 0) throw new Error(`script-dom: an empty selector in ${JSON.stringify(whole)}`);
  return out;
}

function parseCompound(s, whole) {
  const c = { tag: null, ids: [], classes: [], attrs: [], nots: [] };
  let i = 0;
  for (;;) {
    const rest = s.slice(i);
    let m;
    if ((m = /^\*/.exec(rest))) c.tag = null;
    else if ((m = /^[a-zA-Z][\w-]*/.exec(rest))) c.tag = m[0].toLowerCase();
    else if ((m = /^#([\w-]+)/.exec(rest))) c.ids.push(m[1]);
    else if ((m = /^\.([\w-]+)/.exec(rest))) c.classes.push(m[1]);
    else if ((m = /^\[\s*([\w-]+)\s*(?:(=)\s*(?:"([^"]*)"|'([^']*)'|([^\]\s"']+))\s*)?\]/.exec(rest))) c.attrs.push({ name: m[1].toLowerCase(), value: m[2] ? (m[3] ?? m[4] ?? m[5]) : null });
    else if ((m = /^:not\(/.exec(rest))) {
      let depth = 1;
      let j = m[0].length;
      for (; j < rest.length && depth > 0; j++) {
        if (rest[j] === "(") depth++;
        else if (rest[j] === ")") depth--;
      }
      if (depth !== 0) throw new Error(`script-dom: an unclosed :not( in ${JSON.stringify(whole)}`);
      c.nots.push(parseSelectors(rest.slice(m[0].length, j - 1)));
      m = [rest.slice(0, j)];
    } else break;
    i += m[0].length;
  }
  if (i === 0) throw new Error(`script-dom: a selector this stub does not read: ${JSON.stringify(whole)} at ${JSON.stringify(s)}`);
  return { compound: c, length: i };
}

function matchCompound(el, c) {
  if (!el || el.nodeType !== 1) return false;
  if (c.tag && el.localName !== c.tag) return false;
  for (const id of c.ids) if (el.getAttribute("id") !== id) return false;
  for (const cls of c.classes) if (!el.className.split(/\s+/).includes(cls)) return false;
  for (const a of c.attrs) {
    if (!el.hasAttribute(a.name)) return false;
    if (a.value !== null && el.getAttribute(a.name) !== a.value) return false;
  }
  for (const not of c.nots) if (not.some((cx) => matchComplex(el, cx))) return false;
  return true;
}

/** Whether `el` matches the complex selector `parts`, read right to left as a browser does. */
function matchComplex(el, parts, at = parts.length - 1) {
  if (!matchCompound(el, parts[at].compound)) return false;
  if (at === 0) return true;
  const comb = parts[at].comb;
  if (comb === ">") return matchComplex(el.parentElement, parts, at - 1);
  if (comb === "+") return matchComplex(el.previousElementSibling, parts, at - 1);
  if (comb === "~") {
    for (let s = el.previousElementSibling; s; s = s.previousElementSibling) if (matchComplex(s, parts, at - 1)) return true;
    return false;
  }
  for (let a = el.parentElement; a; a = a.parentElement) if (matchComplex(a, parts, at - 1)) return true;
  return false;
}

// ---- the stubs the script runs against -------------------------------------------------------------------------------

/** Timers on a clock of their own: nothing fires until `tick(ms)` moves it. `now()` is that clock (epoch ms). */
export function fakeTimers(start = Date.UTC(2026, 9, 24, 12, 0, 0)) {
  let now = start;
  let seq = 0;
  const due = new Map();
  const add = (fn, ms, every) => {
    const id = ++seq;
    due.set(id, { at: now + Math.max(0, Number(ms) || 0), fn, every });
    return id;
  };
  return {
    setTimeout: (fn, ms) => add(fn, ms, null),
    clearTimeout: (id) => due.delete(id),
    setInterval: (fn, ms) => add(fn, ms, Math.max(1, Number(ms) || 0)),
    clearInterval: (id) => due.delete(id),
    requestAnimationFrame: (fn) => add(fn, 16, null),
    now: () => now,
    /** How many timers wait, and how many of them wait for exactly `ms`. */
    pending: (ms = null) => [...due.values()].filter((t) => ms === null || t.every === ms || (t.every === null && t.at - now === ms)).length,
    /**
     * Move the clock `ms` forward WITHOUT running a timer (a machine asleep, a throttled tab): a timer due meanwhile runs
     * at the next `tick`, late, with the clock where it now is.
     */
    jump(ms) {
      now += ms;
    },
    /** Move the clock `ms` forward, running every timer that falls due on the way, in order. */
    tick(ms) {
      const end = now + ms;
      for (;;) {
        let next = null;
        for (const [id, t] of due) if (t.at <= end && (next === null || t.at < due.get(next).at)) next = id;
        if (next === null) break;
        const t = due.get(next);
        // A timer overdue after a jump runs now, never back at the time it was due.
        now = Math.max(now, t.at);
        if (t.every === null) due.delete(next);
        else t.at += t.every;
        t.fn();
      }
      now = end;
    },
  };
}

/**
 * A `Date` on the timers' clock, in UTC whatever the machine's zone, so a test's local times are its own. Not a
 * subclass of `Date`: under the suite's shifted clock (`.github/scripts/shift-clock.mjs`) the global `Date` is a
 * function that RETURNS a plain date, so a subclass's `super()` would hand back an object without these methods (and
 * read the machine's zone). Each date here is a real one, its prototype pointed at this one, which keeps every built-in
 * method working on it.
 */
export function fakeDate(timers) {
  const Base = Date;
  function FakeDate(...args) {
    if (new.target === undefined) return new Base(timers.now()).toString();
    const d = new Base(...(args.length === 0 ? [timers.now()] : args));
    Object.setPrototypeOf(d, FakeDate.prototype);
    return d;
  }
  FakeDate.prototype = Object.create(Base.prototype, {
    getTimezoneOffset: { value: () => 0 },
    getFullYear: { value() { return this.getUTCFullYear(); } },
    getMonth: { value() { return this.getUTCMonth(); } },
    getDate: { value() { return this.getUTCDate(); } },
    getHours: { value() { return this.getUTCHours(); } },
    getMinutes: { value() { return this.getUTCMinutes(); } },
  });
  FakeDate.now = () => timers.now();
  FakeDate.UTC = Base.UTC;
  FakeDate.parse = Base.parse;
  return FakeDate;
}

/**
 * `fetch` that answers only when the test says: each call is recorded (`calls`) and held until `answer(status, body)`
 * or `fail()` (no answer: the browser's TypeError). A body that is not an object reads as a page that is not JSON.
 */
export function fakeFetch() {
  const calls = [];
  function fetch(url, init = {}) {
    let settle;
    const promise = new Promise((resolve, reject) => {
      settle = { resolve, reject };
    });
    const call = {
      url: String(url),
      method: init.method ?? "GET",
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
      init,
      done: false,
      answer(status, body = {}) {
        if (call.done) throw new Error(`${call.url} was answered twice`);
        call.done = true;
        settle.resolve({ ok: status >= 200 && status < 300, status, json: async () => {
          if (body === null || typeof body !== "object") throw new SyntaxError("Unexpected token < in JSON");
          return JSON.parse(JSON.stringify(body));
        } });
        return flush();
      },
      fail() {
        if (call.done) throw new Error(`${call.url} was answered twice`);
        call.done = true;
        settle.reject(new TypeError("Failed to fetch"));
        return flush();
      },
    };
    calls.push(call);
    return promise;
  }
  fetch.calls = calls;
  /** The last call to `url` (a path, matched exactly) not yet answered; throws when there is none. */
  fetch.open = (url) => {
    const c = [...calls].reverse().find((x) => x.url === url && !x.done);
    if (!c) throw new Error(`no request to ${url} is waiting (made: ${calls.map((x) => `${x.url}${x.done ? " (answered)" : ""}`).join(", ") || "none"})`);
    return c;
  };
  return fetch;
}

/** Every promise chain the script hung on an answer runs (they are microtasks; a macrotask turn drains them). */
export async function flush() {
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
}

/** `EventSource`, recorded: `streams` holds each one opened, and `emit(type, data)` delivers an event to it. */
export function fakeEventSource() {
  const streams = [];
  function EventSource(url) {
    this.url = String(url);
    this.readyState = 0;
    this.closed = false;
    this.listeners = new Map();
    this.addEventListener = (type, fn) => {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(fn);
    };
    this.close = () => {
      this.closed = true;
      this.readyState = 2;
    };
    /** Deliver `type` with `data` (an object is sent as JSON, as the hub writes it); nothing reaches a closed stream. */
    this.emit = (type, data = undefined, lastEventId = "") => {
      if (this.closed && type !== "error") return;
      if (type === "open") this.readyState = 1;
      const ev = { type, lastEventId, data: data === undefined ? "" : typeof data === "string" ? data : JSON.stringify(data) };
      for (const fn of this.listeners.get(type) ?? []) fn(ev);
    };
    streams.push(this);
  }
  EventSource.streams = streams;
  return EventSource;
}

/**
 * Every name the script may reach beyond the language: each is a parameter of the function it runs in, so none is
 * ever Node's own.
 */
export const GLOBALS = Object.freeze(["document", "location", "history", "fetch", "EventSource", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "requestAnimationFrame", "navigator", "isSecureContext", "Date", "URL", "URLSearchParams", "getComputedStyle", "ResizeObserver", "MouseEvent", "window", "innerHeight"]);

/**
 * Run `script` (the console's `CONSOLE_SCRIPT`) over `markup` (a whole page) at `url` (its path, query and fragment).
 * Returns the world: `document`, `location` (with `assigned`, `replaced` and `reloads` recorded), `history`, `fetch`,
 * `EventSource` (and `streams`), `timers`, and the helpers `submit(form, submitter)`, `type(field, value)`, `tick` and
 * `hash(fragment)`. `innerHeight` is the window's height for a test that gives an element a box of its own
 * (`getBoundingClientRect`); left out, the script has no measure, as with no layout.
 */
export function runConsoleScript(script, markup, { url = "/", fetch = fakeFetch(), timers = fakeTimers(), navigator = {}, secure = false, innerHeight = undefined } = {}) {
  const document = parseDocument(markup);
  const at = new URL(url, "http://127.0.0.1:4790");
  const location = {
    href: at.href,
    origin: at.origin,
    pathname: at.pathname,
    search: at.search,
    hash: at.hash,
    assigned: [],
    replaced: [],
    reloads: 0,
    assign(u) {
      this.assigned.push(String(u));
    },
    replace(u) {
      this.replaced.push(String(u));
    },
    reload() {
      this.reloads += 1;
    },
  };
  const history = {
    states: [],
    replaceState(_state, _title, u) {
      this.states.push(String(u));
      const next = new URL(String(u), at);
      location.pathname = next.pathname;
      location.search = next.search;
      location.hash = next.hash;
    },
  };
  const EventSource = fakeEventSource();
  // The window's own events (the link page's hashchange): listeners by type, fired by `hash` below.
  const windowListeners = new Map();
  const window = {
    addEventListener(type, fn) {
      if (!windowListeners.has(type)) windowListeners.set(type, []);
      windowListeners.get(type).push(fn);
    },
  };
  const values = {
    document,
    location,
    history,
    fetch,
    EventSource,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
    requestAnimationFrame: timers.requestAnimationFrame,
    navigator,
    isSecureContext: secure,
    Date: fakeDate(timers),
    URL,
    URLSearchParams,
    getComputedStyle: undefined,
    ResizeObserver: undefined,
    MouseEvent: undefined,
    window,
    innerHeight,
  };
  new Function(...GLOBALS, script)(...GLOBALS.map((k) => values[k]));
  return {
    document,
    location,
    history,
    fetch,
    EventSource,
    streams: EventSource.streams,
    timers,
    /** A form submitted as a browser does it: the submit event at the form, bubbling, with the button that sent it. */
    submit(form, submitter = form.querySelector("button[type=submit]")) {
      form.dispatchEvent(new Event("submit", { bubbles: true, submitter }));
    },
    /** A field typed into: focused, its value set. */
    type(field, value) {
      field.focus();
      field.value = value;
    },
    tick: (ms) => timers.tick(ms),
    /** A new fragment in the address bar of the same page (a link pasted in): no page loads, `hashchange` fires. */
    hash(fragment) {
      location.hash = fragment;
      for (const fn of windowListeners.get("hashchange") ?? []) fn({ type: "hashchange" });
    },
  };
}

/**
 * Replace Node's global `fetch` with a trap for the length of `fn`, so a test whose script reached the global (a name
 * left out of `GLOBALS`, or a stub passed as undefined) fails loudly instead of taking the network path.
 */
export async function trapGlobalFetch(fn) {
  const real = globalThis.fetch;
  const reached = [];
  globalThis.fetch = (...args) => {
    reached.push(String(args[0]));
    return Promise.reject(new Error("the test reached Node's own fetch"));
  };
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
    if (reached.length > 0) throw new Error(`the script reached Node's own fetch for ${reached.join(", ")}: pass fetch as a parameter`);
  }
}

/** Whether `el` shows: neither it nor any ancestor is `hidden`. */
export function shown(el) {
  for (let a = el; a && a.nodeType === 1; a = a.parentElement) if (a.hidden) return false;
  return Boolean(el);
}
