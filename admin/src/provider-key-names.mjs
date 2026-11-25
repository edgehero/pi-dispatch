/** pi's provider key variables, the generated data-only table (#751). Since issue #1013 it is the worker's leaf, which the
 * triggers loader reads too, generated and checked by .github/scripts/provider-key-names.mjs: one table, re-exported here
 * for the console's modules, never a second copy. Data only, so no provider SDK reaches the console's bundle. */
export { PROVIDER_KEYS_SOURCE_SHA256, PROVIDER_KEY_NAMES, providerKeyNames } from "@edgehero/pi-dispatch/provider-key-names";
