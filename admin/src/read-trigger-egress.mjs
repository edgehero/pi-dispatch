/** Names in this deployment's current OpenShell policy sources, never credentials or endpoint URLs. */
import * as nodeFs from "node:fs";
import { join } from "node:path";
import { modelEndpointsFilePath } from "@edgehero/pi-dispatch/config";
import { parseAllowlist } from "@edgehero/pi-dispatch/egress-allowlist";
import { loadModelEndpoints } from "@edgehero/pi-dispatch/model-endpoints";
import { networkPolicyFor } from "@edgehero/pi-dispatch/openshell-policy";

export function readTriggerEgress({ deploymentDir, env = {}, fs = nodeFs } = {}) {
  if (typeof deploymentDir !== "string" || deploymentDir === "") return { egressHosts: null, egressProblem: "Current egress rules are not readable without the deployment folder." };
  let allowlist;
  try { allowlist = parseAllowlist(fs.readFileSync(join(deploymentDir, "egress-allowlist.conf"), "utf8")); }
  catch (e) {
    if (e?.code === "ENOENT") allowlist = [];
    else return { egressHosts: null, egressProblem: "The deployment's egress allowlist could not be read." };
  }
  try {
    const endpoints = loadModelEndpoints({ modelEndpointsFile: modelEndpointsFilePath(env), valkeyUrl: env.VALKEY_URL }, { cwd: deploymentDir, readFileSync: fs.readFileSync, existsSync: fs.existsSync });
    const policy = networkPolicyFor({ allowlist, endpoints });
    if (policy.refused) return { egressHosts: null, egressProblem: "The deployment's OpenShell egress sources do not form a valid policy." };
    const hosts = Object.values(policy.network_policies).flatMap((p) => p.endpoints.map((e) => e.host));
    return { egressHosts: [...new Set(hosts)].sort(), egressProblem: null };
  } catch {
    return { egressHosts: null, egressProblem: "The deployment's model endpoints could not be read for its egress policy." };
  }
}
