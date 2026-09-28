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
