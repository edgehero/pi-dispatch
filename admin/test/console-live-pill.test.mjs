import assert from "node:assert/strict";
import { test } from "node:test";
import { CONSOLE_SCRIPT } from "../src/console/script.mjs";
import { LIVE_STATES } from "../src/console/shell.mjs";

// The browser script on a live page (issue #737): the live pill through every state of the stream, the panel swap and
// what it reveals, the end of a session, and the shell behaviours around them (the More menu's Escape, focus leaving it,
// and on a phone its opening, which brings a cut button whole into view before placing the list, and its closing only
// once a scroll takes the button wholly out; a failed copy; a phone's navigation scrolled to the current pill once and
// to a focused pill with its ring, and never re-centred). The real `CONSOLE_SCRIPT` runs over a hand-made DOM stub and an
// `EventSource` stub, as console-panels.test.mjs and console-login-next.test.mjs run it; nothing here is a browser.

/** A stub element: attributes, `hidden`, listeners, and whatever `extra` adds. */
function element(attrs = {}, extra = {}) {
  const listeners = new Map();
  return {
    attrs: { ...attrs },
    hidden: "hidden" in attrs,
    textContent: "",
    getAttribute(n) { return Object.hasOwn(this.attrs, n) ? this.attrs[n] : null; },
    setAttribute(n, v) { this.attrs[n] = String(v); },
    removeAttribute(n) { delete this.attrs[n]; },
    hasAttribute(n) { return Object.hasOwn(this.attrs, n); },
    addEventListener: (type, fn) => listeners.set(type, fn),
    fire: (type, ev = {}) => listeners.get(type)?.(ev),
    listeners,
    ...extra,
  };
}

/**
 * A live page (`data-live="fleet"`) holding the live pill as the server draws it (`LIVE_STATES.start`), one panel with a
 * hidden Copy button in it, and a More menu; the script run over it with an `EventSource` stub, a clipboard that
 * succeeds or fails (`copyOk`), and a recorded navigation.
 */
function liveDom({ copyOk = true } = {}) {
  const word = element({ "data-live-word": "" });
  word.textContent = LIVE_STATES.start.word;
  const status = element({ id: "live-status", role: "status", title: LIVE_STATES.start.title }, { className: LIVE_STATES.start.cls, querySelector: (s) => (s === "[data-live-word]" ? word : null) });
  const code = element();
  code.textContent = "pi-dispatch sandbox gh-1";
  const box = element({}, { querySelector: (s) => (s === "code" ? code : null) });
  const copy = element({ "data-copy": "", hidden: "" }, { closest: (s) => (s === ".cmd" ? box : null) });
  copy.textContent = "Copy";
  // The panel holds its Copy button only once a swap has put it there.
  let swapped = false;
  const panel = element({ id: "p-x", "data-panel": "" }, {
    innerHTML: "",
    contains: () => false,
    querySelector: () => null,
    querySelectorAll: (s) => (s === "button[data-copy][hidden]" && swapped ? [copy].filter((b) => b.hidden) : []),
  });
  const summary = element({}, { focus() { summary.focused = true; } });
  const inMenu = element();
  const more = element({}, { open: false, contains: (n) => n === more || n === summary || n === inMenu, querySelector: (s) => (s === "summary" ? summary : null) });
  const docListeners = new Map();
  const document = {
    body: element({ "data-page": "fleet", "data-live": "fleet", "data-query": "repo=acme%2Fweb" }),
    getElementById: (id) => ({ "live-status": status, "p-x": panel })[id] ?? null,
    querySelector: (s) => ({ "details.more": more })[s] ?? null,
    querySelectorAll: () => [],
    addEventListener: (type, fn) => docListeners.set(type, fn),
    activeElement: null,
  };
  const streams = [];
  function EventSource(url) {
    this.url = url;
    this.readyState = 0;
    this.closed = false;
    this.listeners = new Map();
    this.addEventListener = (type, fn) => this.listeners.set(type, fn);
    this.close = () => { this.closed = true; this.readyState = 2; };
    this.emit = (type, ev = {}) => this.listeners.get(type)(ev);
    streams.push(this);
  }
  const assigned = [];
  const timers = [];
  const clipboard = { writeText: (t) => (copyOk ? Promise.resolve(t) : Promise.reject(new Error("denied"))) };
  const fn = new Function("document", "location", "history", "EventSource", "navigator", "isSecureContext", "setTimeout", CONSOLE_SCRIPT);
  fn(document, { hash: "", pathname: "/fleet", assign: (u) => assigned.push(u) }, { replaceState() {} }, EventSource, { clipboard }, true, (f) => timers.push(f));
  // Each element `swap` will have put in the panel is shown by `panel` events from here on.
  const swap = () => { swapped = true; };
  return { status, word, panel, copy, more, summary, inMenu, document, docListeners, streams, assigned, timers, swap };
}

