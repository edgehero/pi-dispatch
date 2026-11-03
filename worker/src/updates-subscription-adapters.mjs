/**
 * Which packages carry a reviewed subscription adapter's identity (`docs/global-pi-overlay.md`), which re-staging would break. Its own module so that the console can ask without loading the stager.
 */
import { COMMUNITY_AUTH_ADAPTERS } from "./community-auth-metadata.mjs";

export function isSubscriptionAdapter(name) {
	return Object.values(COMMUNITY_AUTH_ADAPTERS).some((adapter) => adapter.package === name);
}
