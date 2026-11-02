# Browser attachment to an existing sandbox

The optional sandbox gateway adds **Open in browser** beside registered open shells in Sandboxes and on the run
page. It attaches to a shell that already exists. Open a kept or prepared workspace with **Open in Terminal** first.
The gateway cannot start a container, choose an image, run another shell or end a sandbox. The native opener and
copyable commands remain supported, including on phones.

The gateway is a separate process on the sandbox host. Its own hostname and tab keep terminal code and runtime
access outside the console. Another port on the console hostname is refused because browser cookies are not
isolated by port. Remote origins require HTTPS; the named local development exception uses distinct loopback hosts.

## Enable it by hand

Enrollment is off when `sandbox-gateways.json` is absent. On the console host, write this file in the deployment
directory, owned by the console account and writable only by that account (mode 0600):

```json
{
  "version": 1,
  "consoleOrigin": "http://localhost:4790",
  "hosts": {
    "mini1": { "origin": "https://sandbox.example.com" }
  }
}
```

`PI_SANDBOX_GATEWAYS_FILE` selects another protected enrollment file. These settings are not the downloadable native
opener host mapping. Browser controls and model tools cannot edit them. The console origin is the exact address
the person's browser uses, including a tunnel's port. If an existing TLS reverse proxy fronts the console, enroll
its exact HTTPS origin and allow its hostname through `PI_CONSOLE_ALLOWED_HOSTS`. Writes then require that exact
Origin and Host, and sign-in sets a Secure console session cookie; proxy forwarding headers confer no trust.
Without enrollment, the existing loopback HTTP rule and plain-cookie browser compatibility apply.

On `mini1`, install `@edgehero/pi-dispatch-sandbox-gateway`. Write a protected absolute configuration file:

```json
{
  "version": 1,
  "origin": "https://sandbox.example.com",
  "consoleOrigin": "http://localhost:4790",
  "host": "mini1",
  "deployment": "/opt/pi-dispatch",
  "sockets": { "local": "/var/run/docker.sock" },
  "listen": { "host": "127.0.0.1", "port": 8788 }
}
```

Use the actual socket owned by the runtime account. Rootless Podman uses an explicitly configured `podman` socket,
usually `/run/user/<uid>/podman/podman.sock`, with its user socket service running. Docker Desktop uses its own
account's socket. No ambient Docker context, remote daemon URL or automatic fallback is used. Unsupported socket
transports refuse. The host must match `PI_WORKER_NAME` in the trusted deployment `.env`.

Run:

```sh
pi-dispatch-sandbox-gateway --config /opt/pi-dispatch/sandbox-gateway.json
```

The program reads only the deployment's host identity, sandbox idle limit, log directory and Valkey connection keys.
It does not load provider/forge credentials or the console token file. The optional `deploy/sandbox-gateway.service`
is a manual starting point for systemd. Use the existing runtime account; the gateway needs no new root service.
For remote access, put TLS in front of its loopback listener and preserve the exact configured Host and WebSocket
upgrade. Its own origin checks remain mandatory. For local development, `http://localhost:4790` for the console and
`http://127.0.0.1:8788` for the gateway provide distinct hostnames.

The gateway and console use the same trusted Valkey control deployment. Restrict that deployment to its existing
operator network/account boundary. The gateway uses the `sandbox-gateway:` namespace plus its host's existing
private sandbox registrations; terminal bytes never enter Valkey.

## Opening and closing

On a writable console, an operator selects **Open in browser** beside an existing shell. A new tab checks the original
sign-in, binds the gateway browser, and asks for that same operator's current token again on the console origin.
The page names the sandbox and host before token entry. Verification creates a single-use server-side attachment
grant lasting at most 60 seconds. Viewers, agents, read-only consoles and ordinary confirmation tickets cannot open it.

The handoff has an original-tab proof, a separate one-use bootstrap verifier, and a gateway HttpOnly cookie. Public
request IDs grant nothing. The bootstrap verifier briefly appears in a URL fragment and is immediately removed;
it cannot open a shell alone. It can still be observed by a browser extension before removal. Attachment grants,
operator tokens and console session IDs never travel to the gateway in a URL.

Only one browser connection can attach to a sandbox at once. There is no automatic reconnection or replay after a
disconnect; authorize a new opening. **Disconnect** detaches and preserves the shell and kept workspace.
The existing separately confirmed **End** action stops the shell through its native monitor. Typing `exit` or Ctrl-D
can also end the shell, just as in a native terminal. The gateway itself exposes no stop operation.

Only new output is shown; the original terminal may already hold the prompt. The gateway does not replay terminal
history or inject Enter to redraw it, since that could execute a command already being typed in the native terminal.

`PI_SANDBOX_IDLE_MINUTES` comes from the sandbox host. It limits time without browser input; zero disables that extra
limit. Output, resize and background heartbeats do not count as input or keep the console session alive. Console
logout, token rotation/revocation, role/generation changes, enrollment changes and unreadable authorization detach
within the five-second authorization lease. This browser limit is stronger than the native shell's prompt-only
`TMOUT`, whose behavior is unchanged.

Browser terminals require a window wider than 760 pixels and JavaScript. Narrowing an active window disconnects it.
This is a supported-layout rule, not a secure physical-device detector. Copy the native command on a phone.
The terminal supports screen-reader output and a visible **Tab moves focus** option; Ctrl+Shift+M switches that
option while leaving ordinary Escape, Tab and Ctrl-C available to shell programs.

## Boundaries and diagnostics

The renderer is exact-pinned xterm.js, served locally. The gateway alone permits the inline styles its released
renderer creates; its scripts remain self-hosted, and the console CSP is unchanged. Terminal output cannot set
clipboard contents, open output hyperlinks, change the page title or transfer files. Input and output are not
recorded. Audits contain safe opening/ending identities and closed reasons, with crash recovery for incomplete endings.

An absent or stale registration, replaced container, expired grant, competing browser, unavailable runtime or lost
authorization refuses explicitly. Check the named host and restart from Sandboxes; an expired registration does not
prove the container stopped. Console enrollment changes invalidate launches. A restarted console cannot renew its
old in-memory authorizations.

The gateway still has the runtime socket's authority if compromised. Docker's socket carries host-root reach;
rootless Podman's carries its account's reach. Separate origins and a narrow attach API do not remove that accepted
residual. Keep the service optional and its host/runtime access within the operator's existing trust boundary.
