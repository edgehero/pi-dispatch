/**
 * THE one rule for an image reference this project hands a container runtime as its image positional (issue #471):
 * `run.image` in the triggers file (`triggers.mjs`), `PI_JOB_IMAGE` at the worker's boot (`config.mjs`), and the image
 * doctor inspects and runs (`doctor.mjs`). Before #471 only `run.image` was judged, so a `PI_JOB_IMAGE` of `--help`
 * booted a worker whose every job handed docker a flag where the image belongs.
 *
 * Deliberately NOT the OCI grammar (`triggers.mjs` says why: docker validates its own grammar, and an over-strict regex
 * takes a valid deployment down at boot). Each refusal names a value that corrupts something on OUR side: a blank one
 * throws inside the argv builder after a budget slot is reserved, surrounding whitespace means the file disagrees with
 * what runs, a leading `-` is read as a flag by the runtime's parser, and a control character reaches argv, logs and a
 * terminal as bytes nobody wrote on purpose.
 *
 * Returns null for an acceptable reference, else `{ code, reason }`, `reason` a clause to follow the value's name.
 */
export function imageRefProblem(image) {
	if (typeof image !== "string" || image.trim() === "") return { code: "blank", reason: "must be a non-empty string" };
	if (image !== image.trim()) return { code: "padded", reason: "must not have leading or trailing whitespace" };
	if (image.startsWith("-")) return { code: "dash", reason: 'must not start with "-", which the runtime reads as a flag where the image belongs' };
	if (/[\u0000-\u001f\u007f-\u009f]/.test(image)) return { code: "control", reason: "must not hold a control character" };
	return null;
}

/**
 * Whether an image reference names its registry (issue #523), by the docker reference grammar: the first path segment
 * is a registry host only when there is a `/` after it and it holds a `.` or a `:`, or is `localhost`. Everything else
 * (`pi-job:2.1.0`, `team/job:7`) is a short name the runtime resolves on a public registry (Docker Hub, or podman's
 * search registries), where anyone may publish that name.
 */
export function registryQualified(image) {
	const slash = image.indexOf("/");
	if (slash < 0) return false;
	const first = image.slice(0, slash);
	return first.includes(".") || first.includes(":") || first === "localhost";
}

/**
 * Whether a missing image may be offered as a pull (issue #523, review round 2): a registry-qualified name other than
 * `localhost/...`. That prefix is qualified for the "never Docker Hub" rule, but it is podman's name for an image built
 * on this host, with no registry behind it, so a pull of it can only fail or reach whatever listens on this host.
 * `localhost:<port>/...` names a real registry on a port and is pullable.
 */
export function pullOffered(image) {
	return registryQualified(image) && !image.startsWith("localhost/");
}

/**
 * How to provide a missing deployment job image with `bin` (docker or podman), ONE text for `up` and doctor's fix lines
 * (issue #523, review): the worker's default `pi-job:latest` is ghcr's latest pulled and re-tagged, since that local
 * name has no registry behind it; a registry-qualified name is pulled as it is named; a short name is never offered as
 * a pull, since a public registry answers for it, nor a `localhost/` name (`pullOffered`), so the text says how to
 * provide it instead.
 */
export function jobImageFix(bin, image) {
	if (image === "pi-job:latest") return `${bin} pull ghcr.io/edgehero/pi-job:latest && ${bin} tag ghcr.io/edgehero/pi-job:latest pi-job:latest`;
	if (pullOffered(image)) return `${bin} pull ${image}`;
	if (registryQualified(image)) return `${image} is a locally built name (localhost/ is no registry to pull from): build it on this host, or \`${bin} tag\` an image you have as ${image}`;
	return `${image} names no registry host, so a pull would fetch whatever a public registry holds under that name: build it on this host, \`${bin} tag\` an image you have as ${image}, or set PI_JOB_IMAGE to a registry-qualified name (such as ghcr.io/edgehero/pi-job:<version>)`;
}
