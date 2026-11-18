/**
 * `GET /api/artifact?id=<run>&name=<file>` (issue #920, `REQ-FORGE-JOB-ARTIFACTS`, `REQ-CONSOLE-SECURITY`): one file a
 * forge job kept in /artifacts, from this host's store, to a signed-in operator or viewer. The first agent-written bytes
 * the console serves, so every line here is about what a browser may do with them.
 *
 *   - Never to an agent token, although an agent passes every viewer route (`roleRefusal`): a run's files are for the
 *     people who review it, and an agent reading them would be another way for one job's output to reach another.
 *   - The name is looked up in the run's manifest, never joined from the request (`artifactFile`, read-model.mjs), and
 *     the file is opened without following a link and must be the manifest's size.
 *   - The type is the manifest's, judged by content when the file was kept: only the four image types and plain text are
 *     sent inline, everything else as `application/octet-stream` and an attachment, so an SVG or an HTML file is never
 *     rendered as one (it was kept as text or binary in the first place).
 *   - Every answer carries `ARTIFACT_CSP`, a sandbox with nothing allowed, so even a browser that decided to render a
 *     file as a page would run no script, load nothing and post nowhere on the console's origin. The console's other
 *     security headers (nosniff, no-store, same-origin resource policy, no framing) stay as every route sets them.
 *   - A read is not audited, as a transcript's is not (`INT-CONSOLE-AUDIT-LOG` names writes, sign-ins and refusals).
 */

/** The types sent inline; anything else is an attachment. */
export const ARTIFACT_INLINE_TYPES = Object.freeze(["image/png", "image/jpeg", "image/gif", "image/webp", "text/plain"]);

/** The policy every artifact answer carries: a sandboxed document that may run, load and send nothing. */
export const ARTIFACT_CSP = "sandbox; default-src 'none'; img-src 'self'; style-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'";

/** The headers for a file of `type` named `name` (the name is held to the artifact charset, so it needs no quoting). */
export function artifactHeaders({ type, name, length }) {
  const inline = ARTIFACT_INLINE_TYPES.includes(type);
  return {
    "content-type": type === "text/plain" ? "text/plain; charset=utf-8" : inline ? type : "application/octet-stream",
    "content-length": String(length),
    "content-disposition": `${inline ? "inline" : "attachment"}; filename="${name}"`,
    "content-security-policy": ARTIFACT_CSP,
  };
}

export async function getArtifact(ctx) {
  if (ctx.session?.role === "agent") return ctx.json(403, { error: "an agent token cannot open the files a run kept; sign in as a person" });
  const params = ctx.searchParams;
  if ([...params.keys()].some((k) => k !== "id" && k !== "name") || params.getAll("id").length !== 1 || params.getAll("name").length !== 1) {
    return ctx.json(400, { error: "name exactly one run id and one file name" });
  }
  const fleet = ctx.deps.pageDeps?.fleet;
  const got = typeof fleet?.artifactFile === "function" ? fleet.artifactFile(params.get("id"), params.get("name")) : { unreadable: true };
  if (got?.missing) return ctx.json(404, { error: "this host keeps no such file for that run" });
  if (!Buffer.isBuffer(got?.bytes)) return ctx.json(503, { error: "the file could not be read here" });
  if (ctx.res.headersSent) return;
  ctx.res.writeHead(200, artifactHeaders({ type: got.type, name: got.name, length: got.bytes.length }));
  ctx.res.end(got.bytes);
}
