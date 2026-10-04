---
name: portfolio-fixture
description: The zero-judgement test of the portfolio flow. Copies a fixed plan to the outbox and reports it.
---

# Portfolio fixture

A test flow. It makes no judgement: it sends the fixed plan in `/workspace/plan.fixture.json`, so you can see
the whole path (snapshot in, plan out, the host's decision, the report) on the cheapest model you have.

Use the bash tool once, with exactly this command. With no snapshot it copies nothing and the report says so.

```sh
cat /job/portfolio.json && cp /workspace/plan.fixture.json /outbox/priorities.json; node /job/pi/skills/portfolio-manager/report.mjs
```

Then reply with one line saying you are done. Do not edit, create or commit any file in `/workspace`.