/** The pill as a reader and assistive technology meet it: its classes, its word, its tooltip. */
const pill = (d) => ({ cls: d.status.className, word: d.word.textContent, title: d.status.getAttribute("title") });

test("the live pill's four states are the LiveStates card's: their classes, words and tooltips, pinned", () => {
  assert.deepEqual(LIVE_STATES, {
    start: { cls: "live live--off", word: "Not live", title: "Not live until this page's script connects to the console's stream." },
    on: { cls: "live", word: "Live", title: null },
    retry: { cls: "live live--retry", word: "Reconnecting", title: "The page stays as it is and tries again every 2 seconds." },
    off: { cls: "live live--off", word: "Not live", title: "Not live: reload after closing another console tab." },
    out: { cls: "live live--off live--out", word: "Signed out", title: null },
  });
});

test("the script drives the pill through the stream: open, a drop, a refusal, a panel and the end of the session", async () => {
  const d = liveDom();
  assert.equal(d.streams.length, 1);
  const es = d.streams[0];
  assert.equal(es.url, "/api/events?page=fleet&repo=acme%2Fweb", "the page's own stream, with its query");
  assert.deepEqual(pill(d), { cls: "live live--off", word: "Not live", title: LIVE_STATES.start.title }, "drawn not live until the stream opens");

  es.readyState = 1;
  es.emit("open");
  assert.deepEqual(pill(d), { cls: "live", word: "Live", title: null });

  // A dropped stream: the browser is reconnecting (readyState CONNECTING, 0), so the page says so and waits.
  es.readyState = 0;
  es.emit("error");
  assert.deepEqual(pill(d), { cls: "live live--retry", word: "Reconnecting", title: "The page stays as it is and tries again every 2 seconds." });

  // Back: Live again, and the reconnecting tooltip is gone, not left to contradict the word.
  es.readyState = 1;
  es.emit("open");
  assert.deepEqual(pill(d), { cls: "live", word: "Live", title: null });

  // A refused stream (429 over the limit, 401): the browser has CLOSED it (readyState 2) and will not retry.
  es.readyState = 2;
  es.emit("error");
  assert.deepEqual(pill(d), { cls: "live live--off", word: "Not live", title: "Not live: reload after closing another console tab." });

  // A panel arriving is the stream at work: Live, with the refusal's tooltip removed.
  es.readyState = 1;
  es.emit("panel", { data: JSON.stringify({ id: "p-x", html: "<p>new</p>" }) });
  assert.equal(d.panel.innerHTML, "<p>new</p>");
  assert.deepEqual(pill(d), { cls: "live", word: "Live", title: null });

  // A message for an element that is not a panel changes nothing, the pill included.
  es.readyState = 0;
  es.emit("error");
  es.emit("panel", { data: JSON.stringify({ id: "live-status", html: "<b>x</b>" }) });
  assert.deepEqual(pill(d), { cls: "live live--retry", word: "Reconnecting", title: LIVE_STATES.retry.title });

  // The session ended: the stream is closed, the pill says Signed out with the sign-out glyph (live--out), and the page
  // goes to sign-in.
  es.emit("end");
  assert.equal(es.closed, true);
  assert.deepEqual(pill(d), { cls: "live live--off live--out", word: "Signed out", title: null });
  assert.deepEqual(d.assigned, ["/login"]);
});

