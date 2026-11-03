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

Use one gateway serving process per host by default. If a proxy balances multiple processes under the same enrolled
origin, route each connection-admission request and its following WebSocket upgrade to the same process. An upgrade
on another process refuses safely. Consent, watcher roster and driver-size metadata are shared through Valkey and
propagate across processes. Each process admits at most 32 pending or active connections; the shared control store
holds at most 256 intents, and one original console sign-in holds at most four.

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
HTTPS uses the browser-enforced `__Host-pdg_browser` cookie with Secure, HttpOnly, Path=/ and no Domain.
The gateway never adopts an unprefixed cookie on HTTPS, so a sibling domain cannot preseed its binding nonce.
Explicit HTTP-loopback development uses a separate compatibility cookie; it is not a public-access mode.

The gateway opens a terminal workspace for one enrolled host. **Add existing terminal** returns through the console
to select another already-open shell and verify its opening. Up to four terminal tabs can be held by the original
console sign-in, with at most two openings in progress. Tabs can move between split groups without reconnecting.
The layout controls also work from the keyboard. Small windows combine groups into tabs to keep terminals readable;
widening does not restore old splits automatically. A different sign-in requires closing the old workspace first.

Only one writing browser connection can attach to a sandbox at once. A successful repeated opening focuses its
existing local terminal when the exact ownership matches; it never creates another shell or changes a watch into
a driver. There is no automatic reconnection or replay after a disconnect; authorize a new opening.
**Disconnect** detaches and preserves the shell and kept workspace. Closing one tab detaches only that tab.
The existing separately confirmed **End** action stops the shell through its native monitor. Typing `exit` or Ctrl-D
can also end the shell, just as in a native terminal. The gateway itself exposes no stop operation.

Only new output is shown; the original terminal may already hold the prompt. The gateway does not replay terminal
history or inject Enter to redraw it, since that could execute a command already being typed in the native terminal.

The run's Workspace row also offers native opening, command copy and confirmed End. Its next step reflects the
run's outcome. **Prepare from this run** opens the existing preparation form; it does not start a shell. Without a
recorded created pull request, its ref starts at HEAD. Review and explicitly choose a current compatible trigger
and host when the original trigger cannot be established. Findings go through the existing instruction editor or
fork-with-message workflow. Shell edits do not become an answer or future trigger instructions automatically.

The active terminal shows six available run facts and a **Back to `<run id>`** link after authorization. Prepared shells
and missing records have generic context. Switching tabs switches that context without changing the attachment.

`PI_SANDBOX_IDLE_MINUTES` comes from the sandbox host. It limits time without driver input; zero disables that extra
limit. Output, resize and background heartbeats do not count as input or keep the console session alive. Console
logout, token rotation/revocation, role/generation changes, enrollment changes and unreadable authorization detach
within the five-second authorization lease. This browser limit is stronger than the native shell's prompt-only
`TMOUT`, whose behavior is unchanged.

Browser terminals require a window wider than 760 pixels and JavaScript. Narrowing an active window disconnects it.
This is a supported-layout rule, not a secure physical-device detector. Copy the native command on a phone.
The terminal supports screen-reader output and a visible **Tab moves focus** option; Ctrl+Shift+M switches that
option while leaving ordinary Escape, Tab and Ctrl-C available to shell programs.

## Let another operator watch

The driver can turn on **Let operators watch**, off by default for each terminal. Other operators then see **Watch**
on the run page and in Sandboxes. Each watcher verifies their own current operator token and gets a separate
one-use grant. A native-only shell cannot be watched this way. Viewers, agents, read-only consoles and phones cannot
watch. The native shell opener and current browser driver can be different people; the page names them separately.

At most three watches are reserved, connecting or active for one driver. The persistent roster names each watcher,
including when the driver switches to another terminal tab. A new watcher receives output only after the driver's
page has rendered that roster. Watchers see new terminal output, which can include echoed tokens or other sensitive
text. Nothing is recorded or replayed.

The watch is read only at the runtime boundary: its attachment has no input stream and cannot resize the PTY.
It follows the driver's terminal dimensions, with internal scrolling on a smaller screen. **Stop watching** ends
only that watch. Watches use their own console-session lifetime and the driver's lifetime, without an input-idle
timer they cannot satisfy. Watching and output do not keep either console session alive.

**Remove** ends that exact watch; the operator may make a fresh request while watching remains enabled. Turning
watching off ends every watch. Driver disconnect, either person's lost authority and shell exit also end watches
within the five-second authorization bound. Watchers are never promoted to driver. Failed controls show an
unconfirmed result and fail closed; they do not claim that sharing stopped. A slow watcher is disconnected alone.

## Boundaries and diagnostics

A launch opened from outside the console, such as a bookmark or a link on another site, shows **Continue** first, so a stray
link spends none of your launch slots. A launch link sent to someone else cannot be armed from your tab: stepping up needs a
receipt only the browser that followed the link holds. A browser that stops answering the gateway's pings is detached.

The renderer is exact-pinned xterm.js and the layout is exact-pinned Dockview, both served locally. The gateway alone
permits the inline styles those two released libraries create; its scripts remain self-hosted, and the console CSP is
unchanged. Terminal output cannot set
clipboard contents, open output hyperlinks, change the page title or transfer files. Input and output are not
recorded. Audits contain safe opening/ending identities and closed reasons, with crash recovery for incomplete endings.

An absent or stale registration, replaced container, expired grant, competing browser, unavailable runtime or lost
authorization refuses explicitly. Check the named host and restart from Sandboxes; an expired registration does not
prove the container stopped. Console enrollment changes invalidate launches. A restarted console cannot renew its
old in-memory authorizations.

The gateway still has the runtime socket's authority if compromised. Docker's socket carries host-root reach;
rootless Podman's carries its account's reach. Separate origins and a narrow attach API do not remove that accepted
residual. Keep the service optional and its host/runtime access within the operator's existing trust boundary.
