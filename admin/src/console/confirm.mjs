/**
 * Confirm tickets (issue #640): the console's equivalent of the extension's confirm dialog, bound to the exact diff.
 *
 * A write is two requests. The preview builds the change, shows its diff, and stores everything the write needs here:
 * the payload, the `expect` snapshots of the files it was built from (`writeInputs`), and the before/after digests the
 * audit row records. The browser gets only a random ticket. The confirm redeems the ticket and passes `expect` straight
 * to the write, whose re-check before the rename refuses if any file changed since the preview. So a confirm applies
 * exactly what was previewed, or nothing, and the browser cannot swap the payload between the two requests: it never
 * held it.
 *
 * A ticket is single use: ANY redeem attempt deletes it, a refused one included, so a ticket cannot be probed (wrong
 * action first, right one second) or replayed. It is bound to the session that previewed it and to the action, and it
 * lasts `ttlMs` (5 minutes by default). In memory only: a restart drops every ticket along with every session.
 * At most `max` live tickets; past that the oldest is dropped, so a client that previews in a loop holds bounded memory.
 */
import { randomBytes } from "node:crypto";

/** The one instruction every refused redeem ends with; the console's confirm sends the refusal as it is. */
export const PREVIEW_AGAIN = "Preview the change again and confirm the new preview";

export function makeConfirmTickets({ now = () => Date.now(), random = randomBytes, ttlMs = 300000, max = 256 } = {}) {
  // Insertion order is issue order, so the first key is always the oldest.
  const tickets = new Map();

  function sweep(t) {
    for (const [id, entry] of tickets) if (entry.expiresAt <= t) tickets.delete(id);
  }

  return {
    /**
     * Store a previewed change and return `{ticket}`, the only thing the browser gets. `reserve` is a paid action's
     * estimate (what the worker will hold) and `targets` a bulk action's job list with each job's previewed state
     * (issue #642); both ride the ticket so the confirm acts on exactly what the preview showed. `count` is how many
     * jobs a resume lets start, which the preview showed and the audit row records.
     */
    issue({ sessionId, action, target, payload, expect, beforeDigest, afterDigest, reserve = null, targets = null, count = null }) {
      const t = now();
      sweep(t);
      while (tickets.size >= max) tickets.delete(tickets.keys().next().value);
      const ticket = random(32).toString("base64url");
      tickets.set(ticket, { sessionId, action, target, payload, expect, beforeDigest, afterDigest, reserve, targets, count, issuedAt: t, expiresAt: t + ttlMs });
      return { ticket };
    },

    /**
     * Spend a ticket: `{entry}` (what was stored at the preview) or `{refusal}`. The ticket is gone after this call
     * whatever the outcome. Refused when unknown (never issued, already used, dropped), expired, issued to another
     * session, or issued for another action. The refusal never quotes the ticket.
     */
    redeem({ sessionId, ticket, action }) {
      const entry = typeof ticket === "string" ? tickets.get(ticket) : undefined;
      if (typeof ticket === "string") tickets.delete(ticket);
      const again = PREVIEW_AGAIN;
      if (!entry) return { refusal: `this confirmation is not valid: it was already used, has expired, or was never issued. ${again}` };
      if (entry.expiresAt <= now()) return { refusal: `this confirmation has expired. ${again}` };
      if (entry.sessionId !== sessionId) return { refusal: `this confirmation belongs to another sign-in. ${again}` };
      if (entry.action !== action) return { refusal: `this confirmation was issued for another action. ${again}` };
      return { entry };
    },

    /** How many tickets are held (expired ones included until the next issue). */
    size() {
      return tickets.size;
    },
  };
}
