/**
 * `GET /api/artifact?id=<run>&name=<file>[&host=<host>]` (issue #920, `REQ-FORGE-JOB-ARTIFACTS`, `REQ-CONSOLE-SECURITY`):
 * one file a forge job kept in /artifacts, from this host's store or (issue #942) from the store of the host that kept
 * it, to a signed-in operator or viewer. The first agent-written bytes the console serves, so every line here is about
 * what a browser may do with them.
 *
 *   - Never to an agent token, although an agent passes every viewer route (`roleRefusal`): a run's files are for the
 *     people who review it, and an agent reading them would be another way for one job's output to reach another.
 *     Refused before anything is read here or asked of another host.
 *   - The name is looked up in the run's manifest, never joined from the request (`artifactFile`, read-model.mjs), and
 *     the file is opened without following a link and must be the manifest's size.
 *   - The type is the manifest's, judged by content when the file was kept: only the four image types and plain text are
 *     sent inline, everything else as `application/octet-stream` and an attachment, so an SVG or an HTML file is never
 *     rendered as one (it was kept as text or binary in the first place).
 *   - Every answer carries `ARTIFACT_CSP`, a sandbox with nothing allowed, so even a browser that decided to render a
 *     file as a page would run no script, load nothing and post nowhere on the console's origin. The console's other
 *     security headers (nosniff, no-store, same-origin resource policy, no framing) stay as every route sets them.
 *   - A read is not audited, as a transcript's is not (`INT-CONSOLE-AUDIT-LOG` names writes, sign-ins and refusals).
 *
 * ANOTHER HOST'S FILE (issue #942, `INT-ARTIFACTS-CHANNEL`): asked for only where this host's store does not hold the run
 * or the file and `host` names a live host other than this one (`hostArtifactFile`, read-model.mjs). Every rule above
 * holds, and one more: the bytes are the manifest's. The entry (name, type, size, sha256) is the one in the manifest
 * this console asked that host for and validated, looked up by the request's name, so nothing a chunk's reply says
 * sets a header. The headers go once the first chunk has arrived, the bytes a chunk at a time as they arrive, each held
 * to its expected offset and length under a running sha256, and the LAST chunk only once the digest and the count of
 * every byte are the manifest's. Anything else destroys the connection, so a browser never receives a complete answer
 * that is not the manifest's file: it sees a body shorter than its length, which it treats as a failed download.
 * Nothing is kept on this host's disk. A request that the host cannot answer is answered before any header, with a
 * fixed sentence that names nothing from the request.
 */
import { createHash } from "node:crypto";
import { ARTIFACTS_CHUNK_BYTES } from "@edgehero/pi-dispatch/artifacts-channel";
import { WORKER_NAME_RE } from "@edgehero/pi-dispatch/config";

/** The types sent inline; anything else is an attachment. */
export const ARTIFACT_INLINE_TYPES = Object.freeze(["image/png", "image/jpeg", "image/gif", "image/webp", "text/plain"]);

/** The policy every artifact answer carries: a sandboxed document that may run, load and send nothing. */
export const ARTIFACT_CSP = "sandbox; default-src 'none'; img-src 'self'; style-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'";

/**
 * What a request for another host's file is answered with before any byte (issue #942), by the reader's or the
 * channel's word: `[status, sentence]`, the sentence fixed, so it names no host, run or file the request gave.
 */
