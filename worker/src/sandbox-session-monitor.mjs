// Kept separate so importing the watcher library never starts an IPC wait in a bundled admin entry (#771).
import { monitorMain } from "./sandbox-session-watch.mjs";

await monitorMain();
