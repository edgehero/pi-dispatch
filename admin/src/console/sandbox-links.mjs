/** Credential-free terminal handoff, shared by the run, host and Sandboxes screens (#771). */
import { buildSandboxOpenUrl } from "@edgehero/pi-dispatch/opener-protocol";
import { sandboxCommand } from "@edgehero/pi-dispatch/sandbox-hosts";
import { html } from "./html.mjs";
import * as ui from "./kit.mjs";

/** Only already-registered shells on hand-enrolled hosts get a browser route; unopened workspaces never do. */
export function sandboxBrowserLink(view, shell, { kind = null } = {}) {
  if (view.role !== "operator" || view.readOnly || !view.data?.browserGateways?.enabledHosts?.includes(shell?.host)) return null;
  if (!view.data.browserGateways.sessions?.some((s) => s.host === shell.host && s.id === shell.id && s.containerId === shell.containerId && s.nonce === shell.nonce)) return null;
  if (view.query?.gatewaySelect && view.query.host !== shell.host) return null;
  const driver = view.data.browserGateways.drivers?.find((s) => s.host === shell.host && s.id === shell.id && s.containerId === shell.containerId && s.nonce === shell.nonce);
  const mode = kind ?? (driver?.watching && driver.by !== view.name ? "watch" : "drive");
  if (!["drive", "watch"].includes(mode) || mode === "watch" && !driver?.watching || mode === "drive" && driver && driver.by !== view.name) return null;
  const href = `/sandbox/gateway/launch?${new URLSearchParams({ host: shell.host, id: shell.id, ...(mode === "watch" ? { kind: "watch" } : {}) })}`;
  const link = html`<a class="btn btn--sm sandbox-browser sandbox-opener${mode === "watch" ? " sandbox-watch" : ""}" data-sandbox-kind="${mode}" href="${href}" target="${view.query?.gatewaySelect ? "_self" : "_blank"}" rel="noopener noreferrer">${ui.icon(mode === "watch" ? "eye" : "terminal", { size: "sm" })}${mode === "watch" ? "Watch" : "Open in browser"}</a>`;
  // A token name can own several sign-ins. It cannot tell this cached view whether the driver is this session.
  // Offer both checked paths in that ambiguous case; the broker alone decides self-watch by original session.
  return kind === null && driver?.watching && driver.by === view.name ? html`${link}${sandboxBrowserLink(view, shell, { kind: "watch" })}` : link;
}

/** The Workspace row keeps the command under its one disclosure, without an extra opener or install guide. */
export function sandboxCopy({ id, host, verb = "open", config = null } = {}) {
  let command = null;
  if (config) { try { command = sandboxCommand(config, { verb, id, host }); } catch { /* The host-local command remains selectable. */ } }
  const local = ["pi-dispatch", "sandbox", id, ...(verb === "attach" ? ["--attach"] : [])];
  return html`<aside data-sandbox-command>${command?.remoteScript ? html`<pre class="code">${command.remoteScript}</pre>` : null}${ui.cmd(command?.argv ?? local, { host: command?.argv ? `For ${host}, using its saved deployment settings.` : `Run on ${host} as the worker account, with its sandbox settings loaded.` })}</aside>`;
}

export function sandboxNativeLink({ id, host, verb = "open" } = {}) {
  try { return html`<span class="sandbox-opener">${ui.outLink({ href: buildSandboxOpenUrl({ verb, id, host }), label: "Open in Terminal", btn: "sm" })}</span>`; }
  catch { return null; }
}

/** Native registration.by names the opener; only the separately authenticated room identifies a browser driver. */
export function sandboxDriverLine(view, shell) {
  const facts = view.data?.browserGateways;
  const driver = facts?.drivers?.find((s) => s.host === shell?.host && s.id === shell?.id && s.containerId === shell?.containerId && s.nonce === shell?.nonce);
  if (!driver) return facts?.partial ? html`<p class="sx-open__s" role="status">Browser driver and watcher status could not be read.</p>` : null;
  return html`<p class="sx-open__s">${driver.by} is driving in the browser${driver.watching ? ", and lets operators watch." : ". Watching is off."}${driver.watchers?.length ? html` Watching now: ${driver.watchers.map((w) => w.name).join(", ")}.` : null}${facts?.partial ? " Other browser status could not be read." : ""}</p>`;
}

export function sandboxLinks({ id, host, verb = "open", config = null, compact = false } = {}) {
  let href;
  try { href = buildSandboxOpenUrl({ verb, id, host }); } catch { return html`<p class="card__sub">The sandbox id or host is not usable. Inspect this workspace on its host.</p>`; }
  let command = null;
  if (config) {
    try { command = sandboxCommand(config, { verb, id, host }); } catch { /* The mapping needs repair; the host-local command still works. */ }
  }
  const local = ["pi-dispatch", "sandbox", id, ...(verb === "attach" ? ["--attach"] : [])];
  const opener = html`<span class="sandbox-opener">${ui.outLink({ href, label: "Open in Terminal", btn: compact ? ["sm"] : "primary" })}</span>`;
  const remoteDetails = command?.remoteScript && config?.hosts?.[host]?.shell === "powershell" ? html`<details><summary>Remote command</summary><pre class="code">${command.remoteScript}</pre></details>` : null;
  return html`<aside data-sandbox-command>${opener}${remoteDetails}${compact ? html`<details><summary>Copy the command</summary>${ui.cmd(command?.argv ?? local, { host: command?.argv ? `For ${host}, using its saved deployment settings.` : `Run on ${host} as the worker account, with its sandbox settings loaded. Set its terminal target in Fleet for the remote command.` })}</details>` : html`${ui.cmd(command?.argv ?? local, { host: command?.argv ? `For ${host}, using its saved deployment settings.` : `Run on ${host} as the worker account, with its sandbox settings loaded. Set its terminal target in Fleet for the remote command.` })}<p class="card__sub">The opener checks its own saved hosts. It types the command and waits for Enter. Install once on this computer:</p>${ui.cmd(["pi-dispatch", "opener", "install", "--config", "sandbox-hosts.json"])}`}</aside>`;
}
