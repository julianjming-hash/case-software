import { ALERT_DEDUP_MS } from './alerts.mjs';

const SCHEMA = `CREATE TABLE IF NOT EXISTS alerts (
  key TEXT PRIMARY KEY,
  next_at INTEGER NOT NULL DEFAULT 0,
  pending_id TEXT,
  pending_payload TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0
) STRICT;`;

/** Fixed per-kind rows only: synchronous admission precedes any await or external email call. */
export class AlertStore {
  constructor(sql) { this.sql=sql;sql.exec(SCHEMA); }
  reserve(key, now, payload, id, leaseMs) {
    const row=this.sql.exec('SELECT * FROM alerts WHERE key = ?',key).toArray()[0];
    if (row?.next_at > now) return {dedup:true};
    if (row?.lease_until > now) return null;
    const pendingId=row?.pending_id ?? id;
    const pendingPayload=row?.pending_id ? row.pending_payload : JSON.stringify(payload);
    this.sql.exec(`INSERT INTO alerts(key,next_at,pending_id,pending_payload,lease_until) VALUES (?,0,?,?,?)
      ON CONFLICT(key) DO UPDATE SET pending_id=excluded.pending_id,
        pending_payload=excluded.pending_payload,lease_until=excluded.lease_until`,
      key,pendingId,pendingPayload,now+leaseMs);
    return {id:pendingId,event:JSON.parse(pendingPayload)};
  }
  success(key, id, now) {
    this.sql.exec(`UPDATE alerts SET next_at=?,pending_id=NULL,pending_payload=NULL,lease_until=0
      WHERE key=? AND pending_id=?`,now+ALERT_DEDUP_MS,key,id);
  }
  failure(key, id) {
    this.sql.exec('UPDATE alerts SET lease_until=0 WHERE key=? AND pending_id=?',key,id);
  }
}
