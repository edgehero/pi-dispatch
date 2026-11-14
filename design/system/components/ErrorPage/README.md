Error pages keep the console's nav and say in one sentence what went wrong and how to get back, instead of raw JSON.

**How a person uses it.**
- **404.** The page names the id the person asked for, says where the console looked and why it may be missing, and offers a search pill already filled with that id, plus Runs and Overview.
- **404 for a short link.** A short link such as `/run/acme/web/999` that no run answers gets the same card, saying no run on that issue or request was found, with the search pill filled with `acme/web#999`. When a place a run is kept could not be read, the card says so with a 503 instead of claiming there is no run.
- **421.** The console only answers on 127.0.0.1. The page names the host the browser asked for and gives the SSH tunnel command to copy.
- **400** follows the same pattern: the field it could not use, by name, and a way back.
- Error pages carry the same CSP and escaping as every page. The API keeps answering in JSON.

**Panels.** `p-error`, `p-error-421`.

**The server provides.** The status, a fixed sentence from the reason catalog, the requested id (escaped), the issue or request a short link names (rebuilt from the link, escaped), and for 421 the Host it refused.

**Fixture note.** These are sample values: the id `gh-zzzz`, the short link `/run/acme/web/999`, the host `myhost.lan`, and the tunnel command with port 7788.
