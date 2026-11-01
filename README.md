# Browser setup evidence for #774

Baseline: `2e5f2fd135ad05a2c2716cfa4882f1c094b5dc6a`, actual authenticated overview before the setup route existed.

References: repository published-source SetupScreen, loaded through the design harness with tokens.css and bundle.css. Computed tokens, stylesheet rules, document.fonts and CDP platform fonts were verified before capture. The remote Claude artifact was inaccessible; no direct remote comparison is claimed.

Implementation: actual console HTTP/session/action/SSE server under its production CSP. Pinned Chrome for Testing 155.0.8059.39, native system fonts, both themes, phone/intermediate/desktop sizes. Starting captures require the worker Starting chip, blue fourth segment, waiting-heartbeat state and absence of idle Start controls. No private invitation code is published.

Curated review images only. Temporary harnesses, full capture matrices and build output remain outside implementation and evidence branches. The implementation PR records the final source commit and verification.
