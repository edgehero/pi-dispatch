/**
 * The security headers every console response carries (issue #640, REQ-CONSOLE-SECURITY clause e).
 *
 * ONE function, applied by the dispatcher as its first statement, before the Host check: a 404, a 405, a 413, a 421
 * and an internal error carry the same set as the signed-in page. A header set applied per handler is a header set the
 * next handler forgets, and an error page without `frame-ancestors` is still a page an attacker can frame.
 *
 * NEVER an `Access-Control-*` header, on any response. The console's write protection leans on the browser's CORS
 * preflight: a cross-origin page cannot send `application/json` without one, and a preflight this server never answers
 * with an allow is a preflight that fails. One `Access-Control-Allow-Origin` anywhere would hand that away, which is
 * why the header test asserts the absence of the whole family, not of one name.
 *
 * The CSP forbids inline script outright (`script-src 'self'`, no nonce, no hash): the console's one script is served
 * from `/static/console.js`, so an escaping slip in a page renders as inert text instead of running. `style-src
 * 'self'` with no stylesheet served yet means the skeleton is unstyled, which #641 changes by adding a static route,
 * not by loosening this line.
 */

export const SECURITY_HEADERS = Object.freeze({
  "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "cache-control": "no-store",
  // Deny-all for the features a console never needs; a compromised page then cannot ask for any of them either.
  "permissions-policy": "accelerometer=(), camera=(), clipboard-read=(), display-capture=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), midi=(), payment=(), usb=()",
  // Older engines that predate `frame-ancestors`; harmless beside it.
  "x-frame-options": "DENY",
});

/** Set every header in `SECURITY_HEADERS` on `res`. Called before anything else decides the response. */
export function applySecurityHeaders(res) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
}
