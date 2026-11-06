// A deliberate unsafe sink in a local-only security test, never shipped.
const result = { scriptLoaded: true, trustedTypesBlocked: false, messages: 0 };
try { document.getElementById('probe').innerHTML = '<b>x'; }
catch (error) { result.trustedTypesBlocked = error instanceof TypeError; }
window.policyProbe = result;
const channel = new BroadcastChannel('case-security-policy-test');
channel.addEventListener('message', event => {
  if (event.data === 'ping') { result.messages++; channel.postMessage('pong'); }
  if (event.data === 'pong') result.messages++;
});
window.policyPing = () => channel.postMessage('ping');
window.addEventListener('pagehide', () => channel.close());

document.getElementById('projector').addEventListener('click', () => window.open(location.origin, '_blank', 'noopener'));
