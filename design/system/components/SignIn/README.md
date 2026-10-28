Sign-in is a single centered card: paste a console token or open a one-time link from pi, with help that says exactly where both come from.

**How a person uses it.**
- **The token.** A person pastes the token and presses *Sign in*.
- **No token yet.** The help block gives the two commands with a copy button each: `/dispatch console` in pi, which prints the address and a link that works once for 60 seconds, and `pi-dispatch-console token add --name <you> --role operator` on the host.
- **Notices.** One notice at a time sits above the token field, each saying what happened and what to do.
  - Why a session ended: 60 minutes idle (an open live tab does not count), the 12-hour maximum, a revoked or rotated token, a changed role, an operator ending every session, signing out in another tab, or a console restart.
  - Why a sign-in was refused: a wrong token, a used or expired link, too many attempts (5 a minute), a tokens file the console cannot use, or an audit log it cannot write.
  - "Console not reachable, retrying" keeps the page instead of going to the browser's error page.
- **Where it answers.** The footer says the console answers on 127.0.0.1 only.

**Panels.** `p-signin`.

**The server provides.** The notice as a closed reason, never echoed input: `ended=idle|max|revoked|role|all|elsewhere|restart`, or the refusal (401 wrong token, 401 link used or expired, 429 too many attempts, 503 tokens file, 500 audit log). Today the repo's login page says nothing about why a session ended; the `ended` reason is the change this design asks for.

**Fixture note.** The token placeholder `pdc_…` and the 5-second retry interval are sample values.
