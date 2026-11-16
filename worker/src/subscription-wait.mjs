/** Host-only control flow for a determinate, free subscription admission delay. Never queued authority. */
export class SubscriptionWait extends Error {
	constructor({ wait, until, status = null }) {
		if (!["subscription-auth", "subscription-quota", "subscription-owner"].includes(wait) || !Number.isSafeInteger(until) || until < 0 || until > 253_402_300_799_999) throw new TypeError("invalid subscription admission wait");
		super("subscription admission must wait");
		this.name = "SubscriptionWait";
		this.wait = wait;
		this.until = until;
		this.resetAt = Number.isSafeInteger(status?.until) ? status.until : null;
		this.budgetReserved = false;
		this.quotaConfirmed = wait === "subscription-quota" && status?.state === "exhausted" && status.bindingValid !== false;
	}
}
