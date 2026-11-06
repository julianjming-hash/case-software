import { DurableObject } from 'cloudflare:workers';
import { AlertStore } from './alert-store.mjs';
import { AlertDelivery } from './alerts.mjs';
import { withSecurityHeaders } from './headers.mjs';

/** Trusted fixed-schema RPC only. Admission is durable before external email delivery. */
export class AlertDO extends DurableObject {
  constructor(ctx,env) {
    super(ctx,env);
    this.delivery=new AlertDelivery({env,store:new AlertStore(ctx.storage.sql)});
  }
  send(event) { return this.delivery.send(event); }
  fetch() { return withSecurityHeaders(new Response('not found',{status:404}),'json',this.env); }
}
