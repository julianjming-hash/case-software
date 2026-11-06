// Display safety confirmation is device-local, never sent as room state.
export function createDisplayCheck() {
  let topology='same-pc', confirmed=false, previous=null;
  return {
    confirm() { confirmed=true; },
    separate() { topology='separate'; confirmed=false; },
    samePc() { topology='same-pc'; confirmed=false; },
    needsCheck() { return topology==='same-pc' && !confirmed; },
    update({connected, displayCount, pairingId, screenId}) {
      const next={connected:Boolean(connected),displayCount,pairingId,screenId};
      // Only a change invalidates a confirmation: a lost or new projector, a
      // display-count change, a re-pair or a different screen identity (CASE-167).
      // The console re-polls every 2 s, so an
      // unchanged state (incl. steady 'no same-PC projector') must not expire a
      // confirmation made between polls (CASE-165, AS-091 race).
      // A switch of identity source (coarse fallback to granted ScreenDetails, at
      // startup or on the opt-in) re-baselines count and identity: the screens
      // did not change, only how well the browser describes them (CASE-167).
      // A rebase still clears on what both sources can see: one screen versus
      // several (a coarse 2 means "at least 2", so 2 to 3 is not a change), or
      // a different size for the screen the console is on.
      const source=id=>typeof id==='string' ? id.slice(0,id.indexOf(':')) : null;
      const rebase=previous && source(previous.screenId)!==source(next.screenId);
      const several=count=>Number.isInteger(count) ? Math.min(count,2) : null;
      const consoleSize=id=>{
        if (typeof id!=='string') return null;
        const match=id.startsWith('coarse:') ? /^coarse:(\d+)x(\d+):/.exec(id)
          : /@-?\d*,-?\d*:(\d+)x(\d+)[*=]*$/.exec(id.slice(id.lastIndexOf('>')+1));
        return match ? `${match[1]}x${match[2]}` : null;
      };
      const rebaseChanged=()=>several(previous.displayCount)!==several(next.displayCount) ||
        (consoleSize(previous.screenId)!==null && consoleSize(next.screenId)!==null &&
          consoleSize(previous.screenId)!==consoleSize(next.screenId));
      if (!previous || previous.connected!==next.connected || previous.pairingId!==next.pairingId ||
        (rebase ? rebaseChanged() : (previous.displayCount!==next.displayCount || previous.screenId!==next.screenId))) confirmed=false;
      previous=next;
    },
  };
}

/** The served projector sends only a two-key, room-bound hello (ARCHITECTURE §10). */
export function createProjectorHandshake(sessionId) {
  let openedAt=null, seenAt=null, screen=null;
  // CASE-327: a hello may carry the projector window's size, so Room sees draws the same screen; one without it still counts.
  const side=value=>Number.isSafeInteger(value)&&value>=320&&value<=8192;
  return {
    opened(at) { openedAt=at; seenAt=null; },
    accept(message, at) {
      if (!message || message.t!=='projector_hello' || message.sessionId!==sessionId) return false;
      const keys=Object.keys(message).length, sized=keys===4&&side(message.width)&&side(message.height);
      if (keys!==2&&!sized) return false;
      seenAt=at; if (sized) screen={ width: message.width, height: message.height };
      return true;
    },
    /** The projector window's last reported size, or null. */
    screen() { return screen; },
    fallbackRequired(at) { return openedAt!==null && seenAt===null && at-openedAt>=3000; },
    alive(at) { return seenAt!==null && at-seenAt<10000; },
  };
}
