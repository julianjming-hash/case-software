import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const source=readFileSync(new URL('../wrangler.toml',import.meta.url),'utf8');
function section(heading){const parts=source.split(new RegExp(`^\\[\\[?${heading.replaceAll('.', '\\.')}\\]?\\]\\s*$`,'m'));assert.ok(parts.length>=2,heading);return parts[1].split(/^\[/m)[0];}
test('observability configuration adds owned SQLite AlertDO without changing existing migration',()=> {
  for(const prefix of ['', 'env.production.','env.staging.']) {
    const binding=source.match(new RegExp(`^\\[\\[${prefix.replaceAll('.', '\\.')}durable_objects.bindings\\]\\]\\s*\\nname = "ALERTS"\\s*\\nclass_name = "AlertDO"$`,'m'));
    assert.ok(binding,`${prefix} AlertDO binding`);
  }
  assert.match(source,/\[\[migrations\]\]\s*tag = "v1"\s*new_sqlite_classes = \["RoomDO", "DirectoryDO"\]/);
  assert.match(source,/\[\[migrations\]\]\s*tag = "v2"\s*new_sqlite_classes = \["AlertDO"\]/);
});
test('observability datasets and bounded telemetry limiters remain environment-specific without secret values',()=> {
  for(const [env,dataset,id] of [['production','case_metrics',2005],['staging','case_metrics_staging',2015]]) {
    const block=source.split(`[env.${env}]`)[1].split(/^\[env\.[^.]+\]\s*$/m)[0];
    assert.match(block,new RegExp(`\\[\\[env\\.${env}\\.analytics_engine_datasets\\]\\]\\s*binding = "METRICS"\\s*dataset = "${dataset}"`));
    assert.match(block,new RegExp(`\\[\\[env\\.${env}\\.ratelimits\\]\\]\\s*name = "TELEMETRY_RATE_LIMITER"\\s*namespace_id = "${id}"\\s*simple = \\{ limit = 120, period = 60 \\}`));
    // The recipient is a secret: a committed var, even empty, would replace it on every deploy (2026-10-17 reliability audit).
    assert.doesNotMatch(section(`env.${env}.vars`),/ALERT_EMAIL_TO\s*=/);
  }
  assert.doesNotMatch(source,/ALERT_EMAIL_TO\s*=/,'no [vars] block may declare the recipient');
  assert.doesNotMatch(source,/RESEND_ALERT_API_KEY\s*=/);
});
