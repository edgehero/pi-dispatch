// L0: the daemon facts the CPU-reserve change leans on, measured on a real dockerd.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IMAGE, sh, write } from "../lib.mjs";

const facts = {};
const info = await sh("docker", ["info", "--format", "{{json .}}"]);
const parsed = JSON.parse(info.stdout);
facts.daemon = { serverVersion: parsed.ServerVersion, driver: parsed.Driver, cgroupDriver: parsed.CgroupDriver, cgroupVersion: parsed.CgroupVersion, driverStatus: parsed.DriverStatus };

// `rm -f` of a name that does not exist.
const missing = await sh("docker", ["rm", "-f", "pi-lab-missing"]);
facts.rmForceMissing = { code: missing.code, stdout: missing.stdout.trim(), stderr: missing.stderr.trim() };

// A create under a name already taken.
await sh("docker", ["create", "--name", "pi-lab-taken", IMAGE, "true"]);
const taken = await sh("docker", ["run", "--rm", "--name", "pi-lab-taken", IMAGE, "true"]);
facts.runNameTaken = { code: taken.code, stderr: taken.stderr.trim() };

// `{{.Label "k"}}` for a container without and with the label; `{{.Command}}` with --no-trunc.
await sh("docker", ["create", "--name", "pi-lab-labelled", "--label", "pi.dispatch.helper=cpu-reserve", "--entrypoint", "cat", IMAGE, "/p/cpu.max"]);
const listed = await sh("docker", ["ps", "-a", "--no-trunc", "--filter", "name=^pi-lab-", "--format", '{{.Names}}\t{{.Label "pi.dispatch.helper"}}\t{{.Command}}']);
facts.labelFormat = listed.stdout.trim().split("\n");

// `docker rm a b` with b missing: exit code, and which ids are printed.
const a = (await sh("docker", ["create", IMAGE, "true"])).stdout.trim();
const rmPair = await sh("docker", ["rm", a, "0000000000000000000000000000000000000000000000000000000000000000"]);
facts.rmOneMissing = { code: rmPair.code, stdout: rmPair.stdout.trim().split("\n"), printedFullId: rmPair.stdout.includes(a), stderr: rmPair.stderr.trim() };

// A container inherits its image's labels into .Config.Labels.
const dir = mkdtempSync(join(tmpdir(), "lab-img-"));
writeFileSync(join(dir, "Dockerfile"), `FROM ${IMAGE}\nLABEL org.opencontainers.image.title=lab dev.pi-dispatch.lab=1\n`);
const built = await sh("docker", ["build", "-q", "-t", "lab-labelled:1", dir], { timeoutMs: 120_000 });
facts.labelledImage = { code: built.code, id: built.stdout.trim() };
const c = (await sh("docker", ["create", "--label", "own=1", "lab-labelled:1", "true"])).stdout.trim();
const labels = await sh("docker", ["container", "inspect", "--format", "{{json .Config.Labels}}", c]);
const imageLabels = await sh("docker", ["image", "inspect", "--format", "{{json .Config.Labels}}", "lab-labelled:1"]);
facts.inheritedLabels = { container: JSON.parse(labels.stdout), image: JSON.parse(imageLabels.stdout) };
const alpineLabels = await sh("docker", ["image", "inspect", "--format", "{{json .Config.Labels}}", IMAGE]);
facts.alpineLabels = alpineLabels.stdout.trim();

await sh("docker", ["rm", "-f", "pi-lab-taken", "pi-lab-labelled", c]);

write("l0-facts", {
	summary: {
		version: facts.daemon.serverVersion,
		cgroupDriver: facts.daemon.cgroupDriver,
		rmForceMissingCode: facts.rmForceMissing.code,
		nameTakenCode: facts.runNameTaken.code,
		rmOneMissingCode: facts.rmOneMissing.code,
		rmPrintsFullId: facts.rmOneMissing.printedFullId,
		inherits: facts.inheritedLabels.container?.["dev.pi-dispatch.lab"] === "1",
	},
	facts,
});
