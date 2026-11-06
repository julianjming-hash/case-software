import { operationalAlertHtml } from '../shared/email-family.mjs';
import { uuidv7 } from '../shared/ids.mjs';
import { buildInfo } from './headers.mjs';

export const ALERT_DEDUP_MS = 6 * 60 * 60_000;
export const ALERT_KINDS = Object.freeze(['rpc_forbidden','delete_before_archive','stale_heartbeat',
  'lockdown_alert','supabase_unavailable','archive_fail','archive_lag_s','case_version_integrity',
  'healthcheck_failed','cron_failure']);
const kinds = new Set(ALERT_KINDS);
const jobs = new Set(['keepalive','purge_participant_data']);
const countFields = new Set(['participants','rounds','responses','journal','endSession']);
const plain = value => value && [Object.prototype,null].includes(Object.getPrototypeOf(value));
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** Alert content consists only of fixed labels and numeric counts/ages; reject, never redact. */
export function alertEvent(input) {
  try {
    if (!plain(input) || !kinds.has(input.kind)) return null;
    const fields = new Set(['kind']);
    if (input.kind === 'delete_before_archive') fields.add('counts');
    if (input.kind === 'stale_heartbeat') { fields.add('job'); fields.add('ageS'); }
    if (input.kind === 'archive_lag_s') fields.add('value');
    if (Reflect.ownKeys(input).some(key => !fields.has(key))) return null;
    if (input.kind === 'delete_before_archive') {
      if (!plain(input.counts) || Reflect.ownKeys(input.counts).some(key => !countFields.has(key) ||
        !Number.isSafeInteger(input.counts[key]) || input.counts[key] < 0)) return null;
      return { kind: input.kind, counts: { ...input.counts } };
    }
    if (input.kind === 'stale_heartbeat') {
      if (!jobs.has(input.job) || (input.ageS !== null && !number(input.ageS))) return null;
      return { kind: input.kind, job: input.job, ageS: input.ageS };
    }
    if (input.kind === 'archive_lag_s') return number(input.value) ? {kind:input.kind,value:input.value} : null;
    return {kind:input.kind};
  } catch { return null; }
}
const email = value => typeof value === 'string' && value.length <= 254 &&
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(value) && !/[\r\n]/.test(value);

/** Store admission is synchronous and durable in AlertDO; network work is always bounded. */
export class AlertDelivery {
  constructor({ env = {}, store, fetchImpl = fetch, now = Date.now, timeoutMs = 2500 } = {}) {
    this.env=env; this.store=store; this.fetchImpl=fetchImpl; this.now=now;
    this.timeoutMs=Number.isInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 2500 ? timeoutMs : 2500;
  }
  async send(input) {
    let key, reservation, timer, controller;
    try {
      const event=alertEvent(input), at=this.now();
      if (!event || !Number.isSafeInteger(at) || at < 0 || !email(this.env.ALERT_EMAIL_TO) ||
        typeof this.env.RESEND_ALERT_API_KEY !== 'string' || !this.env.RESEND_ALERT_API_KEY ||
        typeof this.fetchImpl !== 'function' || !this.store) return {ok:false};
      const info=buildInfo(this.env);
      key=`${info.env}:${event.kind}:${event.job ?? ''}`;
      const payload={event,env:info.env,build:info.build};
      // Freeze presentation before delivery: retries after a deploy must reuse the provider's exact content.
      // Only admitted event facts and public branding are stored; recipient/configuration never enter the row.
      const message={subject:`Case ${payload.env}: ${payload.event.kind}`,text:JSON.stringify(payload),html:operationalAlertHtml(payload)};
      reservation=this.store.reserve(key,at,{...payload,message},uuidv7(),Math.max(1000,this.timeoutMs*2));
      if (!reservation) return {ok:false,kind:'busy'};
      if (reservation.dedup === true) return {ok:true,suppressed:true};
      // Legacy pending rows were text-only. Preserve that exact body until they acknowledge successfully.
      const pending=reservation.event, facts={event:pending.event,env:pending.env,build:pending.build};
      const frozen=pending.message ?? {subject:`Case ${facts.env}: ${facts.event.kind}`,text:JSON.stringify(facts)};
      const body=JSON.stringify({from:'noreply@iatrogenic.app',to:[this.env.ALERT_EMAIL_TO],
        subject:frozen.subject,text:frozen.text,...(typeof frozen.html==='string'?{html:frozen.html}:{})});
      controller=new AbortController();
      const expired=new Promise(resolve => { timer=setTimeout(() => {controller.abort();resolve(null);},this.timeoutMs); });
      const fetchImpl=this.fetchImpl;
      const request=Promise.resolve().then(() => fetchImpl('https://api.resend.com/emails', {
        method:'POST',redirect:'manual',signal:controller.signal,
        headers:{authorization:`Bearer ${this.env.RESEND_ALERT_API_KEY}`,'content-type':'application/json',
          'idempotency-key':`case-alert:${reservation.id}`},body,
      })).catch(() => null);
      const response=await Promise.race([request,expired]);
      if (!response?.ok || response.type === 'opaqueredirect') {
        this.store.failure(key,reservation.id);return {ok:false};
      }
      // Provider response content is neither needed nor read, and cannot enter a log or email.
      this.store.success(key,reservation.id,this.now());
      return {ok:true};
    } catch {
      if (reservation) try {this.store.failure(key,reservation.id);} catch { /* contained */ }
      return {ok:false};
    } finally {
      clearTimeout(timer);controller?.abort();
    }
  }
}
