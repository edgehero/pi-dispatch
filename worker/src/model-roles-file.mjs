import * as nodeFs from "node:fs";
import { parseTriggersDocument } from "./triggers.mjs";

/** Same live/last-good posture as project bundles. A broken first read cannot silently remove model policy. */
export function makeReadModelRoles({ triggersPath, fs = nodeFs, log = () => {} }) {
	let last = null;
	let failed = false;
	return () => {
		if (!triggersPath) return {};
		try {
			const text = fs.readFileSync(triggersPath, "utf8");
			last = parseTriggersDocument(text, triggersPath).modelRoles;
			failed = false;
			return last;
		} catch (error) {
			if (error?.code === "ENOENT" && last === null) return {};
			if (!failed) log("model_roles_last_good", { kept: last !== null });
			failed = true;
			if (last !== null) return last;
			if (error?.piDispatchConfig === true) throw Object.assign(new Error("the model roles file is invalid and no validated snapshot exists"), { piDispatchConfig: true, modelSelectionReason: "model-roles-invalid" });
			throw new Error("modelRoles could not be read and no validated snapshot exists");
		}
	};
}
