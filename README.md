# Issue #774, final review images

Implementation: `06d3c44f441a11a572794afd56082d41a9b1cc59`, PR #784.

The setup baseline is main `2e5f2fd1`; the provider-management baseline is the prior PR commit `a285e870`.
After captures use the actual console server and production CSP with pinned Chrome155.0.8059.39. The final browser
run passed108 role/theme/width checks, six Starting checks and additional configured/expanded-guide captures.
Phone375, intermediate1024 and desktop1440 captures include both themes and applicable viewer/agent/read-only states.

References are the repository's published-source SetupScreen and ConnectionsScreen. The remote Claude artifact was
inaccessible, so these images do not claim direct remote comparison. All18 reference captures verified both
`tokens.css` and `bundle.css`, computed theme tokens, font readiness and actual native platform fonts. Source-card
preview bytes remained unchanged through the final documentation rebuild, and root refreshed the references again.

The sample reference and actual deployment hold different provider/connection observations. Review compares shared
colours, hierarchy, labels, statuses, controls and complete sections. Expanded API-key and host subscription guides
show the acquisition workflow. Agent withholding is intentionally neutral; no mutation controls appear for agents,
viewers or read-only sessions. Actual configured keys are Anthropic, OpenRouter and DeepSeek; saved values never appear.

All26 curated PNGs are listed in `sha256.json`. Private invitation captures, temporary scripts, build output and
credentials are excluded. These files live on the evidence branch, outside the implementation branch.
