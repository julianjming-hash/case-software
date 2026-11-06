/** A controller change never reloads an active room unless that page's user accepted the update. */
export function watchUpdate({ registration, serviceWorker, offer, reload }) {
  let accepted = false; let reloaded = false; let offered;
  const present = () => {
    const waiting = registration.waiting;
    if (!serviceWorker.controller || !waiting || offered === waiting) return;
    offered = waiting;
    offer({ accept() { if (accepted) return; accepted = true; waiting.postMessage({ type: 'ACTIVATE_UPDATE' }); }, decline() { accepted = false; } });
  };
  const change = () => { if (accepted && !reloaded) { reloaded = true; reload(); } };
  serviceWorker.addEventListener('controllerchange', change);
  registration.addEventListener('updatefound', () => registration.installing?.addEventListener('statechange', present));
  present();
  return () => serviceWorker.removeEventListener('controllerchange', change);
}
