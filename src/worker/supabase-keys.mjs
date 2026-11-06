// The sole reader of Supabase bindings. Never put binding values in an error or a log.
export class ConfigError extends Error {
  constructor(message) { super(message); this.name = 'ConfigError'; }
}

export function supabaseConfig(env) {
  const deployed = Boolean(env.CASE_ENV);
  const url = env.SUPABASE_URL || null;
  const issuer = env.SUPABASE_JWT_ISSUER || null;
  const jwksUrl = env.SUPABASE_JWKS_URL || null;
  const secretKey = env.SUPABASE_SECRET_KEY || null;
  const publishableKey = env.SUPABASE_PUBLISHABLE_KEY || null;
  const allowHs256 = env.CASE_ALLOW_HS256 === '1';
  if (deployed && (!url || !issuer || !jwksUrl)) throw new ConfigError('Missing deployed Supabase URL, issuer or JWKS URL');
  if (deployed && allowHs256) throw new ConfigError('HS256 is forbidden in a deployed environment');
  if (secretKey && (typeof secretKey !== 'string' || !/^sb_secret_/.test(secretKey))) throw new ConfigError('Invalid Supabase secret key format');
  if (publishableKey && (typeof publishableKey !== 'string' || !/^sb_publishable_/.test(publishableKey))) throw new ConfigError('Invalid Supabase publishable key format');
  return { url, issuer, jwksUrl, secretKey, publishableKey, allowHs256, jwtSecret: env.SUPABASE_JWT_SECRET || null };
}
