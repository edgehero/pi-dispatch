/** Fleet edits credential-free mappings; enrollment into the opener remains a local operator act. */
import { html } from "./html.mjs";
import * as ui from "./kit.mjs";
export function sandboxHostEditor(view, host) {
  if (view.role !== "operator") return null;
  const mapping = view.data?.sandboxHosts?.hosts?.[host] ?? {};
  const inputs = [
    ["target", "SSH target", "user@host or an SSH config alias; blank for this computer"],
    ["deployment", "Deployment directory", "/absolute/deployment"],
    ["nodePath", "Node executable", "/absolute/path/to/node"],
    ["cliPath", "pi-dispatch CLI", "/absolute/path/to/pi-dispatch/worker/src/cli.mjs"],
  ];
  const fields = inputs.map(([name, label, placeholder]) => ui.field({ label, id: `sb-target-${name.toLowerCase()}`, control: ui.input({ id: `sb-target-${name.toLowerCase()}`, name, value: mapping[name] ?? "", placeholder, code: true, required: name !== "target", disabled: view.readOnly, autocomplete: "off", spellcheck: false }) }));
  return html`<aside data-sandbox-target><h3>Open in your terminal</h3>${view.data?.sandboxHostsProblem ? html`<p role="status">${view.data.sandboxHostsProblem}</p>` : null}<p>The SSH target uses the worker's account, including rootless Podman. Absolute executable paths and the deployment directory load that deployment's sandbox settings after SSH connects. An SSH alias can set its port and identity.</p>${view.readOnly ? html`<p>This console is read-only. Terminal targets cannot be changed here.</p>` : html`<form class="act" data-action="sandbox-host-set" autocomplete="off"><input type="hidden" name="host" value="${host}"><div class="cards-2">${fields}${ui.field({ label: "Remote shell", id: "sb-target-shell", control: ui.select({ id: "sb-target-shell", name: "shell", value: mapping.shell ?? "posix", options: [{ value: "posix", label: "POSIX shell" }, { value: "powershell", label: "PowerShell" }] }) })}</div>${ui.btn({ type: "submit", label: "Preview terminal target", kind: ["sm"] })}</form>`}<p><a class="link" href="/api/sandbox-hosts" download="sandbox-hosts.json">Download opener hosts</a>. Inspect this credential-free file, then import it on your computer:</p>${ui.cmd(["pi-dispatch", "opener", "install", "--config", "sandbox-hosts.json"])}<p>A link cannot change the opener's trusted hosts.</p></aside>`;
}
