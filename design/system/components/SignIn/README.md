Sign-in is a single centered card: type the sign-in code from your terminal, or paste a console token, with help that says exactly where both come from.

**How a person uses it.**
- **The sign-in code.** A person types the 8 characters `pi-dispatch-console link` printed, such as `K7QX-9M2D`, and presses *Sign in*. Capitals or not, with the dash or without, and an O for a zero or an I or L for a one all work. A code works once, for 5 minutes, and the browser it signs in is remembered.
- **The token.** Below a rule marked *or*, a person can paste a console token instead and press *Sign in with the token*.
- **Remember this trusted device.** A box under the token field, ticked to start with, keeps this browser signed in across idle time and restarts until it signs out. Untick it on a browser that is not yours alone. It is drawn only where the console would remember the browser: never on a Windows host, and never over plain HTTP across a network.
- **Another browser or device.** A disclosure under the help gives `./node_modules/.bin/pi-dispatch-console link`, which prints a link to paste and a code to type rather than opening the default browser.
- **No code yet.** The help block leads with the one command to remember, `./pi-dispatch console` in the deployment folder, which signs you in. It gives the spelling for a folder without that shortcut and `/dispatch console --link` in pi, each with a copy button. Making a token, `pi-dispatch-console token add --name <you> --role operator` on the host, sits in a disclosure below them.
- **Arriving from elsewhere.** A person who opens a console page from another site and is signed in goes straight to that page. A person who is not signed in returns to that page after signing in with a code or a token.
- **Notices.** One notice at a time sits above the code field, each saying what happened and what to do.
  - Why a session ended: 60 minutes idle (an open live tab does not count), the 12-hour maximum, a revoked or rotated token, a changed role, an operator ending every session, signing out in another tab, a console restart, or a remembered device being removed. A remembered sign-in that could not be checked or erased says so.
  - Why a sign-in was refused: a wrong token, a code that did not work, a used or expired link, too many attempts (5 a minute), a tokens file the console cannot use, or an audit log it cannot write.
  - "Console not reachable, retrying" keeps the page instead of going to the browser's error page.
- **Where it answers.** The footer says the console answers at localhost, on this host only.

**Panels.** `p-signin`.

**The server provides.** The notice as a closed reason, never echoed input: `ended=idle|max|revoked|role|all|elsewhere|restart|device|device-store|device-kept`, or the refusal (401 wrong token, 401 code that did not work, 401 link used or expired, 429 too many attempts, 503 tokens file, 500 audit log). Today the repo's login page says nothing about why a session ended; the `ended` reason is the change this design asks for.

**Fixture note.** The code `K7QX-9M2D` in the field, the token placeholder `pdc_…` and the 5-second retry interval are sample values.
