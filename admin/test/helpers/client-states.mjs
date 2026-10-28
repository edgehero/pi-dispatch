/**
 * Every state the browser script can put a page in that a card names (issue #737, PR 2), and the test that reaches it
 * (`console-client-states.test.mjs`, which runs the real script over the server's own markup). `card` is the design
 * card's ledger (`admin/test/fixtures/console-ledger/<card>.json`), `state` the ledger element's `el`, `reached` the
 * name of the test that drives the script into that state and checks what the page shows.
 *
 * Held both ways by the test: each `reached` names a test in that file, and every element of kind "state" in the
 * ConfirmStates, LiveStates, SignIn and AccessStates ledgers has a row here. A row whose state is not a ledger element
 * (the kept-still note, the stale dimming, the link page's states) is a state the script switches that the ledgers file
 * under another kind; it is listed so the table is the whole of what the script can show.
 *
 * The width check is the other half only for the states a panel golden draws (`helpers/panel-goldens.mjs`
 * `PANEL_STATES`), each loaded in Chrome at 375 px under the CSP (`.github/scripts/console-width-check.mjs`). A state
 * here with no golden of its own (the Valkey, audit, failed, setup and preview-failed refusals, the countdown at 0:00,
 * a sign-out not confirmed) is held by this table alone, never measured at a width.
 */

/** The ledgers whose "state" elements must each be reached here. */
export const LEDGER_CARDS = Object.freeze(["ConfirmStates", "LiveStates", "SignIn", "AccessStates"]);

const row = (card, state, reached) => Object.freeze({ card, state, reached });

export const T = Object.freeze({
  previewing: "a preview opens the slot after the panel that asked, outside its .legacy wrapper, any table cell and any layout grid marked data-slot-after, titled, with Confirm disabled",
  unchanged: "no change: the bar says so with Close alone, and Close puts the skeleton back and hides the slot",
  paid: "a paid preview: its reserve sentence, its Undo line and its label in the paid fill, and Confirm sends the ticket once, then reloads",
  bulk: "a bulk preview lists each job with its reserve and the total; a bulk confirm with jobs refused shows each job, its audit rows and Reload",
  expiry: "the ticket's countdown runs from the bar's own span, second by second, and at 0:00 Confirm is disabled and sends nothing",
  refusedPreview: "refused at preview: the refusal's bar with Close, and an answer with no html, no answer or a field the form cannot read said as text",
  refusedConfirm: "refused at confirm: Preview again and Try again ask anew, Look again reloads (or, under the bar saying this browser is someone else's, goes to sign-in), an audit failure offers only Close, and no answer is said and never resent",
  done: "the done banner after a write: its audit row linked, and its Undo previews the inverse with the change's own body, after the banner",
  held: "a panel in use keeps still: the newest update waits under the kept-still note, once, and lands when the hold ends",
  pill: "the live pill through every state: Live, Reconnecting, Not live and Signed out, each with its note where it has one",
  unreachable: "a closed stream the console cannot be asked about keeps the page under the retry note, asking every 2 s, and reloads once it answers",
  shutdown: "the console stopping keeps the page and asks after a wait; a 401 then is a sign-in it no longer knows, and a 200 reloads only into the same person",
  ended: "a session that ended: Signed out, the out note and sign-in with its reason; elsewhere asks first, after a wait, reloads only into the same person and goes to sign-in as switched for anyone else; a closed transcript stream is asked about the same way, and so is a write's 401, which first says in the slot that nothing was changed; the tab signing out ignores its own end, and a sign-out not confirmed (or not answered within 10 s) keeps the page and says so once, whichever press it was",
  bothClosed: "one question at a time answers every caller: a run page's shared stream says what the answer means, and a write's 401 while a stream's question is out says so in the slot and leaves with that answer",
  stale: "stale: the page dims under the time it was last seen, says whether the tokens file or the data failed, keeps its time through a reconnect, and fresh alone takes it back",
  signIn: "sign-in: what needs the script is revealed, a refusal shows its one notice, the ended notice gives way, an older attempt's answer does nothing, and a post that reaches nothing keeps the page and retries every 2 s",
  signInStops: "a sign-in or a link that reaches nothing stops after 30 posts or 60 s, judged before each post goes out: nothing more is sent, the token or code is dropped, and the stop notice says so",
  link: "the one-time link: no code, a used link, a refusal with its notice, a rate refusal that leaves it untried, a post that reaches nothing kept waiting and retried, a new link pasted in loaded, and the drawn state kept until an answer moves it",
});

/**
 * The table. The state names are the ledgers' element names; a ledger that words one differently fails the test until
 * the two agree.
 */
export const CLIENT_STATES = Object.freeze([
  // ConfirmStates
  row("ConfirmStates", "previewing (Confirm disabled)", T.previewing),
  row("ConfirmStates", "no change with Close only", T.unchanged),
  row("ConfirmStates", "Paid confirm label", T.paid),
  row("ConfirmStates", "Bulk with each job's reserve, how many more, the total", T.bulk),
  row("ConfirmStates", "Undo line", T.paid),
  row("ConfirmStates", "Expiry", T.expiry),
  row("ConfirmStates", "Bulk results, one line per job, Reload primary", T.bulk),
  row("ConfirmStates", "Audit rows 41 to 43", T.bulk),
  row("ConfirmStates", "Refused at preview: field rule (`BadRequest`), whole action, missing deps (:1317), preview failed (:1325)", T.refusedPreview),
  row("ConfirmStates", "Refused at confirm (expired, used, another sign-in or action, changed, Valkey, audit)", T.refusedConfirm),
  row("ConfirmStates", "Done banner with its audit row and Undo", T.done),
  // LiveStates
  row("LiveStates", "Live, Reconnecting, Not live, Signed out", T.pill),
  row("LiveStates", "Reconnecting keeps the page, 2 s", T.unreachable),
  row("LiveStates", "Console not reachable", T.unreachable),
  row("LiveStates", "Not live, refused", T.pill),
  row("LiveStates", "Signed out, then sign-in says why", T.ended),
  // States the script switches that the LiveStates ledger files as readme rows: listed so the table is whole.
  row("LiveStates", "\"Newer data is waiting\"", T.held),
  row("LiveStates", "Older data dimmed under its time", T.stale),
  row("LiveStates", "The console stopping (shutdown)", T.shutdown),
  row("LiveStates", "One token may hold 4 live tabs, a run with its transcript counts as one; past that the tab stays still and says why", T.bothClosed),
  // SignIn
  row("SignIn", "\"Console not reachable, retrying\" keeps the page", T.signIn),
  row("SignIn", "One notice at a time above the field", T.signIn),
  // The retry's stop: the script's own notice, a copy of the server's unreachable one.
  row("SignIn", "The retry stops after 30 tries or 60 s, and asks for Sign in again", T.signInStops),
  // AccessStates: the link page's states are panels in its ledger (p-link-wait, -used, -nocode).
  row("AccessStates", "p-link-used", T.link),
  row("AccessStates", "p-link-nocode", T.link),
  row("AccessStates", "p-link-wait", T.link),
]);
