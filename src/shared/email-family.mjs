// Shared email-only rendering. Numeric colours are generated from the shipped CSS tokens.
// All recipient/case data is escaped here; only fixed template fragments are HTML.
import { EMAIL_COLOURS } from './email-tokens.mjs';
import { emailArtUrl } from './urls.mjs';
const FONT = "Montserrat, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
export const emailText = value => String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
export const emailEscape = value => emailText(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const e = emailEscape;
const paragraph = text => `<p style="margin:0 0 16px;">${text}</p>`;
function layout({ title, preheader, intro, details, action = null, support, finalLine = '' }) {
  const c = EMAIL_COLOURS.light, d = EMAIL_COLOURS.dark;
  const dark = `@media (prefers-color-scheme: dark){.cb{background:${d.bg}!important}.cc{background:${d.card}!important;border-color:${d.line}!important}.ci{color:${d.ink}!important}.cm{color:${d.muted}!important}.cp{color:${d.petrol}!important}.ct{background:${d.tint}!important}.cbtn{background:${d.petrol}!important}.cbtn a{color:${d.onPetrol}!important}.cl{border-color:${d.line}!important}}`
    + `@media(max-width:480px){.pad{padding-left:20px!important;padding-right:20px!important}}`
    + `[data-ogsc] .cb{background:${d.bg}!important}[data-ogsc] .cc{background:${d.card}!important}[data-ogsc] .ci{color:${d.ink}!important}[data-ogsc] .cm{color:${d.muted}!important}[data-ogsc] .cp{color:${d.petrol}!important}[data-ogsc] .ct{background:${d.tint}!important}[data-ogsc] .cbtn{background:${d.petrol}!important}[data-ogsc] .cbtn a{color:${d.onPetrol}!important}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><title>${e(title)}</title><style>${dark}</style></head>`
    + `<body class="cb" style="margin:0;padding:0;background:${c.bg};"><div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${e(preheader)}</div>`
    + `<table role="presentation" class="cb" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${c.bg};"><tr><td align="center" style="padding:24px 12px;">`
    + `<!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->`
    + `<table role="presentation" class="cc" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:${c.card};border:1px solid ${c.line};border-radius:8px;">`
    + `<tr><td style="background:${c.tint};border-radius:8px 8px 0 0;"><img src="${emailArtUrl()}" width="600" height="144" alt="Case mosaic: petrol paths with coral and ochre tiles" style="display:block;width:100%;max-width:600px;height:auto;border:0;border-radius:8px 8px 0 0;color:${c.ink};font:14px Arial,sans-serif;"></td></tr>`
    + `<tr><td class="pad cp" style="padding:24px 32px 0;font:700 16px/1.4 ${FONT};letter-spacing:3px;color:${c.petrol};">CASE</td></tr>`
    + `<tr><td class="pad ci" style="padding:18px 32px 0;color:${c.ink};font:16px/1.6 ${FONT};overflow-wrap:anywhere;"><h1 style="margin:0;font:700 26px/1.3 ${FONT};">${e(title)}</h1><p style="margin:16px 0 0;">${intro}</p></td></tr>`
    + `<tr><td class="pad" style="padding:20px 32px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td class="ct ci" style="padding:18px;background:${c.tint};color:${c.ink};border-radius:6px;font:15px/1.6 ${FONT};overflow-wrap:anywhere;">${details}</td></tr></table></td></tr>`
    + (action ? `<tr><td class="pad" style="padding:24px 32px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td class="cbtn" bgcolor="${c.petrol}" style="background:${c.petrol};border-radius:6px;mso-padding-alt:14px 20px;text-align:center;"><a href="${e(action.url)}" style="display:block;padding:14px 20px;font:600 16px/1.4 ${FONT};color:${c.onPetrol};text-decoration:none;">${e(action.label)}</a></td></tr></table></td></tr>` : '')
    + `<tr><td class="pad cm" style="padding:20px 32px 28px;font:14px/1.6 ${FONT};color:${c.muted};overflow-wrap:anywhere;">${support}<p class="cl" style="margin:24px 0 0;padding-top:16px;border-top:1px solid ${c.line};font:13px/1.6 ${FONT};">Case · case.iatrogenic.app</p>`
    + (finalLine ? `<p dir="ltr" style="margin:16px 0 0;font:13px/1.5 'Courier New',monospace;">${finalLine}</p>` : '')
    + `</td></tr></table><!--[if mso]></td></tr></table><![endif]--></td></tr></table></body></html>`;
}
export function invitationHtml(message, days) {
  return layout({ title: `${message.inviter} invited you to ${message.caseTitle ? `“${message.caseTitle}”` : message.workspace}`,
    preheader: message.preheader, intro: e(message.lead),
    details: `<b>${e(message.permission)}</b> - you can:<ul style="margin:10px 0 0;padding-left:20px;">${message.can.map(line => `<li style="margin:6px 0;">${e(line)}</li>`).join('')}</ul>`,
    action: { url: message.url, label: 'Sign in to Case' },
    support: paragraph(`We’ll fill in ${e(message.to)} for you and email a 6-digit code; there is no password.`)
      + paragraph(`This invitation works for ${days} days, until <b class="ci">${e(message.expires)}</b>.`)
      + `Not expecting this? You can ignore this email; nothing happens unless you sign in. Reply to reach ${e(message.inviter)}.` });
}
export function operationalAlertHtml(payload) {
  const fields = [['Event', payload.event.kind], ['Environment', payload.env], ['Build', payload.build]];
  for (const [key, value] of Object.entries(payload.event)) {
    if (key === 'kind') continue;
    if (key === 'counts') fields.push(...Object.entries(value));
    else fields.push([key, value === null ? 'Not reported' : value]);
  }
  return layout({ title: 'An operational alert needs review', preheader: 'Case reported an operational alert.',
    intro: `Case ${e(payload.env)} reported <b>${e(payload.event.kind)}</b>.`,
    details: fields.map(([label, value]) => `<p style="margin:0 0 12px;"><b>${e(label)}</b><br><span style="word-break:break-all;">${e(value)}</span></p>`).join(''),
    support: 'Review the Case operational runbook.' });
}
const AUTH = Object.freeze({
  'magic-link': { title: 'Your Case verification code', intro: 'Use this code in the Case window where you requested it.', code: true, action: 'Or sign in with this link' },
  'confirm-signup': { title: 'Confirm your email', intro: 'Use this code to confirm your email address for Case.', code: true, action: 'Confirm email address' },
  'invite-user': { title: 'You’re invited to Case', intro: 'You have been invited to create a Case account.', action: 'Accept invitation' },
  'reset-password': { title: 'Reset your password', intro: 'We received a request to reset your Case password.', action: 'Reset password' },
  'change-email': { title: 'Confirm your email change', intro: 'Confirm the requested change from {{ .Email }} to {{ .NewEmail }}.', action: 'Confirm email change' },
  reauthentication: { title: 'Your Case verification code', intro: 'Use this code to verify your identity for the action you requested.', code: true },
  'password-changed': { title: 'Your password was changed', intro: 'The password for your Case account {{ .Email }} was changed.', security: 'If you didn’t make this change, reset your password and contact your Case administrator immediately.' },
  'email-changed': { title: 'Your email address was changed', intro: 'Your Case email address was changed from {{ .OldEmail }} to {{ .Email }}.' },
  'phone-changed': { title: 'Your phone number was changed', intro: 'Your Case phone number was changed from {{ .OldPhone }} to {{ .Phone }}.' },
  'identity-linked': { title: 'A sign-in method was linked', intro: 'A {{ .Provider }} sign-in method was linked to your Case account {{ .Email }}.' },
  'identity-unlinked': { title: 'A sign-in method was removed', intro: 'A {{ .Provider }} sign-in method was removed from your Case account {{ .Email }}.' },
  'mfa-enrolled': { title: 'A verification method was added', intro: 'A {{ .FactorType }} verification method was added to your Case account {{ .Email }}.' },
  'mfa-unenrolled': { title: 'A verification method was removed', intro: 'A {{ .FactorType }} verification method was removed from your Case account {{ .Email }}.' },
});
export const AUTH_EMAIL_KINDS = Object.freeze(Object.keys(AUTH));
// Candidate templates only: compare live security/expiry wording and variables before applying.
export function authEmail(kind) {
  if (!Object.hasOwn(AUTH, kind)) throw new TypeError('Unknown Auth email');
  const spec = AUTH[kind];
  const code = '{{ .Token }}', link = '{{ .ConfirmationURL }}';
  const security = spec.security ?? (spec.action || spec.code
    ? 'If you didn’t request this email, you can ignore it. Never share a verification code. If the code or link has expired, request a new one.'
    : 'If you didn’t make this change, contact your Case administrator immediately.');
  const detail = spec.code ? `<p align="center" style="margin:0 0 8px;text-align:center;">Your verification code is:</p><p align="center" dir="ltr" style="margin:0;text-align:center;font:700 36px/1.3 'Courier New',monospace;letter-spacing:4px;white-space:nowrap;user-select:text;">${code}</p>`
    : spec.action ? 'Continue using the button below.' : 'Review your account security if this change was unexpected.';
  const finalLine = spec.code ? `@case.iatrogenic.app #${code}` : '';
  return { html: layout({ title: spec.title, preheader: 'A requested verification or security update from Case.', intro: e(spec.intro), details: detail,
    action: spec.action ? { url: link, label: spec.action } : null, support: e(security), finalLine }),
    text: [spec.title, '', spec.intro, '', spec.code ? `Your verification code is:\n${code}` : spec.action ? 'Continue using the link below.' : 'Review your account security if this change was unexpected.', '',
      ...(spec.action ? [`${spec.action}: ${link}`, ''] : []), security, '', 'Case · case.iatrogenic.app', ...(finalLine ? ['', finalLine] : [])].join('\n') };
}
