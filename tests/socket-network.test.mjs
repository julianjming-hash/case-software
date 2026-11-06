import test from 'node:test';
import assert from 'node:assert/strict';
import { socketNetwork } from './helpers/socket-network.mjs';

class Route {
  sent = []; closes = []; connections = 0;
  constructor(server = null) { this.server = server; }
  connectToServer() { this.connections++; return this.server; }
  onMessage(fn) { this.message = fn; }
  onClose(fn) { this.closed = fn; }
  send(message) { this.sent.push(message); }
  async close(options) { this.closes.push(options); }
}

test('mobile outage cuts active and newly opened sockets; late frames stay fenced after reconnect', async () => {
  const network = socketNetwork(), server = new Route(), socket = new Route(server);
  await network.route(socket);
  socket.message('real hello'); server.message('real welcome');
  assert.deepEqual(server.sent, ['real hello']); assert.deepEqual(socket.sent, ['real welcome']);
  await network.setOffline(true);
  assert.equal(socket.closes.length, 1); assert.equal(server.closes.length, 1);
  socket.message('offline command'); server.message('late snapshot');
  const blocked = new Route(new Route()); await network.route(blocked);
  assert.equal(blocked.connections, 0, 'a reconnect during outage must not reach the real server');
  assert.equal(blocked.closes.length, 1);
  await network.setOffline(false);
  socket.message('old command'); server.message('old welcome');
  assert.deepEqual(server.sent, ['real hello']); assert.deepEqual(socket.sent, ['real welcome']);
  const freshServer = new Route(), fresh = new Route(freshServer); await network.route(fresh);
  fresh.message('new hello'); freshServer.message('new snapshot');
  assert.deepEqual(freshServer.sent, ['new hello']); assert.deepEqual(fresh.sent, ['new snapshot']);
  await network.setOffline(true);
});

test('normal page and server closures propagate across the real-server relay', async () => {
  const network = socketNetwork(), server = new Route(), socket = new Route(server);
  await network.route(socket); await socket.closed(1000, 'Page closed');
  assert.deepEqual(server.closes, [{ code: 1000, reason: 'Page closed' }]);
  server.message('late frame'); assert.deepEqual(socket.sent, []);
  const otherServer = new Route(), other = new Route(otherServer); await network.route(other);
  await otherServer.closed(1000, 'Server closed');
  assert.deepEqual(other.closes, [{ code: 1000, reason: 'Server closed' }]);
  other.message('late hello'); assert.deepEqual(otherServer.sent, []);
});
