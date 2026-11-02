/** Loaded only after a same-origin authorization exchange; never an asset of the operator console. */
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { mountGateway as mount } from "./browser.mjs";

export const mountGateway = (options) => mount({ ...options, Terminal, FitAddon });
