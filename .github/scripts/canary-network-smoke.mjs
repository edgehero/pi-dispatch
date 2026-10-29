// Zero provider calls: CONNECT opens a TLS tunnel but sends no API request and needs no key.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { CANARY_PROXY_IMAGE, canaryProxyPolicy } from "../../worker/src/canary-runtime.mjs";
import { buildDockerRunArgs } from "../../worker/src/docker-run.mjs";

const exec = promisify(execFile);
const image = process.argv[2];
assert.ok(image, "usage: node .github/scripts/canary-network-smoke.mjs <job-image>");
const root = mkdtempSync(join(tmpdir(), "pi-canary-smoke-"));
const name = `pi-dispatch-canary-smoke-${randomUUID().slice(0, 12)}`;
const proxy = `${name}-proxy`, outer = `${name}-out`, inner = `${name}-in`;
const docker = (args) => exec("docker", args, { timeout: 60_000, maxBuffer: 2 * 1024 * 1024 });
const probe = `
const assert = require('node:assert/strict');
const net = require('node:net');
const {spawnSync} = require('node:child_process');
const proxy = process.env.PROBE_PROXY;
function connect(target, method='CONNECT') { return new Promise((resolve,reject)=>{
 const socket = net.connect({host:proxy,port:3128}); let text='';
 socket.setTimeout(5000,()=>socket.destroy(new Error('timeout')));
 socket.on('connect',()=>socket.write(method+' '+target+' HTTP/1.1\\r\\nHost: '+target+'\\r\\n\\r\\n'));
 socket.on('data',chunk=>{text+=chunk; if(text.includes('\\r\\n')) {socket.destroy();resolve(Number(text.split(' ')[1]));}});
 socket.on('error',reject);
 });}
(async()=>{
 let status, lastError; for(let n=0;n<20;n++) {try {status=await connect('api.anthropic.com:443');if(status===200)break;}catch(error){lastError=error.message;} await new Promise(r=>setTimeout(r,500));}
 assert.equal(status,200,'the declared provider tunnel works without making an API request: '+lastError);
 for(const host of ['github.com','api.github.com','gitlab.com','dev.azure.com']) assert.equal(await connect(host+':443'),403,host+' is blocked');
 assert.equal(await connect('api.anthropic.com:80'),403,'provider cleartext port blocked');
 assert.equal(await connect('https://api.anthropic.com/','GET'),403,'forward requests blocked');
 assert.equal(await connect('127.0.0.1:443'),403,'host services blocked');
 await new Promise((resolve,reject)=>{const socket=net.connect({host:'1.1.1.1',port:443});socket.setTimeout(1500,()=>{socket.destroy();resolve();});socket.on('connect',()=>{socket.destroy();reject(new Error('direct internet escaped'));});socket.on('error',resolve);});
 const childCode = 'const net=require("node:net"); const proxy=process.env.PROBE_PROXY; ('+connect.toString()+')("github.com:443").then(code=>{console.log(code);process.exitCode=code===403?0:1;}).catch(()=>process.exitCode=1);';
 const child = spawnSync('bash',['-c','exec node --eval "$CANARY_CHILD_PROBE"'],{encoding:'utf8',env:{...process.env,CANARY_CHILD_PROBE:childCode}});
 assert.equal(child.status,0,'shell child must see the proxy refusal');assert.match(child.stdout,/403/);
 for(const key of ['GITHUB_TOKEN','GH_TOKEN','GITLAB_TOKEN','GL_TOKEN','AZURE_DEVOPS_EXT_PAT']) assert.equal(process.env[key],undefined);
 console.log('OK: provider tunnel admitted, forge and direct routes blocked for parent and shell child, no forge credentials');
})().catch(error=>{console.error(error);process.exitCode=1;});
`;
let failed = false;
try {
	writeFileSync(join(root, "squid.conf"), canaryProxyPolicy("anthropic"), { mode: 0o644 });
	mkdirSync(join(root, "job")); mkdirSync(join(root, "workspace"));
	await docker(["network", "create", outer]);
	await docker(["network", "create", "--internal", inner]);
	await docker(["run", "--pull=never", "--rm", "-d", "--name", proxy, "--network", outer, "--user", "proxy", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--entrypoint", "/usr/sbin/squid", "--mount", `type=bind,source=${join(root, "squid.conf")},target=/etc/squid/squid.conf,readonly`, CANARY_PROXY_IMAGE, "-f", "/etc/squid/squid.conf", "-NYC"]);
	await docker(["network", "connect", inner, proxy]);
	const args = buildDockerRunArgs({ image, name, network: inner, jobDir: join(root, "job"), workspace: join(root, "workspace"), env: { PROBE_PROXY: proxy }, extraFlags: ["--entrypoint", "node"] });
	assert.ok(args.includes("--entrypoint") && args[args.indexOf("--entrypoint") + 1] === "node");
	const result = await docker([...args, "--eval", probe]);
	process.stdout.write(result.stdout);
} catch (error) { failed = true; process.stderr.write(`${error.stderr ?? error.message}\n`); const logs = await docker(["logs", proxy]).catch(() => null); if (logs) process.stderr.write(`${logs.stdout}${logs.stderr}`); }
finally {
	for (const container of [name, proxy]) await docker(["rm", "-f", container]).catch(() => {});
	for (const network of [inner, outer]) await docker(["network", "rm", network]).catch(() => { failed = true; process.stderr.write(`cleanup failed: ${network}\n`); });
	rmSync(root, { recursive: true, force: true });
}
if (failed) process.exitCode = 1;
