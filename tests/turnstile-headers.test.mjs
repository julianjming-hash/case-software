import test from 'node:test';
import assert from 'node:assert/strict';
import { withSecurityHeaders, HTML_CSP } from '../src/worker/headers.mjs';
import { joinDocumentCsp } from '../src/worker/join-policy.mjs';

test('explicit join HTML response alone applies widget policy while preserving security headers and selected Auth',()=>{
 const env={CASE_ENV:'staging',BUILD_SHA:'a'.repeat(40),SUPABASE_URL:'https://staging.example.invalid',SUPABASE_JWT_ISSUER:'https://staging.example.invalid/auth/v1',SUPABASE_JWKS_URL:'https://staging.example.invalid/auth/v1/.well-known/jwks.json'};
 const base=withSecurityHeaders(new Response('body',{status:200}),'html',env);
 const joined=withSecurityHeaders(new Response('body',{status:200}),'join-html',env);
 assert.equal(joined.headers.get('content-security-policy'),joinDocumentCsp(base.headers.get('content-security-policy'),'/join'));
 for(const [name,value] of base.headers)if(name!=='content-security-policy')assert.equal(joined.headers.get(name),value);
 assert.equal(withSecurityHeaders(new Response(),'html').headers.get('content-security-policy'),HTML_CSP);
 assert.equal(withSecurityHeaders(new Response(),'json',env).headers.get('content-security-policy').includes('challenges.cloudflare.com'),false);
});
