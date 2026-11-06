// Observe the original local join request/201 without changing its bytes or delivery.
import { gunzipSync, brotliDecompressSync, inflateSync } from 'node:zlib';
import { isUuidV7, isCapabilityToken, normalizeCode, JOIN_CODE_LENGTH } from '../../src/shared/ids.mjs';
import { normaliseDisplayName, displayNameProblem } from '../../src/shared/participant.mjs';
import { parseJoinRequest } from '../../src/shared/wire.mjs';

const MAX_BYTES = 4096, MAX_CANDIDATES = 8;
const decoders = { gzip: gunzipSync, br: brotliDecompressSync, deflate: inflateSync };
const json = bytes => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
const discardError = () => {};
// Native aborted/destroyed streams may emit error after private observers have disposed.
// This sink captures no waiter, payload or diagnostic, and ends with the stream itself.
function guardLateErrors(stream) {
  stream.on('error', discardError);
  stream.once('close', () => stream.removeListener('error', discardError));
}

export function createParticipantJoinCapture(timeoutMs = 10_000) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new Error('local_join_timeout_invalid');
  timeoutMs = Math.min(10_000, timeoutMs);
  let waiting = null, closed = false;
  return {
    waitForParticipant({ sessionId, joinCode, displayName }) {
      if (closed || waiting) throw new Error('local_join_waiter_unavailable');
      if (!isUuidV7(sessionId) || normalizeCode(joinCode, JOIN_CODE_LENGTH) !== joinCode ||
          typeof displayName !== 'string' || displayNameProblem(displayName)) throw new Error('local_join_scope_invalid');
      let armed;
      const promise = new Promise((resolve, reject) => {
        const waiter = { sessionId, joinCode, displayName: normaliseDisplayName(displayName), winner: null, candidates: new Set(),
          finish(error, value) {
            if (waiting !== waiter) return;
            clearTimeout(timer); waiting = null;
            for (const candidate of [...waiter.candidates]) candidate.dispose();
            waiter.winner = null; waiter.displayName = null;
            error ? reject(new Error(`local_join_response_${error}`)) : resolve(Object.freeze(value));
          } };
        const timer = setTimeout(() => waiter.finish('timeout'), timeoutMs);
        waiting = waiter; armed = waiter;
      });
      return Object.assign(promise, { cancel() { armed.finish('unavailable'); } });
    },
    prepareRequest(request, path) {
      const waiter = waiting;
      if (!waiter || waiter.winner || request.method !== 'POST' || path !== '/api/v1/join' || request.url !== path) return null;
      if (waiter.candidates.size >= MAX_CANDIDATES) { waiter.finish('invalid'); return null; }
      let alive = true, matched = false, requestEnded = false, responseEnded = false, responseAttached = false;
      let requestBytes = 0, responseBytes = 0, expectedToken, value, responseError;
      const requestChunks = [], responseChunks = [], listeners = [];
      const on = (emitter, name, fn) => { emitter.on(name, fn); listeners.push([emitter, name, fn]); };
      const unavailable = () => { if (alive) waiter.finish('unavailable'); };
      const invalid = () => { if (alive) waiter.finish('invalid'); };
      const finishIfReady = () => {
        if (!alive || !matched || !responseEnded) return;
        if (responseError || !value || value.sessionId !== waiter.sessionId ||
            (expectedToken !== undefined && value.token !== expectedToken)) invalid();
        else waiter.finish(null, value);
      };
      const ticket = {
        dispose() {
          if (!alive) return;
          alive = false; requestChunks.length = 0; responseChunks.length = 0; value = null; expectedToken = undefined;
          for (const [emitter, name, fn] of listeners) emitter.removeListener(name, fn);
          listeners.length = 0; waiter.candidates.delete(ticket);
        },
        unavailable,
        observeResponse(result) {
          if (responseAttached) return;
          responseAttached = true; guardLateErrors(result);
          if (!alive || waiting !== waiter) return;
          on(result, 'data', chunk => {
            responseBytes += chunk.length;
            if (responseBytes > MAX_BYTES) { responseChunks.length = 0; responseError = 'invalid'; if (matched) invalid(); }
            else responseChunks.push(chunk);
          });
          on(result, 'end', () => {
            responseEnded = true;
            try {
              if (responseError || responseBytes > MAX_BYTES || result.statusCode !== 201) throw new Error();
              let bytes = Buffer.concat(responseChunks);
              const encoding = result.headers['content-encoding'];
              if (encoding && encoding !== 'identity') {
                if (!Object.hasOwn(decoders, encoding)) throw new Error();
                bytes = decoders[encoding](bytes, { maxOutputLength: MAX_BYTES });
              }
              if (bytes.length > MAX_BYTES) throw new Error();
              value = json(bytes);
              if (!value || Object.keys(value).sort().join() !== 'participantId,sessionId,token' ||
                  !isUuidV7(value.sessionId) || !isUuidV7(value.participantId) || !isCapabilityToken(value.token)) throw new Error();
            } catch { responseError = 'invalid'; }
            finally { responseChunks.length = 0; }
            finishIfReady();
          });
          const responseUnavailable = () => {
            responseEnded = true; responseError = 'unavailable'; responseChunks.length = 0;
            if (matched) unavailable();
          };
          on(result, 'error', responseUnavailable); on(result, 'aborted', responseUnavailable);
          on(result, 'close', () => { if (!responseEnded && !result.complete) responseUnavailable(); });
        },
      };
      waiter.candidates.add(ticket); guardLateErrors(request);
      on(request, 'data', chunk => {
        requestBytes += chunk.length;
        if (requestBytes > MAX_BYTES) { requestChunks.length = 0; invalid(); }
        else requestChunks.push(chunk);
      });
      on(request, 'end', () => {
        requestEnded = true;
        try {
          if (requestBytes > MAX_BYTES || (request.headers?.['content-encoding'] && request.headers['content-encoding'] !== 'identity')) throw new Error();
          const body = json(Buffer.concat(requestChunks)), parsed = parseJoinRequest(body);
          if (!parsed.ok || Object.keys(body).some(key => !['v', 'code', 'displayName', 'avatarId', 'joinToken', 'turnstileToken'].includes(key))) throw new Error();
          if (normalizeCode(parsed.code, JOIN_CODE_LENGTH) !== waiter.joinCode || parsed.displayName !== waiter.displayName) { ticket.dispose(); return; }
          if (waiting !== waiter || waiter.winner) { ticket.dispose(); return; }
          matched = true; expectedToken = parsed.joinToken; waiter.winner = ticket;
          for (const other of [...waiter.candidates]) if (other !== ticket) other.dispose();
          if (responseError === 'unavailable') unavailable(); else finishIfReady();
        } catch { invalid(); }
        finally { requestChunks.length = 0; }
      });
      on(request, 'error', unavailable); on(request, 'aborted', unavailable);
      on(request, 'close', () => { if (!requestEnded && !request.complete) unavailable(); });
      return ticket;
    },
    close() { closed = true; waiting?.finish('unavailable'); },
  };
}
