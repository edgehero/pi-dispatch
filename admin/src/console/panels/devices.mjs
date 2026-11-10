/**
 * The DevicesScreen card (issue #849, `REQ-OPERATOR-CONSOLE-SCREENS`): this browser, every remembered browser, and signing everyone out. Drawn on demand,
 * never live: what it lists changes only when someone remembers, signs out or removes a browser, and a live panel would carry one person's list to
 * another's tab. A viewer sees their own browsers and changes nothing here (signing out forgets a browser); every button is an operator's, behind a preview.
 */
import { html } from "../html.mjs";
import * as ui from "../kit.mjs";

const data = (view) => view.data?.devices ?? null;
const operator = (view) => view.role === "operator" && !view.readOnly;
const day = (iso) => (typeof iso === "string" ? iso.slice(0, 10) : "unknown");

/** The page's own sentences, held by its tests and the card. */
export const DEVICES_WORDS = Object.freeze({
  description: "Which browsers stay signed in without a token or a link. A remembered browser ends when it signs out, when it is removed here, or when its token changes.",
  thisRemembered: "This browser is remembered. It stays signed in across idle time and restarts until you sign out here or it is removed below.",
  thisNot: "This browser is not remembered: it signs out after a while without use, and when the console restarts. To remember it, sign out and sign in again with Remember this trusted device ticked.",
  thisNotHere: "This browser is not remembered, and cannot be from here: the console remembers a browser only on loopback, through an SSH tunnel or at its HTTPS address, never over plain HTTP across a network.",
  thisNotWindows: "This browser is not remembered: remembering a browser does not work when the console runs on a Windows host.",
  thisNotStore: "This browser is not remembered, and cannot be now: the console cannot use its store of remembered browsers. An operator should run pi-dispatch doctor on the host.",
  thisInvited: "This browser is not remembered: a sign-in from an invitation cannot be. Ask an operator for a token of your own.",
  none: "No browser is remembered.",
  ends: "A remembered browser also ends when its token is revoked or rotated, its role changes, or everyone is signed out.",
  allBody: "Ends every session now, forgets every remembered browser and stops every sign-in link not opened yet, including viewer invitations. Every token still works. You are signed out too: sign in again with your token, or run `./pi-dispatch console` on the host.",
});

const unreadable = (problem) => ui.banner({ status: "attention", sm: true, title: "The remembered browsers cannot be read", body: html`${problem}. An operator should run <span class="code">pi-dispatch doctor</span> on the host.` });

/** `p-dev-this`: whether this browser is remembered, and how to change that. */
export function devicesThis(view) {
  const remembered = typeof view.remembered === "string";
  const body = remembered
    ? html`<p>${DEVICES_WORDS.thisRemembered}</p><p class="note">Its id is <span class="code">${view.remembered}</span>.</p>`
    : html`<p>${view.invited ? DEVICES_WORDS.thisInvited : view.rememberable === "transport" ? DEVICES_WORDS.thisNotHere : view.rememberable === "windows" ? DEVICES_WORDS.thisNotWindows : view.rememberable === "store" ? DEVICES_WORDS.thisNotStore : DEVICES_WORDS.thisNot}</p>`;
  return ui.card({ title: "This browser", end: remembered ? ui.chip("Remembered", { status: "ok", icon: "shield" }) : ui.chip("Not remembered", { icon: "clock" }), body });
}

/** `p-dev-list`: every live remembered browser (a viewer's own alone), with Remove for an operator. */
export function devicesList(view) {
  const v = data(view);
  if (!v) return ui.card({ title: "Remembered browsers", body: unreadable("This console holds no remembered-device store") });
  if (v.problem) return ui.card({ title: "Remembered browsers", body: unreadable(v.problem) });
  const mine = view.role === "operator" ? v.devices : v.devices.filter((d) => d.name === view.name);
  const live = mine.filter((d) => d.ended === undefined);
  const rows = live.map((d) => ({
    cells: [
      html`<span class="dev-what"><b>${d.label}</b>${d.id === view.remembered ? ui.chip("This browser", { status: "ok" }) : null}<small class="code">${d.id}</small></span>`,
      html`<span class="dev-who"><b>${d.name}</b><small>${d.role}</small></span>`,
      day(d.createdAt),
      day(d.lastUsedAt),
      { html: operator(view) ? html`<div class="dev-act">${ui.actForm({ action: "device-remove", hidden: [["id", d.id]], label: "Remove", kind: ["sm", "danger"], icon: "cancel" })}</div>` : null, wide: true },
    ],
  }));
  const table = ui.tbl({ label: "Remembered browsers", heads: ["Browser", "Person", "Remembered", "Last used", { label: "" }], rows, stack: true, empty: html`<p class="note dev-note">${DEVICES_WORDS.none}</p>` });
  const unread = v.unreadable > 0 ? html`<p class="note dev-note">${`${v.unreadable} record${v.unreadable === 1 ? "" : "s"} could not be read`}: an operator should run <span class="code">pi-dispatch doctor</span>.</p>` : null;
  return ui.card({ title: "Remembered browsers", sub: view.role === "operator" ? "every person's" : "yours", flush: true, body: html`${table}${unread}<p class="dev-foot">${ui.icon("info", { size: "sm" })}<span>${DEVICES_WORDS.ends}</span></p>` });
}

/** `p-dev-all`: sign everyone out, an operator's, behind a preview. Nothing for anyone else. */
export function devicesEndAll(view) {
  if (!operator(view)) return html``;
  return ui.card({ title: "Sign everyone out", body: html`<p>${ui.withCode(DEVICES_WORDS.allBody)}</p>${ui.actForm({ action: "sessions-end-all", label: "Sign everyone out", kind: ["sm", "danger"], icon: "logout" })}` });
}