test("a panel the stream swaps in has its Copy buttons revealed (a clipboard in a secure context), and a failed copy never says Copied", async () => {
  const d = liveDom({ copyOk: false });
  d.swap();
  assert.equal(d.copy.hidden, true, "hidden until its panel arrives");
  d.streams[0].emit("panel", { data: JSON.stringify({ id: "p-x", html: "<div class=\"cmd\"></div>" }) });
  assert.equal(d.copy.hidden, false, "the swapped panel's Copy button is shown");
  d.copy.fire("click");
  await new Promise((r) => setImmediate(r));
  assert.equal(d.copy.textContent, "Not copied", "a refused clipboard says so");
  d.timers.forEach((f) => f());
  assert.equal(d.copy.textContent, "Copy");

  const ok = liveDom({ copyOk: true });
  ok.swap();
  ok.streams[0].emit("panel", { data: JSON.stringify({ id: "p-x", html: "<div class=\"cmd\"></div>" }) });
  ok.copy.fire("click");
  await new Promise((r) => setImmediate(r));
  assert.equal(ok.copy.textContent, "Copied");
});

test("Escape closes the More menu, and moves focus to its button only when focus was inside the menu", () => {
  const d = liveDom();
  const outside = { id: "elsewhere" };
  d.more.open = true;
  d.document.activeElement = outside;
  d.docListeners.get("keydown")({ key: "Escape" });
  assert.equal(d.more.open, false);
  assert.equal(d.summary.focused, undefined, "focus stays where the reader had it");
  d.more.open = true;
  d.document.activeElement = d.inMenu;
  d.docListeners.get("keydown")({ key: "Escape" });
  assert.equal(d.more.open, false);
  assert.equal(d.summary.focused, true, "from inside the menu, focus returns to its button");
});

test("focus leaving the More menu for something outside it closes the menu; focus moving inside it, or nowhere, does not", () => {
  const d = liveDom();
  d.more.open = true;
  d.more.fire("focusout", { relatedTarget: d.inMenu });
  assert.equal(d.more.open, true, "from its button to its link: still the menu");
  d.more.fire("focusout", { relatedTarget: null });
  assert.equal(d.more.open, true, "focus to nothing (a click on bare page) is the click handler's to judge");
  d.more.fire("focusout", { relatedTarget: { id: "theme-button" } });
  assert.equal(d.more.open, false, "Tab past its last link, or Shift+Tab before its button");
  d.more.fire("focusout", { relatedTarget: { id: "theme-button" } });
  assert.equal(d.more.open, false, "a shut menu stays shut");
});

/** What the focusin handler looks a pill up by, as the script writes it. */
const PILL = "nav.pillnav > a, details.more > summary";

/**
 * A phone's navigation: `navWidth` wide, its row `rowWidth` long, scrolled to `scrollLeft` before the script runs (a
 * restored position), clamped as a browser clamps it. `pills` are `[left, width, current]`, left from the row's start;
 * More's button is at `summaryAt` and its link is current when `moreCurrent`. The script runs over it with
 * `ResizeObserver` recorded; `focus(el)` sends the navigation a focusin from `el`.
 */
function navDom({ pills, navWidth = 300, rowWidth = 1000, scrollLeft = 0, moreCurrent = false, summaryAt = [520, 48] }) {
  let at = 0;
  const listeners = new Map();
  const nav = {
    get scrollLeft() { return at; },
    set scrollLeft(v) { at = Math.max(0, Math.min(rowWidth - navWidth, v)); },
    getBoundingClientRect: () => ({ left: 0, right: navWidth, width: navWidth }),
    addEventListener: (type, fn) => listeners.set(type, fn),
  };
  nav.scrollLeft = scrollLeft;
  const rect = (left, width) => () => ({ left: left - at, right: left + width - at, width });
  const pill = (left, width, extra = {}) => {
    const el = { getBoundingClientRect: rect(left, width), ...extra };
    el.closest = (s) => (s === PILL ? el : null);
    return el;
  };
  const summary = pill(...summaryAt);
  const more = { querySelector: (s) => (s === "summary" ? summary : null) };
  const els = pills.map(([left, width, current]) => pill(left, width, { current }));
  const menuLink = { closest: (s) => (s === "details.more" ? more : null), getBoundingClientRect: () => ({ left: 900, right: 1000, width: 100 }) };
  nav.querySelector = (s) => (s === 'a[aria-current="page"]' ? (moreCurrent ? menuLink : els.find((e) => e.current) ?? null) : null);
  const observed = [];
  function ResizeObserver(cb) {
    this.observe = (el) => observed.push([el, cb]);
  }
  const document = {
    body: { getAttribute: (n) => (n === "data-page" ? "fleet" : null) },
    getElementById: () => null,
    querySelector: (s) => (s === "nav.pillnav" ? nav : null),
    querySelectorAll: () => [],
    addEventListener() {},
  };
  new Function("document", "location", "history", "EventSource", "ResizeObserver", CONSOLE_SCRIPT)(document, { hash: "", pathname: "/fleet" }, { replaceState() {} }, undefined, ResizeObserver);
  const focus = (el) => listeners.get("focusin")({ target: el });
  return { nav, els, summary, menuLink, observed, listeners, focus };
}

