# Issue #774, final review images

Implementation: `57e2587eb47a0e1e506ef06e2ef80bd7a7b79804`, PR #784.

The setup baseline is main `2e5f2fd1`; provider-management baseline is prior PR commit `a285e870`.
After captures use the actual console server and production CSP with pinned Chrome 155.0.8059.39.
The final browser run passed 108 role/theme/width checks, six Starting checks and additional
configured/expanded-guide checks. Phone 375, intermediate 1024 and desktop 1440 captures include
both themes and applicable viewer, agent and read-only states.

References are the repository's published-source SetupScreen and ConnectionsScreen. The remote
Claude artifact was inaccessible, so these images do not claim direct remote comparison. All 18
reference captures verified both `tokens.css` and `bundle.css`, computed theme tokens, font readiness
and actual native platform fonts. Source-card preview bytes remained unchanged through the final
documentation rebuild, and root refreshed the references again.

The sample reference and actual deployment hold different provider/connection observations. Review
compares shared colours, hierarchy, labels, statuses, controls and complete sections. Expanded API-key
and host subscription guides show the acquisition workflow. Expanded special guides distinguish
pinned pi capabilities from the worker's existing Bedrock, legacy Codex and Vertex ADC limits. They
do not imply that every authentication mode works. Agent withholding is intentionally neutral; no
mutation controls appear for agents, viewers or read-only sessions. Actual configured keys are
Anthropic, OpenRouter and DeepSeek; saved values never appear.

All 28 curated PNGs are listed in `sha256.json`. Private invitation captures, temporary scripts,
build output and credentials are excluded. These files live outside the implementation branch.
