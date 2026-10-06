import { superviseRunner } from "./src/supervise.mjs";

// The image's entrypoint runs this file (issue #596, image/entrypoint.sh); the logic and its seams are in
// src/supervise.mjs, which the tests import. No main-module guard, on purpose: one that read false (a path spelled
// another way than it expected) made node exit 0 with no output, and the worker records that as a completed run.
superviseRunner();
