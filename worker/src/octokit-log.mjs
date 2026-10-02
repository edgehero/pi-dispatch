/**
 * The `log` option every Octokit this project builds is given (issue #530), so no GitHub client writes a plain line
 * into a process whose log stream is one JSON object per line.
 *
 * Octokit's own default logger is `console.warn` and `console.error`, and `@octokit/rest` carries the request-log
 * plugin, which calls `log.error` with `GET /user - 401 with id ... in 12ms` for every failed request. A worker booted
 * with `GITHUB_AUTH_SOURCE=pat` and a refused token printed exactly that beside its `github_auth_unavailable` line, and
 * a pipeline that parses each line as JSON breaks on it.
 *
 * - `debug`, `info` and `error` are dropped. The request-log plugin is the only caller of `info` and `error`, and its
 *   `error` is always followed by the rejection itself, which the caller already reports in its own words (the boot
 *   line's `reason`, a job's refusal). Logging it twice would also put a request path into the stream.
 * - `warn` is KEPT, as one JSON event: it is how `@octokit/request` says an endpoint is deprecated and how
 *   `@octokit/auth-app` says it retried past clock skew, and neither has another surface. Dropping it would make an
 *   endpoint that GitHub is about to remove fail with no warning at all.
 *
 * `log` is the caller's `(event, fields)` logger. Without one the warning still goes out as JSON, on stderr, where
 * Octokit's own `console.warn` would have put it.
 *
 * An Octokit takes it TWICE, which is why the sites spread `octokitLogOptions` rather than pass `log` alone: the
 * deprecation warning is written by `@octokit/request`'s fetch wrapper, which reads `request.log` and falls back to
 * `console`, never the client's own `log` (measured on @octokit/request 10.0.11: with `log` alone the warning still
 * reached stderr as a plain line).
 */
export function octokitLog(log = stderrJson) {
	return {
		debug() {},
		info() {},
		warn: (message) => log("github_client_warning", { message: String(message) }),
		error() {},
	};
}

/** The two places an Octokit reads its logger from, as constructor options to spread. */
export function octokitLogOptions(log) {
	const logger = octokitLog(log);
	return { log: logger, request: { log: logger } };
}

/**
 * What a failure log line may say about a GitHub answer: `{ status, requestId }` from the first Octokit `RequestError`
 * on the error or its `cause` chain, else `{}` (issue #530's review). Dropping Octokit's own error line above also
 * dropped `x-github-request-id`, which is what GitHub support asks for; this puts it back on OUR event.
 *
 * Only those two fields, never the headers object, the request or the response: a RequestError carries the request
 * options and the response body, and only the `authorization` header is redacted there (measured on
 * @octokit/request-error with this project's pins), not a token in a URL or body. A RequestError is recognised by its name, which
 * `@octokit/request-error` sets to "HttpError", and an integer status; a gitlab, forgejo or azure error has neither, so
 * it adds nothing. The id is GitHub's text, kept only in its own shape (hex, `:` and `.`), so the field can never carry
 * anything else into the log.
 */
const REQUEST_ID_RE = /^[A-Za-z0-9:.]{1,100}$/;
export function githubFailureFields(error) {
	for (let e = error, depth = 0; e && depth < 5; e = e.cause, depth += 1) {
		if (e.name === "HttpError" && Number.isInteger(e.status)) {
			const id = e.response?.headers?.["x-github-request-id"];
			return { status: e.status, ...(typeof id === "string" && REQUEST_ID_RE.test(id) ? { requestId: id } : {}) };
		}
	}
	return {};
}

function stderrJson(event, fields) {
	process.stderr.write(`${JSON.stringify({ event, ...fields })}\n`);
}