export const HOST_ARTIFACT_REFUSALS = Object.freeze({
  missing: Object.freeze([404, "the host that keeps this run's files keeps no such file"]),
  "not-running": Object.freeze([503, "the host that keeps this file is not running now"]),
  "no-answer": Object.freeze([503, "the host that keeps this file did not answer in time, or runs an earlier version that cannot send files"]),
  busy: Object.freeze([503, "the host that keeps this file is busy sending other files; try again shortly"]),
  full: Object.freeze([503, "this console is already fetching as many files from other hosts as it takes at once; try again shortly"]),
  changed: Object.freeze([503, "the file on the host that keeps it is no longer the one its manifest lists"]),
  unreadable: Object.freeze([503, "the file could not be read on the host that keeps it"]),
});

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
  const host = params.get("host");
  if ([...params.keys()].some((k) => k !== "id" && k !== "name" && k !== "host") || params.getAll("id").length !== 1 || params.getAll("name").length !== 1 || params.getAll("host").length > 1 || (host !== null && !WORKER_NAME_RE.test(host))) {
    return ctx.json(400, { error: "name exactly one run id and one file name, and at most one host by its worker name" });
  }
  const fleet = ctx.deps.pageDeps?.fleet;
  const got = typeof fleet?.artifactFile === "function" ? fleet.artifactFile(params.get("id"), params.get("name")) : { unreadable: true };
  if (got?.missing && host !== null) return sendHostArtifact(ctx, fleet, host);
  if (got?.missing) return ctx.json(404, { error: "this host keeps no such file for that run" });
  if (!Buffer.isBuffer(got?.bytes)) return ctx.json(503, { error: "the file could not be read here" });
  if (ctx.res.headersSent) return;
  ctx.res.writeHead(200, artifactHeaders({ type: got.type, name: got.name, length: got.bytes.length }));
  ctx.res.end(got.bytes);
}

/** The refusal for an answer that is not a chunk: the reader's `unavailable` word or the channel's, else unreadable. */
function hostRefusalOf(got) {
  if (got?.missing === true) return "missing";
  if (got?.changed === true) return "changed";
  if (typeof got?.unavailable === "string" && Object.hasOwn(HOST_ARTIFACT_REFUSALS, got.unavailable)) return got.unavailable;
  if (got?.error === "host-busy") return "busy";
  if (got?.error === "host-unavailable") return "no-answer";
  return "unreadable";
}

/**
 * Whether `got` is the chunk at `offset` of a file of `size` bytes: exactly that offset, exactly
 * `min(ARTIFACTS_CHUNK_BYTES, size - offset)` bytes, and `last` exactly when they end the file.
 */
function chunkAt(got, offset, size) {
  return Buffer.isBuffer(got?.data) && got.offset === offset && got.data.length === Math.min(ARTIFACTS_CHUNK_BYTES, size - offset) && got.last === (offset + got.data.length === size);
}

/** Until `res` can take more, or has closed. */
function drained(res) {
  return new Promise((resolve) => {
    const done = () => {
      res.removeListener("drain", done);
      res.removeListener("close", done);
      resolve();
    };
    res.once("drain", done);
    res.once("close", done);
  });
}

/**
 * Another host's file (see the header). The transfer is closed on every path, once the answer is sent or the browser
 * has gone, which also stops the requests: a closed transfer asks the host for nothing more.
 */
async function sendHostArtifact(ctx, fleet, host) {
  const { res, searchParams: params } = ctx;
  let remote = null;
  let gone = res.destroyed === true;
  const left = () => {
    gone = true;
    remote?.close?.();
  };
  res.once("close", left);
  try {
    remote = typeof fleet?.hostArtifactFile === "function" ? await fleet.hostArtifactFile(params.get("id"), params.get("name"), host) : { unreadable: true };
    if (gone) return;
    const refuse = (got) => {
      const [status, sentence] = HOST_ARTIFACT_REFUSALS[hostRefusalOf(got)];
      return ctx.json(status, { error: sentence });
    };
    if (typeof remote?.chunk !== "function" || typeof remote.entry !== "object" || remote.entry === null) return refuse(remote);
    const { entry } = remote;
    let got = await remote.chunk(0);
    if (gone) return;
    // Before the headers, an answer that is no chunk is refused by its own word, and a chunk that is not the first one
    // of this entry as unreadable.
    if (!chunkAt(got, 0, entry.size)) return refuse(got?.data === undefined ? got : null);
    if (res.headersSent) return;
    res.writeHead(200, artifactHeaders({ type: entry.type, name: entry.name, length: entry.size }));
    const digest = createHash("sha256");
    let offset = 0;
    for (;;) {
      digest.update(got.data);
      offset += got.data.length;
      if (got.last) {
        if (offset === entry.size && digest.digest("hex") === entry.sha256) res.end(got.data);
        else res.destroy();
        return;
      }
      if (!res.write(got.data)) await drained(res);
      if (gone) return;
      got = await remote.chunk(offset);
      if (gone) return;
      if (!chunkAt(got, offset, entry.size)) {
        res.destroy();
        return;
      }
    }
  } finally {
    res.removeListener("close", left);
    remote?.close?.();
  }
}
