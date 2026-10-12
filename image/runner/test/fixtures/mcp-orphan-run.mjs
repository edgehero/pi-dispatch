// Runs one job's MCP lifecycle against the stub in "orphan" mode and returns, so its test can measure whether the
// process then exits: the orphan holds the stub's stdout for a minute, and only the runner's own stop releases it.
// argv: <workspace dir> <orphan pid file>.
import { join } from "node:path";
import * as pi from "@earendil-works/pi-coding-agent";
import { buildLoadedResourceLoader } from "../../src/loader.mjs";
import { createJobMcp } from "../../src/mcp.mjs";
import { createJobModelRuntime } from "../../src/model-runtime.mjs";

const [root, orphan] = process.argv.slice(2);
const stub = new URL("./mcp-stub-server.mjs", import.meta.url).pathname;
const doc = { version: 1, codemodeModels: false, servers: { files: { type: "stdio", command: process.execPath, args: [stub], env: { MCP_STUB_MODE: "orphan", MCP_STUB_ORPHAN: orphan }, description: "Files" } }, refs: { files: [] } };
const jobMcp = createJobMcp(doc, { pi, env: { PI_MCP_SERVERS: "files", PATH: process.env.PATH }, cwd: join(root, "workspace") });
const loader = await buildLoadedResourceLoader({ cwd: join(root, "workspace"), jobPiDir: join(root, "job", "pi"), guardrailsPath: join(root, "HARD_RULES.md"), outboxProtocolPath: join(root, "OUTBOX_PROTOCOL.md"), extensionFactories: jobMcp.factories });
const modelRuntime = await createJobModelRuntime({ ModelRuntime: pi.ModelRuntime, agentDir: join(root, "agent"), modelsPath: join(root, "agent", "models.json") });
const { session } = await pi.createAgentSession({ cwd: join(root, "workspace"), agentDir: join(root, "agent"), modelRuntime, settingsManager: pi.SettingsManager.inMemory({}), resourceLoader: loader });
await jobMcp.lifecycle.start(session.extensionRunner.createContext());
await jobMcp.lifecycle.stop();
session.dispose();
process.stdout.write("stopped\n");
