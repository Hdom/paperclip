// Actual React component, API client, account-session hook, Radix components
// and production CSS. Only router context and HTTP responses are synthetic.
// Loopback-only fixture: never starts Paperclip or loads operator credentials.
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../..");
const ui=path.join(repo,"ui"),require=createRequire(path.join(ui,"package.json"));
const {createServer}=await import(pathToFileURL(require.resolve("vite")).href);
const react=(await import(pathToFileURL(require.resolve("@vitejs/plugin-react")).href)).default;
const tailwind=(await import(pathToFileURL(require.resolve("@tailwindcss/vite")).href)).default;
const {chromium}=createRequire(path.join(repo,"package.json"))("@playwright/test");
const output=path.resolve(process.argv[2]??path.join(repo,"tmp/maintenance-ui-evidence"));
const fixture=await mkdtemp(path.join(ui,".maintenance-qualification-"));
let server,browser;
try {
  await mkdir(output,{recursive:true});
  await writeFile(path.join(fixture,"index.html"),'<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="./entry.tsx"></script></body></html>');
  await writeFile(path.join(fixture,"router.tsx"),'export const Link=({to,children,...props})=><a href={to} {...props}>{children}</a>;');
  await writeFile(path.join(fixture,"entry.tsx"),`import React from 'react';import {createRoot} from 'react-dom/client';import {QueryClient,QueryClientProvider} from '@tanstack/react-query';import {InstanceMaintenance} from '../src/components/InstanceMaintenance';import '../src/index.css';const client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});createRoot(document.getElementById('root')!).render(<QueryClientProvider client={client}><main className="mx-auto max-w-3xl p-4 sm:p-6"><InstanceMaintenance task={new URLSearchParams(location.search).has('task')}/></main></QueryClientProvider>);`);
  server=await createServer({configFile:false,root:ui,plugins:[react(),tailwind()],resolve:{alias:[{find:"@/lib/router",replacement:path.join(fixture,"router.tsx")},{find:"@",replacement:path.join(ui,"src")}]},server:{host:"127.0.0.1",port:0,strictPort:true},optimizeDeps:{entries:[path.join(fixture,"entry.tsx")],include:["react","react-dom/client","react/jsx-runtime","@tanstack/react-query"]}});
  await server.listen();
  const address=server.httpServer.address();assert(address&&typeof address!=="string");
  const origin=`http://127.0.0.1:${address.port}`;
  browser=await chromium.launch({headless:true});
  const page=await browser.newPage();const errors=[],external=[],posts=[];let checks=0;
  page.on("pageerror",error=>{errors.push(error.message);console.error("Fixture page error:",error.message);});
  page.on("console",message=>{if(message.type()==="error")console.error("Fixture console:",message.text());});
  const id="00000000-0000-4000-8000-000000000001";
  let scenario="held";
  const state=()=>({state:scenario==="normal"?"released":scenario==="acquiring"?"acquiring":"held",generation:8,canManage:scenario!=="nonadmin",message:"Maintenance temporarily holds new agent work.",checkedAt:new Date().toISOString(),...(scenario!=="nonadmin"?{admin:{ownerId:id,operatorNote:"Synthetic private operator note",actorId:"fixture-operator",startedAt:new Date().toISOString(),blockers:{operations:scenario==="recovering"?1:0,runs:0,leases:0,finalizations:0,workspaces:0},activeRecoveries:scenario==="recovering"?1:0,releaseReview:{fingerprint:"a".repeat(64),savedIntentCount:1,blockedReason:scenario==="blocked"?"A separately approved project-workflow readiness decision is required.":null},savedWork:[{companyId:id,issueId:id,requestId:id,status:"deferred_issue_execution",identifier:"TEST-31",recovery:{actionId:id,runId:id}}]}}:{})});
  await page.route("**/*",async route=>{
    const request=route.request(),url=new URL(request.url());
    if(url.origin!==origin){external.push(request.url());return route.abort();}
    if(url.pathname==="/api/auth/get-session")return route.fulfill({json:{session:{id:"synthetic-session",userId:"fixture-operator"},user:{id:"fixture-operator",email:"operator@example.test",name:"Fixture operator",image:null},sentryDsn:null}});
    if(url.pathname.startsWith("/api/instance/maintenance")){
      if(request.method()!=="GET"){posts.push({path:url.pathname,body:request.postDataJSON()});return route.fulfill({json:{accepted:true}});}
      if(scenario==="disconnected")return route.fulfill({status:503,json:{error:"Synthetic offline fixture"}});
      const value=state();if(url.searchParams.get("view")==="task")delete value.admin;
      return route.fulfill({json:value});
    }
    if(url.pathname.startsWith("/api/"))throw Error("Unexpected fixture API request "+url.pathname);
    return route.continue();
  });
  const open=async(name,task=false)=>{scenario=name;await page.goto(`${origin}/${path.basename(fixture)}/index.html${task?"?task":""}`);await page.getByRole("heading",{name:/Maintenance/}).waitFor();await page.getByText("Loading maintenance status.",{exact:true}).waitFor({state:"hidden"});};
  for(const width of [1280,390,320]){
    await page.setViewportSize({width,height:900});
    for(const name of ["held","normal","acquiring","recovering","blocked","nonadmin","disconnected"]){
      await open(name);
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`${name} overflow at ${width}`);checks++;
      if(name==="nonadmin"){assert(!(await page.textContent("body")).includes("Synthetic private operator note"));checks++;}
      if(name==="held"||name==="blocked"){
        await page.getByRole("button",{name:"Review resumption",exact:true}).click();
        const dialog=page.getByRole("dialog");await dialog.waitFor();
        assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`dialog overflow at ${width}`);checks++;
        if(name==="blocked"){assert(await page.getByRole("button",{name:"Resumption unavailable"}).isDisabled());checks++;}
      }
    }
    await open("held");await page.screenshot({path:path.join(output,`maintenance-component-${width}.png`),fullPage:true});
  }
  await open("held",true);assert(!(await page.textContent("body")).includes("Synthetic private operator note"));assert(await page.getByRole("button").count()===0);checks+=2;
  await open("held");await page.getByRole("button",{name:"View saved work"}).click();await page.getByRole("button",{name:"Review recovery request"}).click();await page.getByRole("button",{name:"Recover exact source",exact:true}).click();
  await page.waitForFunction(()=>!document.querySelector('[role="dialog"]'));
  assert.deepEqual(posts.at(-1).body,{requestId:posts.at(-1).body.requestId,generation:8,ownerId:id,companyId:id,issueId:id,actionId:id,runId:id});checks++;
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);checks+=2;
  await writeFile(path.join(output,"report.json"),JSON.stringify({passed:true,checks,widths:[1280,390,320],scope:"actual maintenance component/CSS and session hook; synthetic HTTP and router context; no full-app or production acceptance",errors,external},null,2));
  console.log(JSON.stringify({passed:true,checks,output}));
} finally {
  await browser?.close();await server?.close();
  if(path.dirname(fixture)!==ui||!path.basename(fixture).startsWith(".maintenance-qualification-"))throw Error("Unexpected fixture path; refusing removal");
  await rm(fixture,{recursive:true,force:true});
}
