#!/usr/bin/env node
// Local review only: real workerd and an in-memory published fixture; no deployed origin or live account.
import { startLocalAuthStub } from '../tests/helpers/local-auth-stub.mjs';
import { startPublishedWorker } from '../tests/helpers/published-worker.mjs';
import { startServedAuthShell } from '../tests/helpers/served-auth-shell.mjs';
let auth,worker,shell,browser,closing=false;
async function close(){if(closing)return;closing=true;await browser?.close();await shell?.stop();await worker?.stop();await auth?.stop();}
try{
 auth=await startLocalAuthStub({appOrigin:null,jwt:null});worker=await startPublishedWorker({authOrigin:auth.origin});auth.setJwt(worker.jwt);
 shell=await startServedAuthShell({apiOrigin:worker.origin,buildAuthBindings:{SUPABASE_URL:auth.origin,SUPABASE_JWT_ISSUER:`${auth.origin}/auth/v1`,SUPABASE_JWKS_URL:`${auth.origin}/auth/v1/.well-known/jwks.json`}});auth.setAppOrigin(shell.origin);
 console.log(`Local preview review: ${shell.origin}/cases`);
 console.log(`Local fixture Auth: ${auth.origin} (accept its throwaway certificate once if using your own browser).`);
 if(process.argv.includes('--browser')){const {chromium}=await import('@playwright/test');browser=await chromium.launch({headless:false});const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1440,height:900}});const page=await context.newPage();await page.goto(`${shell.origin}/cases`);browser.on('disconnected',()=>{if(!closing)void close().then(()=>process.exit(0));});}
 console.log('Use owner@example.invalid and local fixture code 123456. Open Published case, then Preview. The local Auth stub uses a throwaway TLS certificate.');
 for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{void close().then(()=>process.exit(0));});
}catch(error){await close();throw error;}