test("on load a phone's navigation scrolls its current pill (or More, for a page inside it) into view, centred, from wherever it was restored", () => {
  // Fleet at 400..500 in a 300-wide navigation: scrolled so its centre is the navigation's centre.
  assert.equal(navDom({ pills: [[0, 120, false], [400, 100, true]] }).nav.scrollLeft, 300, "400 + 100/2 - 300/2");
  // From a restored scroll of 50 the move is relative to it: the same centred 300, not 250.
  assert.equal(navDom({ pills: [[0, 120, false], [400, 100, true]], scrollLeft: 50 }).nav.scrollLeft, 300);
  // A restored scroll that left the pill past the navigation's START is brought back too: 100 + 60 - 150.
  assert.equal(navDom({ pills: [[100, 120, true], [400, 100, false]], scrollLeft: 600 }).nav.scrollLeft, 10);
  // Already in full view: left as it is, so a restored or a reader's own scroll stands; a pill touching an edge is in view.
  assert.equal(navDom({ pills: [[40, 120, true]], scrollLeft: 30 }).nav.scrollLeft, 30);
  assert.equal(navDom({ pills: [[180, 120, true]] }).nav.scrollLeft, 0, "180..300 in a 300-wide navigation");
  // Audit lives in More: More's button is what comes into view.
  assert.equal(navDom({ pills: [[0, 120, false]], moreCurrent: true, summaryAt: [520, 48] }).nav.scrollLeft, 520 + 24 - 150);
  // No current pill (a page outside the navigation): nothing moves.
  assert.equal(navDom({ pills: [[400, 100, false]] }).nav.scrollLeft, 0);
});

test("a phone's navigation never re-centres after load: no resize watch, so a reader's own scroll survives a resize and a live word", () => {
  const d = navDom({ pills: [[0, 120, false], [400, 100, true]] });
  assert.equal(d.nav.scrollLeft, 300);
  assert.deepEqual(d.observed, [], "nothing watches the navigation's size (a live word moved it, and undid the reader's scroll)");
  assert.deepEqual([...d.listeners.keys()], ["focusin"], "and it listens for focus alone");
  d.nav.scrollLeft = 0;
  assert.equal(d.nav.scrollLeft, 0, "the reader's scroll stands");
});

test("a pill the keyboard focuses is scrolled fully into view WITH its 4px focus ring, by the least move, and only a pill", () => {
  // Past the end: 250..350 in a 300-wide navigation, ring to 354: scrolled by 54.
  const end = navDom({ pills: [[250, 100, false]] });
  end.focus(end.els[0]);
  assert.equal(end.nav.scrollLeft, 54);
  // Past the start after a reader's scroll of 100: 80..180 shows from -20, ring from -24: scrolled back by 24.
  const start = navDom({ pills: [[80, 100, false]], scrollLeft: 100 });
  start.focus(start.els[0]);
  assert.equal(start.nav.scrollLeft, 76);
  // The pill is in view but its ring is not (198..298, ring to 302): the 2px the ring needs.
  const ring = navDom({ pills: [[198, 100, false]] });
  ring.focus(ring.els[0]);
  assert.equal(ring.nav.scrollLeft, 2);
  // Ring and all in view: nothing moves.
  const fine = navDom({ pills: [[4, 100, false]], scrollLeft: 0 });
  fine.focus(fine.els[0]);
  assert.equal(fine.nav.scrollLeft, 0);
  // More's button is a pill; a link inside More's list is not in the row; focus from nothing changes nothing.
  const more = navDom({ pills: [[0, 120, false]], summaryAt: [520, 48] });
  more.focus(more.summary);
  assert.equal(more.nav.scrollLeft, 520 + 48 + 4 - 300);
  more.nav.scrollLeft = 0;
  more.focus(more.menuLink);
  more.focus(null);
  assert.equal(more.nav.scrollLeft, 0);
});

