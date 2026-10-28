import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import { createDockerRunner } from "./tls-acceptance/run.mjs";

const runner = String.raw`
import assert from 'node:assert/strict';
import { createServer, connect } from 'node:net';
import { chromium } from 'playwright';
import { avatarBrowserCase, avatarPeerBrowserCase } from './browser.mjs';
const chunks=[]; for await(const chunk of process.stdin) chunks.push(chunk);
const fixture=JSON.parse(Buffer.concat(chunks).toString('utf8'));
const result={status:'failed',browserCases:[],foreignRequests:[],pageErrors:[],routeFailures:[],cleanup:[]};
const sockets=new Set(); let browser;
const tunnel=createServer(socket=>{
  const upstream=connect({host:fixture.caddyAddress,port:80});
  for(const peer of [socket,upstream]){sockets.add(peer);peer.on('close',()=>sockets.delete(peer));peer.on('error',()=>{socket.destroy();upstream.destroy();});}
  socket.pipe(upstream).pipe(socket);
});
const timer=setTimeout(()=>{for(const socket of sockets)socket.destroy();void browser?.close().catch(()=>undefined);},150000);
try{
  assert.equal(process.platform,'linux');
  await new Promise((resolve,reject)=>{tunnel.once('error',reject);tunnel.listen(3080,'127.0.0.1',resolve);});
  browser=await chromium.launch({headless:true,chromiumSandbox:true,handleSIGINT:false,handleSIGTERM:false,handleSIGHUP:false,
    args:['--disable-dev-shm-usage','--disable-background-networking','--disable-component-update','--disable-domain-reliability','--no-pings','--no-proxy-server']});
  result.browserVersion=browser.version();result.browserPlatform=process.platform;result.chromiumSandbox=true;
  const check=fixture.mode==='peer'?avatarPeerBrowserCase:avatarBrowserCase;
  for(const entry of fixture.cases)result.browserCases.push(await check(browser,{...fixture,entry,report:result}));
  result.status='complete';
}catch(error){
  result.errorKind=['Error','TimeoutError','AssertionError','TypeError'].includes(error.name)?error.name:'unknown';
}finally{
  if(browser){try{await browser.close();result.cleanup.push({step:'close-linux-browser',status:'complete'});}catch{result.cleanup.push({step:'close-linux-browser',status:'failed'});}}
  for(const socket of sockets)socket.destroy();
  await new Promise(resolve=>tunnel.close(()=>resolve()));
  clearTimeout(timer);
}
process.stdout.write('AVATAR_RESULT '+JSON.stringify(result)+'\n');
`;

/** Use the exact tested worker's sandboxed Chromium without Windows HTTP injection. */
export async function linuxAvatarCases({ projectBinding, storageState, boardId, ownerId, origin, cases, signal, cleanup,
  mode = "self", guestStorageState, guestId, guestName }) {
  const project = projectBinding.project;
  assert.match(project, /^[a-z0-9][a-z0-9_-]{0,62}$/);
  const network = `${project}_backend`;
  const runId = randomUUID();
  const name = `rimo-avatar-proof-${runId}`;
  const image = projectBinding.worker.imageId;
  assert.match(image, /^sha256:[a-f0-9]{64}$/);
  assert.ok(mode === "self" || mode === "peer");
  const docker = createDockerRunner({ ...process.env }, signal, () => undefined);
  let containerId;
  try {
    const networkInfo = JSON.parse(await docker(["network", "inspect", "--format",
      '{"id":{{json .Id}},"internal":{{.Internal}},"project":{{json (index .Labels "com.docker.compose.project")}}}', network]));
    assert.equal(networkInfo.project, project);
    assert.equal(networkInfo.internal, true);
    const caddyAddress = (await docker(["inspect", "--format", `{{(index .NetworkSettings.Networks "${network}").IPAddress}}`, projectBinding.caddy.id])).trim();
    assert.equal(net.isIP(caddyAddress), 4);
    containerId = (await docker(["create", "--name", name, "--label", `rimo.avatar-proof.run=${runId}`,
      "--network", network, "--read-only", "--tmpfs", "/tmp:size=201326592,mode=1777", "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges:true", "--security-opt", `seccomp=${path.resolve("config/chromium-seccomp.json")}`,
      "--memory", "768m", "--shm-size", "128m", "--pids-limit", "256", "--no-healthcheck", "--entrypoint", "node",
      image, "-e", "setTimeout(()=>process.exit(124),240000)"])).trim();
    assert.match(containerId, /^[a-f0-9]{64}$/);
    const user = (await docker(["inspect", "--format", "{{.Config.User}}", containerId])).trim();
    assert.equal(user, "pwuser");
    await docker(["start", containerId]);
    const install = String.raw`(async()=>{const fs=require('node:fs/promises');const chunks=[];for await(const part of process.stdin)chunks.push(part);const files=JSON.parse(Buffer.concat(chunks).toString('utf8'));const root='/tmp/avatar-network';await fs.mkdir(root);await fs.symlink('/app/node_modules',root+'/node_modules','dir');for(const name of ['browser.mjs','runner.mjs'])await fs.writeFile(root+'/'+name,files[name],{flag:'wx',mode:0o600});})().catch(()=>{process.exitCode=1;});`;
    await docker(["exec", "-i", containerId, "node", "-e", install], { input: Buffer.from(JSON.stringify({
      "browser.mjs": await readFile(new URL("./avatar-network-browser.mjs", import.meta.url), "utf8"), "runner.mjs": runner,
    })) });
    const output = await docker(["exec", "-i", containerId, "node", "/tmp/avatar-network/runner.mjs"], {
      timeout: 165_000, input: Buffer.from(JSON.stringify({ caddyAddress, storageState, boardId, ownerId, origin, cases,
        mode, guestStorageState, guestId, guestName })),
    });
    const line = output.trim().split(/\r?\n/).findLast((entry) => entry.startsWith("AVATAR_RESULT "));
    assert.ok(line, "AVATAR_SAFE_RESULT_MISSING");
    const result = JSON.parse(line.slice("AVATAR_RESULT ".length));
    return { ...result, container: { imageId: image, user, readOnly: true, chromiumSandbox: true, internalNetwork: true,
      publishedPorts: false, networkId: networkInfo.id, connection: "container loopback3080 TCP tunnel to selected Caddy:80; original browser origin and WebSocket URL retained" } };
  } finally {
    try {
      // Inventory must succeed before absence is accepted; never remove a foreign container by name.
      const listed = (await docker(["ps", "--all", "--quiet", "--no-trunc", "--filter", `name=^/${name}$`], { cleanup: true })).trim();
      if (listed) {
        assert.match(listed, /^[a-f0-9]{64}$/);
        const identity = JSON.parse(await docker(["inspect", "--format",
          '{"name":{{json .Name}},"run":{{json (index .Config.Labels "rimo.avatar-proof.run")}},"image":{{json .Image}}}', listed], { cleanup: true }));
        assert.equal(identity.name, `/${name}`);
        assert.equal(identity.run, runId);
        assert.equal(identity.image, image);
        if (containerId) assert.equal(listed, containerId);
        await docker(["rm", "--force", listed], { cleanup: true });
        assert.equal((await docker(["ps", "--all", "--quiet", "--filter", `label=rimo.avatar-proof.run=${runId}`], { cleanup: true })).trim(), "");
      }
      cleanup.push({ step: "remove-owned-linux-browser-container", status: "complete" });
    } catch { cleanup.push({ step: "remove-owned-linux-browser-container", status: "failed" }); }
  }
}
