# MCP servers in jobs

pi can call tools on MCP servers. In pi-dispatch a job connects only the servers **you** offer in the overlay and
its trigger names. A repo's own `.pi/mcp.json` is never read for a job, and a server an extension registers is never
connected.

This page covers the overlay file, `import-pi` and `doctor`. Naming servers in a trigger (`run.mcp`) and connecting
them in the job come next; until then an overlay `mcp.json` is staged and checked but not used.

## The overlay file

Servers live in `mcp.json` in the overlay folder (`PI_GLOBAL_PI_DIR`), in pi's own `mcpServers` shape:

```json
{
  "mcpServers": {
    "docs": {
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer ${DOCS_TOKEN}" },
      "description": "Search the product documentation",
      "exposure": "codemode"
    },
    "files": {
      "command": "/opt/pi-global/mcp/files-server",
      "args": ["--root", "/workspace"],
      "env": { "FILES_TOKEN": "${FILES_TOKEN}" },
      "description": "Index of the checkout's files",
      "exposure": "deferred"
    }
  }
}
```

`pi-dispatch import-pi` writes this file from your own `~/.pi/agent/mcp.json`. It keeps only the servers a job can
use, prints each one it staged, and names each one it left behind with the reason. The overlay's file follows your
host's: each import replaces it, and with `--no-mcp`, with no `mcp.json` on your host, or with no server a job can
use, the overlay gets none. That includes a file you wrote into the overlay by hand, so either keep your servers in
`~/.pi/agent/mcp.json` or do not run `import-pi` over a hand-written one. If your host file cannot be read (not JSON,
a key written twice), the import leaves the overlay's file as it was and says so. `pi-dispatch doctor` checks the
overlay's file either way.

### What a server may say

- **A name** of lowercase letters, digits and `-`, up to 32 characters. A name holding `dispatch` is reserved.
- **`description`**, required: one line of at most 300 characters, with no control or invisible formatting
  character. pi puts it in the job's prompt, so you write the words the agent reads about the server, not the server.
- **A streamable HTTP server** has `url` and optionally `headers`. **A stdio server** has `command`, and optionally
  `args` and `env`. `type` is optional (`http`, `streamable-http` or `stdio`).
- **`exposure`** and **`toolExposure`**, as in pi: `codemode`, `deferred`, `direct` or `hidden`.
- **`timeout`** in whole seconds (1 to 600) and **`enabled`**.

### Credentials are references

The overlay is mounted into every job's container, so a credential is never written in it. You write a reference,
`${NAME}` with `NAME` in capitals, digits and `_`, and the job fills it in from the variables its trigger already
passes, through `run.secrets` ([secrets.md](secrets.md)) or `PI_FORWARD_ENV`. A reference goes wherever the server
wants its key:

- **a header:** `"Authorization": "Bearer ${DOCS_TOKEN}"`. A header value is `${NAME}`, or one of these schemes and a
  space before it: Bearer, Basic, Token, Bot, ApiKey, Key, Splunk, SSWS, Digest;
- **an env value:** exactly `"${FILES_TOKEN}"`;
- **the url's path or query:** `"https://actions.example.com/mcp/${ZAP_KEY}/sse"`, `"https://h/mcp?api_key=${KEY}"`;
- **an argument:** `["--token=${TOKEN}"]`, `["--header", "Authorization: Bearer ${TOKEN}"]`.

Header values, env values and query values are always references: none of them is ever written in the overlay,
whatever its name, so a constant there that is not a secret also goes through a trigger variable. A url's host is
written as is (the egress check reads it before the job starts), and a url has no fragment, user name or password.
Write the url plainly, as a browser would show it: lowercase scheme and host, `https://` with two slashes, no `:443`.
`doctor` and `import-pi` show the plain form when a url is written another way.

pi itself would run a value starting with `!` as a shell command and expand a bare `$NAME`; pi-dispatch fills in the
references itself, so a secret whose value starts with `!` is sent as text.

### What is written as is

**A literal argument and a literal part of a url's path are written in the overlay as they are**, and every job can
read the overlay. Nothing can tell a key from a file name there: two earlier rules that tried (one for header and env
names, one for flags) refused `--max-tokens 4096` and still let `--api_key=sk-...` through. So put a credential in a
reference, and check what you stage: `import-pi` prints each server it staged.

### Commands

- A stdio `command` is a bare name found on the job image's `PATH`, or an absolute path under `/usr`, `/bin`,
  `/sbin`, `/opt` or `/app`: the image's own folders and the overlay at `/opt/pi-global`. Any other folder is one the
  job can write (`/workspace`, `/tmp`, its home), so install the server in the [job image](job-image.md) or the
  overlay.
- No `command` or argument starts with `~`: pi reads it as the job's home folder.
- A package runner (`npx`, `npm`, `pnpm`, `pnpx`, `yarn`, `bunx`, `bun`, `uvx`, `uv`, `pipx`) is refused unless the
  entry says `"allowPackageRunner": true`. Such a server is downloaded at the start of every job that uses it, at
  whatever version the registry serves, and the job reaches the registry only if you allowlist it.
- These rules read the command, not what it runs: `node` or `python3` with a script path, or a launcher such as `env`
  or `sh`, run whatever their arguments say. That is your choice in your file.

### What else is refused

- `auth` and `oauth`: a job cannot finish a sign-in in a browser, and must not hold pi's `mcp-auth.json`. Give the
  server a token in a header instead.
- `cwd`: a job runs its servers in the checkout.
- The legacy SSE transport. Use the server's streamable HTTP URL.
- Any other key. A key a newer pi adds is refused until pi-dispatch knows what it does in a job.

## What doctor checks

- that `mcp.json` reads, and which servers it offers;
- each server it refuses, and why (a job that names it is refused);
- no `mcp-auth.json` in the overlay (it offers to delete one);
- a server that uses a package runner;
- with the egress policy on, each streamable HTTP server the proxy would not let a job reach. A job reaches a host in
  `egress-allowlist.conf` on port 443, or exactly the host and port of a server declared in `model-endpoints.json`
  ([egress.md](egress.md)). Anything else is refused by the proxy, and so is an allowlisted host that is the proxy's
  own machine (`localhost`, `127.0.0.1`). Doctor reads the allowlist as the proxy does, one host per line. It does
  not look names up, so a name that resolves to the proxy's own machine reads as reachable here and is refused by
  the proxy.
