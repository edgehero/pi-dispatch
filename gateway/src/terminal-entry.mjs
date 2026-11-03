/** Loaded after fragment scrubbing; all terminal/layout assets remain on the gateway origin. */
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { createDockview } from "dockview";
import { mountGateway as mount } from "./browser.mjs";
import { mountWorkbench as mountWorkspace } from "./workbench.mjs";
import { startWorkbenchLaunch as start } from "./workbench-rendezvous.mjs";
export const mountGateway = options => mount({ ...options, Terminal, FitAddon });
export const mountWorkbench = options => mountWorkspace({ ...options, createDockview, mountTerminal: mountGateway });
export const startWorkbenchLaunch = options => start({ ...options, mountWorkbench: extra => mountWorkbench({ window: options.window, document: options.document, ...extra }) });
