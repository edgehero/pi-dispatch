// Proves jiti resolves the @edgehero/pi-dispatch workspace symlink and its
// exports map (the real 3.2 risk), not just bare-relative TypeScript.
import { settingsFilePath } from "@edgehero/pi-dispatch/runtime-settings";
// The graph read-model's subpath (issue #54): a missing exports-map entry fails here, in a unit
// test, rather than at the first /dispatch graph in a bundled install.
import { selectEntries, keepOnlyDeclaredSkills } from "@edgehero/pi-dispatch/materialize";
import { aiTriggerAllows } from "@edgehero/pi-dispatch/flow-gate";
import { CHAIN_DEPTH_MAX_DEFAULT } from "@edgehero/pi-dispatch/config";

export const ok =
  typeof settingsFilePath === "function" &&
  typeof selectEntries === "function" &&
  typeof keepOnlyDeclaredSkills === "function" &&
  typeof aiTriggerAllows === "function" &&
  Number.isInteger(CHAIN_DEPTH_MAX_DEFAULT);
