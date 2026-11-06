// Local Playwright fault injection. Online frames come from the real server, never a mocked welcome/receipt.
export function socketNetwork() {
  let offline = false, generation = 0;
  const pairs = new Set();
  return {
    get offline() { return offline; },
    get generation() { return generation; },
    async route(socket) {
      if (offline) { await socket.close({ code: 1013, reason: 'Local test network offline' }); return; }
      const server = socket.connectToServer(), pair = { socket, server };
      pairs.add(pair);
      socket.onMessage(message => { if (!offline && pairs.has(pair)) server.send(message); });
      server.onMessage(message => { if (!offline && pairs.has(pair)) socket.send(message); });
      socket.onClose(async (code, reason) => { pairs.delete(pair); await server.close({ code, reason }); });
      server.onClose(async (code, reason) => { pairs.delete(pair); await socket.close({ code, reason }); });
    },
    async setOffline(value) {
      if (value !== offline) generation++;
      offline = value;
      if (!offline) return;
      const disconnected = [...pairs]; pairs.clear();
      await Promise.all(disconnected.flatMap(({ socket, server }) => [socket.close({ code: 1013 }), server.close({ code: 1013 })]));
    },
  };
}