/**
 * A phone's top bar `bar` holding a navigation `navBox` that scrolls sideways inside itself (its row `rowWidth` long,
 * scrolled to `scrollLeft` before the script runs, clamped as a browser clamps it) and a More menu whose button shows
 * at `button` while the row is at that scroll, and whose list is `width` wide. The details' computed position is
 * `position` ("static" on a phone, where the script places the list, "relative" above it, where the CSS does);
 * `computed: false` runs the script with no `getComputedStyle` at all. `requestAnimationFrame` and `ResizeObserver` are
 * recorded. Nothing here moves focus (`element.click()` moves none), so no focusin ever runs.
 */
function moreDom({ bar = { left: 16, top: 20, width: 343, height: 44 }, navBox = { left: 0, width: 375, top: 76, height: 48 }, button = { left: 311, width: 40, top: 80, height: 40 }, width = 180, position = "static", rowWidth = 1000, scrollLeft = 0, computed = true } = {}) {
  const rect = (r) => ({ left: r.left, right: r.left + r.width, width: r.width, top: r.top, bottom: r.top + r.height });
  const top = { getBoundingClientRect: () => rect(bar) };
  let at = 0;
  const nav = element({}, { getBoundingClientRect: () => rect(navBox) });
  Object.defineProperty(nav, "scrollLeft", { get: () => at, set: (v) => { at = Math.max(0, Math.min(rowWidth - navBox.width, v)); } });
  nav.scrollLeft = scrollLeft;
  // The button's place in the row: where it shows plus how far the row is scrolled.
  let inRow = button.left + nav.scrollLeft;
  const summary = element({}, { getBoundingClientRect: () => rect({ ...button, left: inRow - at }) });
  const list = { style: {}, getBoundingClientRect: () => ({ width }) };
  const more = element({}, {
    open: false,
    contains: (n) => n === more || n === summary,
    querySelector: (s) => ({ summary, "summary + div": list })[s] ?? null,
    closest: (s) => ({ ".top": top, nav })[s] ?? null,
  });
  const frames = [];
  const observed = [];
  function ResizeObserver(cb) {
    this.observe = (el) => observed.push([el, cb]);
  }
  const style = { position };
  const document = {
    body: { getAttribute: (n) => (n === "data-page" ? "fleet" : null) },
    getElementById: () => null,
    querySelector: (s) => (s === "details.more" ? more : null),
    querySelectorAll: () => [],
    addEventListener() {},
  };
  const getComputedStyle = computed ? (el) => (el === more ? style : {}) : undefined;
  new Function("document", "location", "history", "EventSource", "ResizeObserver", "requestAnimationFrame", "getComputedStyle", CONSOLE_SCRIPT)(document, { hash: "", pathname: "/fleet" }, { replaceState() {} }, undefined, ResizeObserver, (f) => frames.push(f), getComputedStyle);
  /**
   * A click on the button as the browser runs it: the click's listeners, then the details toggles, then its toggle event
   * and the next frame, in either order (the event is queued as a task, the frame comes at the next paint); `steps`
   * names which run, in order.
   */
  const click = ({ steps = ["toggle", "frame"] } = {}) => {
    summary.fire("click");
    more.open = !more.open;
    const run = { toggle: () => more.fire("toggle"), frame: () => frames.splice(0).forEach((f) => f()) };
    for (const step of steps) run[step]();
  };
  /** The row scrolled (by a reader's swipe, say) so the button shows at `left`; the scroll event is the caller's. */
  const showButtonAt = (left) => {
    nav.scrollLeft = inRow - left;
    if (summary.getBoundingClientRect().left !== left) inRow = left + at;
  };
  return { more, summary, list, nav, top, click, observed, style, showButtonAt };
}

