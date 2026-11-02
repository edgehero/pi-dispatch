# pi-dispatch sandbox gateway

An optional browser terminal for an existing pi-dispatch sandbox. Install it on the sandbox's host, then enable it
with protected configuration. It is off until explicitly started:

```sh
npm install -g @edgehero/pi-dispatch-sandbox-gateway
pi-dispatch-sandbox-gateway --config /absolute/path/sandbox-gateway.json
```

Use the existing runtime account and an explicit Docker or rootless Podman socket. The gateway attaches only to an
already running, registered sandbox. It cannot create a container, choose an image, start another shell or end the
sandbox. Open in Terminal and the command-copy route remain available.

The gateway needs its own hostname, separate from the console, and HTTPS for public access. Another port on the same
hostname does not isolate cookies. Each browser opening requires the original console tab and operator session,
fresh same-token verification, a cookie-bound one-use grant and current authorization. Closing the browser detaches
and keeps the shell; the console's confirmed End action remains separate. Phones use the native terminal command.

The package contains its executable and self-hosted terminal assets. It requires Node 22.19 or newer. No repository
checkout, browser build tool, provider key, forge credential or console token file belongs in the gateway deployment.

See the complete [configuration and operator reference](https://github.com/edgehero/pi-dispatch/blob/main/docs/sandbox-gateway.md)
and the [accepted security boundaries](https://github.com/edgehero/pi-dispatch/blob/main/SECURITY.md#the-sandbox-browser-gateway).
The runtime socket retains its full authority if the gateway is compromised; the attach-only interface does not
reduce the socket's permissions.
