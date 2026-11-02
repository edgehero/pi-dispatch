/** Credential-free terminal handoff, shared by the run, host and Sandboxes screens (#771). */
import { buildSandboxOpenUrl } from "@edgehero/pi-dispatch/opener-protocol";
import { sandboxCommand } from "@edgehero/pi-dispatch/sandbox-hosts";
import { html } from "./html.mjs";
import * as ui from "./kit.mjs";

/** Only already-registered shells on hand-enrolled hosts get a browser route; unopened workspaces never do. */
export function sandboxBrowserLink(view, shell) {
  if (view.role !== "operator" || view.readOnly || !view.data?.browserGateways?.enabledHosts?.includes(shell?.host)) return null;
  if (!view.data.browserGateways.sessions?.some((s) => s.host === shell.host && s.id === shell.id && s.containerId === shell.containerId && s.nonce === shell.nonce)) return null;
  const href = `/sandbox/gateway/launch?${new URLSearchParams({ host: shell.host, id: shell.id })}`;
  return html`<a class="btn btn--sm sandbox-browser sandbox-opener" href="${href}" target="_blank" rel="noopener noreferrer">${ui.icon("terminal", { size: "sm" })}Open in browser</a>`;
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
