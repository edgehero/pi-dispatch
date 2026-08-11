import { spawn as nodeSpawn } from "node:child_process";

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
	const [cmd, args] =
		platform === "darwin" ? ["open", [url]] : platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
	try {
		const child = spawn(cmd, args, { stdio: "ignore", detached: true });
		child.on("error", () => {});
		child.unref();
	} catch {
		// No opener on this host -- the printed URL carries the flow.
	}
}
