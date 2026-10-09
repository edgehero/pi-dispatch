/**
 * Where `launch/render-images.mjs` finds the Valkey-protocol server it starts, in its own module so its test can ask
 * the same question without running the script.
 */
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

/** The first of `names` that is an executable file in a directory of `path`, or null. */
export function findOnPath(names, path = process.env.PATH ?? "") {
	for (const name of names) {
		for (const dir of path.split(delimiter).filter(Boolean)) {
			try {
				accessSync(join(dir, name), constants.X_OK);
				return join(dir, name);
			} catch {
				// not here
			}
		}
	}
	return null;
}