test("on a phone the script opens More's list under its own button: right edges aligned, 6px below it, inside the row", () => {
  const d = moreDom();
  assert.deepEqual(d.list.style, {}, "nothing is placed until the menu opens");
  d.click();
  // Against the bar (the list's containing block), which starts 16px in: 351 - 16 - 180, and 120 - 20 + 6.
  assert.deepEqual(d.list.style, { left: `${351 - 16 - 180}px`, right: "auto", top: `${80 + 40 - 20 + 6}px` });
  assert.equal(d.nav.scrollLeft, 0, "a button already whole, its ring too, moves nothing");
  // A button near the row's start: the list starts at the row's edge (the screen's, 16px before the bar's), not past it.
  const start = moreDom({ button: { left: 4, width: 40, top: 80, height: 40 } });
  start.click();
  assert.equal(start.list.style.left, "-16px");
  assert.equal(start.nav.scrollLeft, 0, "4px from the edge: the ring shows");
  // Placed again when the navigation scrolls, when the bar is resized, and on the details' own toggle; never while shut.
  const again = moreDom({ scrollLeft: 100 });
  again.click();
  again.showButtonAt(300);
  again.nav.fire("scroll");
  assert.equal(again.list.style.left, `${340 - 16 - 180}px`);
  assert.deepEqual(again.observed.map(([el]) => el), [again.top]);
  again.showButtonAt(250);
  again.observed[0][1]();
  assert.equal(again.list.style.left, `${290 - 16 - 180}px`);
  again.showButtonAt(200);
  again.more.fire("toggle");
  assert.equal(again.list.style.left, `${240 - 16 - 180}px`);
  again.more.open = false;
  again.showButtonAt(100);
  again.nav.fire("scroll");
  again.more.fire("toggle");
  assert.equal(again.list.style.left, `${240 - 16 - 180}px`, "a shut menu is left alone");
});

test("More opens on a click that moves no focus with its button cut by the row: the row brings the button in whole, ring and all, then the list is placed, and the menu stays open", () => {
  // The third review's case at every phone width: element.click() on a button the row cuts, 355..395 in a 375-wide row.
  const end = moreDom({ button: { left: 355, width: 40, top: 80, height: 40 } });
  end.click();
  assert.equal(end.more.open, true, "open");
  assert.equal(end.nav.scrollLeft, 395 + 4 - 375, "scrolled by the least move that shows the button and its 4px ring");
  assert.equal(end.summary.getBoundingClientRect().right, 371);
  const placed = { left: `${371 - 16 - 180}px`, right: "auto", top: `${80 + 40 - 20 + 6}px` };
  assert.deepEqual(end.list.style, placed, "placed under the button where it now shows");
  end.nav.fire("scroll");
  assert.equal(end.more.open, true, "that scroll of the script's own does not close it");
  assert.deepEqual(end.list.style, placed);
  // Cut at the row's start, the row scrolled by a reader: -20..20 comes back to 4..44.
  const start = moreDom({ button: { left: -20, width: 40, top: 80, height: 40 }, scrollLeft: 100 });
  start.click();
  assert.equal(start.more.open, true);
  assert.equal(start.nav.scrollLeft, 100 - 24);
  assert.equal(start.list.style.left, "-16px");
  // Wholly out of the row when opened (a script's click on a button scrolled away): brought in all the same.
  const away = moreDom({ button: { left: 600, width: 40, top: 80, height: 40 } });
  away.click();
  assert.equal(away.more.open, true);
  assert.equal(away.nav.scrollLeft, 640 + 4 - 375);
  // The frame before the toggle event (so the first paint already shows it so), or the toggle event alone (the details
  // opened by anything else): the same.
  const frameFirst = moreDom({ button: { left: 355, width: 40, top: 80, height: 40 } });
  frameFirst.click({ steps: ["frame"] });
  assert.deepEqual([frameFirst.more.open, frameFirst.nav.scrollLeft, frameFirst.list.style], [true, 24, placed], "by the frame");
  frameFirst.more.fire("toggle");
  assert.deepEqual([frameFirst.more.open, frameFirst.nav.scrollLeft, frameFirst.list.style], [true, 24, placed], "and the toggle after it");
  const toggled = moreDom({ button: { left: 355, width: 40, top: 80, height: 40 } });
  toggled.more.open = true;
  toggled.more.fire("toggle");
  assert.deepEqual([toggled.more.open, toggled.nav.scrollLeft, toggled.list.style], [true, 24, placed]);
  // Closing it scrolls nothing.
  end.showButtonAt(340);
  end.click();
  assert.equal(end.more.open, false);
  assert.equal(end.summary.getBoundingClientRect().left, 340, "shut by its button: the row stays where it is");
});

