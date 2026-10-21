import { spawn as nodeSpawn } from "node:child_process";

/**
 * The opener's argv for `url` on `platform`. On win32 it is `rundll32 url.dll,FileProtocolHandler <url>`, the shell's
 * own URL handler, and NOT `cmd /c start "" <url>` (what it was until issue #708): `cmd` re-parses its command line,
 * so an unquoted `&` ends the command there (`start` opened the URL up to it and `cmd` ran the rest as a second
 * command), and node quotes an argument only when it holds a space or a quote, which a URL never does. A login link
 * (`login/code#<code>&next=/runs`) and a GitHub install URL both carry one. rundll32 is no shell: it hands the rest of
 * its command line to the handler as it is, `&` and `#` included. Quoting the URL inside `start` was rejected because
 * it relies on node's quoting rules and `cmd`'s together, and `^`-escaping because `cmd /c` and `start` each strip one
 * level.
 */
export function openerArgv(url, platform = process.platform) {
	if (platform === "darwin") return ["open", [url]];
	if (platform === "win32") return ["rundll32", ["url.dll,FileProtocolHandler", url]];
	return ["xdg-open", [url]];
}

/**
 * Can a browser opened here be in front of the person at this terminal (issue #708)? Not over SSH (any of
 * `SSH_CONNECTION`, `SSH_CLIENT` or `SSH_TTY` set: the browser would open on the remote host, or nowhere), and on
 * Linux and the BSDs only with a display (`DISPLAY` or `WAYLAND_DISPLAY`: without one `xdg-open` falls back to a text
 * browser or fails). macOS and Windows always have their desktop's opener. A false answer means the caller prints the
 * URL and spawns nothing; the printed URL is the contract either way.
 */
export function isLocalBrowserSession({ env = process.env, platform = process.platform } = {}) {
	const set = (k) => typeof env?.[k] === "string" && env[k] !== "";
	if (set("SSH_CONNECTION") || set("SSH_CLIENT") || set("SSH_TTY")) return false;
	if (platform === "darwin" || platform === "win32") return true;
	return set("DISPLAY") || set("WAYLAND_DISPLAY");
}

/**
 * Best-effort platform browser opener. ALWAYS paired with the URL printed to the terminal -- a
 * headless or SSH'd operator has no opener that works, and the printed URL pasted into any browser
 * (on the right machine, or through the port-forward the caller suggests) is the real contract; the
 * spawn is only a convenience on top. Failures are swallowed for the same reason.
 *
 * One module on purpose (issue #54): the GitHub App wizard and the admin's graph export both open a
 * browser, and two hand-copies of platform-opener argv is exactly the drift class the repo's mirror
 * tests exist to prevent. `spawn` and `platform` are injectable so the argv table is testable
 * without launching anything.
 */
export function openBrowser(url, { spawn = nodeSpawn, platform = process.platform } = {}) {
	const [cmd, args] = openerArgv(url, platform);
	try {
		const child = spawn(cmd, args, { stdio: "ignore", detached: true });
		child.on("error", () => {});
		child.unref();
	} catch {
		// No opener on this host -- the printed URL carries the flow.
	}
}
