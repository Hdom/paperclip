import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fixture } from "./__tests__/management-test-fixture.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot=process.env.MANAGEMENT_PACKAGE_DIR;
const entry = packageRoot ? path.join(packageRoot,"entry.mjs") : path.join(root, "server/dist-management/entry.mjs"), ui = packageRoot ? path.join(packageRoot,"ui") : path.join(root, "ui/dist-management");
const f = fixture({issueCount:2000}); let child, browser; const findings = { projectedTasks:2000, cliStart: false, desktop: false, phone: false, restart: false, anonymousDenied: false, expiredDenied: false, unexpectedRequests: [], badResponses: [], pageErrors: [], consoleErrors: [] };
const freePort = async () => { const s = createServer(); await new Promise(ok => s.listen(0,"127.0.0.1",ok)); const port = s.address().port; await new Promise(ok => s.close(ok)); return port; };
async function start(port) {
  child = spawn(process.execPath, [entry, "--projection", f.projectionPath, "--auth", f.authPath, "--ui", ui, "--port", String(port)], { cwd: root, env: { PATH: process.env.PATH, HOME: f.root, PAPERCLIP_HOME: path.join(f.root,"must-not-exist"), PAPERCLIP_CONFIG: path.join(f.root,"must-not-exist/config.json"), DATABASE_URL: "postgresql://invalid.invalid/must-not-connect" }, stdio: ["ignore","pipe","pipe"] });
  let text = "", error = ""; child.stdout.on("data",b=>text+=b);child.stderr.on("data",b=>error+=b);
  await new Promise((ok,fail)=>{const timer=setTimeout(()=>fail(Error("management readiness timeout")),10000);child.on("exit",()=>{clearTimeout(timer);fail(Error("management child exited before readiness: "+error))});child.stdout.on("data",()=>{if(text.includes("management_ready_read_only")){clearTimeout(timer);ok()}})});
}
async function stop() { if (!child || child.exitCode !== null) return; const exited=once(child,"exit");child.kill("SIGTERM"); await exited; assert.equal(child.exitCode,0); child=undefined; }
try {
  const port = await freePort(), base = `http://127.0.0.1:${port}`; await start(port); findings.cliStart=true;
  browser = await chromium.launch({headless:true,env:{PATH:process.env.PATH,HOME:process.env.HOME}});
  const anonymous = await browser.newContext(); const denied = await anonymous.request.get(`${base}/TEST/issues`); assert.equal(denied.status(),401); await anonymous.close(); findings.anonymousDenied=true;
  for(const [name,viewport]of [["desktop",{width:1280,height:900}],["phone",{width:390,height:844}]]) {
    const context = await browser.newContext({viewport,extraHTTPHeaders:{Authorization:`Bearer ${f.token()}`}});const page=await context.newPage();
    page.on("request",r=>{if(!r.url().startsWith(base+"/")||!["GET","HEAD"].includes(r.method()))findings.unexpectedRequests.push(r.method()+" "+r.url())});
    page.on("response",r=>{if(r.status()>=400)findings.badResponses.push(r.status()+" "+new URL(r.url()).pathname)});page.on("pageerror",e=>findings.pageErrors.push(e.message));page.on("console",m=>{if(m.type()==="error")findings.consoleErrors.push(m.text())});
    await page.goto(`${base}/TEST/issues`);await page.getByRole("heading",{name:"Tasks",exact:true}).waitFor();await page.getByRole("button",{name:/TEST-1 · Retained research/}).waitFor();
    assert.equal(await page.locator("img").count(),0);assert.equal(await page.getByRole("button",{name:/retry|resume|recover|save|new task/i}).count(),0);
    await page.getByLabel("Search snapshot").fill("Coordinate");assert.equal(await page.getByRole("button",{name:/TEST-1 ·/}).count(),0);await page.getByLabel("Search snapshot").fill("");
    await page.getByRole("navigation",{name:"Company navigation"}).getByRole("button",{name:"Projects",exact:true}).click();await page.getByRole("button",{name:"Connector project",exact:true}).click();await page.getByRole("dialog").waitFor();await page.getByRole("dialog").getByRole("button",{name:"TEST-1",exact:true}).click();await page.getByRole("dialog").getByRole("heading",{name:/Retained research/}).waitFor();
    assert.equal(await page.evaluate(()=>Array.from(document.querySelectorAll('style')).every(s=>s.nonce===document.querySelector('meta[name="paperclip-style-nonce"]').content)),true);
    await page.getByRole("dialog").getByRole("button",{name:"stopped · held"}).click();await page.getByRole("dialog").getByRole("heading",{name:"Run status",exact:true}).waitFor();
    await page.keyboard.press("Escape");await page.getByRole("dialog").waitFor({state:"hidden"});assert.equal(new URL(page.url()).pathname,"/TEST/work");
    const firstNonce=await page.locator('meta[name="paperclip-style-nonce"]').getAttribute('content');
    await page.reload();await page.getByRole("heading",{name:"Work status",exact:true}).waitFor();await page.getByRole("heading",{name:"Agents",exact:true}).waitFor();
    assert.notEqual(await page.locator('meta[name="paperclip-style-nonce"]').getAttribute('content'),firstNonce);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
    assert.ok(await page.locator("time").innerText());assert.ok((await page.locator("main").innerText()).includes("Not live telemetry"));
    if(process.env.MANAGEMENT_SCREENSHOT_DIR)await page.screenshot({path:path.join(process.env.MANAGEMENT_SCREENSHOT_DIR,`management-${name}.png`),fullPage:true});
    findings[name]=true;await context.close();
  }
  const expired = await browser.newContext({extraHTTPHeaders:{Authorization:`Bearer ${f.token({iat:1,nbf:1,exp:2})}`}});assert.equal((await expired.request.get(`${base}/api/management/projection`)).status(),401);await expired.close();findings.expiredDenied=true;
  await stop();await start(port);const verification=await browser.newContext({extraHTTPHeaders:{Authorization:`Bearer ${f.token()}`}});assert.equal((await verification.request.get(`${base}/api/management/projection`)).status(),200);await verification.close();findings.restart=true;
  assert.equal(existsSync(path.join(f.root,"must-not-exist")),false);
  assert.deepEqual(findings.unexpectedRequests,[]);assert.deepEqual(findings.badResponses,[]);assert.deepEqual(findings.pageErrors,[]);assert.deepEqual(findings.consoleErrors,[]);
  console.log(JSON.stringify(findings));
} finally { await browser?.close();await stop(); f.cleanup(); }