test("on a phone More closes only when a later scroll of the row (or a resize) takes its button WHOLLY out of view: one pixel showing keeps it open", () => {
  // The 40px button in a 0..375 row, after opening, scrolled by the reader to show at `left`.
  const scrolledTo = (left) => {
    const d = moreDom();
    d.click();
    d.showButtonAt(left);
    d.nav.fire("scroll");
    return d;
  };
  for (const [left, open, why] of [
    [-39, true, "1px of it shows at the row's start"],
    [-40, false, "its right edge on the row's start: wholly out"],
    [-200, false, "far past the start"],
    [374, true, "1px of it shows at the row's end"],
    [375, false, "its left edge on the row's end: wholly out"],
    [600, false, "far past the end"],
  ]) {
    assert.equal(scrolledTo(left).more.open, open, `${left}: ${why}`);
  }
  // Cut but showing: open, and the list kept inside the row, right-aligned with what shows of the button.
  assert.equal(scrolledTo(355).list.style.left, `${375 - 16 - 180}px`, "cut at the row's end: the list ends at the row's end");
  assert.equal(scrolledTo(-20).list.style.left, "-16px", "cut at its start: the list starts at the row's start");
  // A closed menu is not moved.
  const shut = moreDom();
  shut.click();
  const before = { ...shut.list.style };
  shut.showButtonAt(-100);
  shut.nav.fire("scroll");
  assert.equal(shut.more.open, false);
  assert.deepEqual(shut.list.style, before, "closed, not moved");
  // A resize (a phone turned, a window narrowed) is judged the same: a sliver showing keeps it open, none closes it.
  const resized = moreDom();
  resized.click();
  resized.showButtonAt(-39);
  resized.observed[0][1]();
  assert.equal(resized.more.open, true, "1px showing after a resize");
  assert.equal(resized.list.style.left, "-16px");
  resized.showButtonAt(-40);
  resized.observed[0][1]();
  assert.equal(resized.more.open, false, "none showing after a resize");
});

test("above a phone the CSS places More's list and the script does not: it only clears what it set on a phone", () => {
  const d = moreDom({ position: "relative" });
  d.click();
  assert.deepEqual(d.list.style, { left: "", right: "", top: "" }, "no placement: the details is the list's containing block");
  assert.equal(d.more.open, true);
  // Opened on a phone, then the window widened: the next resize hands the list back to the CSS.
  const turned = moreDom();
  turned.click();
  assert.notEqual(turned.list.style.left, "");
  turned.style.position = "relative";
  turned.observed[0][1]();
  assert.deepEqual(turned.list.style, { left: "", right: "", top: "" });
  // A button that sits past the navigation's box above a phone (it never scrolls there) neither scrolls it nor closes.
  const wide = moreDom({ position: "relative", button: { left: 900, width: 48, top: 20, height: 48 } });
  wide.click();
  wide.nav.fire("scroll");
  assert.equal(wide.more.open, true);
  assert.equal(wide.nav.scrollLeft, 0);
  // A browser that cannot say where the CSS put the list (no getComputedStyle) leaves it to the CSS: nothing is placed,
  // scrolled or closed, however its button sits (review mutant S20).
  const bare = moreDom({ computed: false, button: { left: 355, width: 40, top: 80, height: 40 } });
  bare.click();
  assert.deepEqual([bare.more.open, bare.nav.scrollLeft, bare.list.style], [true, 0, { left: "", right: "", top: "" }]);
  bare.showButtonAt(-200);
  bare.nav.fire("scroll");
  assert.equal(bare.more.open, true);
});
