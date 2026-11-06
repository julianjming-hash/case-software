// Model of Softnet 0.24.0's packet policy, written from its source for known-answer tests (CASE-301):
// lib/proxy/rule.rs (parsing), lib/proxy/rules.rs (longest prefix; an identical block beats an allow; bare
// rules apply both ways once any directional rule exists), lib/proxy/vm.rs and host.rs (fallbacks), and
// lib/proxy/mod.rs (vmnet bridge isolation is on unless the allow list holds the bare 0.0.0.0/0).
const int = ip => ip.split('.').reduce((value, octet) => ((value << 8) | Number(octet)) >>> 0, 0);
const mask = len => (len === 0 ? 0 : (0xffffffff << (32 - len)) >>> 0);
const contains = (entry, address) => ((int(address) & mask(entry.len)) >>> 0) === entry.net;
const NOT_GLOBAL = ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24', '192.0.2.0/24', '192.88.99.0/24', '192.168.0.0/16', '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/4', '240.0.0.0/4'];

function parse(text) {
  return text.split(',').map(item => item.trim()).filter(Boolean).map(item => {
    const [, direction, target] = /^(?:(in|out) )?(.+)$/.exec(item);
    return { direction: direction ?? null, target };
  });
}
const prefix = (target, host) => {
  const [address, len] = target === '@host' ? [host, 32] : [target.split('/')[0], Number(target.split('/')[1] ?? 32)];
  return { net: (int(address) & mask(len)) >>> 0, len };
};

export function softnetPolicy({ allow, block, host }) {
  const allowRules = parse(allow); const blockRules = parse(block);
  const stateful = [...allowRules, ...blockRules].some(rule => rule.direction);
  const maps = { in: [], out: [] };
  const insert = (rule, action) => {
    const entry = { ...prefix(rule.target, host), action };
    for (const direction of rule.direction ? [rule.direction] : (stateful ? ['in', 'out'] : ['out'])) {
      const list = maps[direction]; const same = list.findIndex(e => e.net === entry.net && e.len === entry.len);
      if (same >= 0) list[same] = entry; else list.push(entry);
    }
  };
  for (const rule of allowRules) insert(rule, 'allow');
  for (const rule of blockRules) insert(rule, 'block');
  const lpm = (address, direction) => maps[direction].filter(e => contains(e, address)).sort((a, b) => b.len - a.len)[0]?.action;
  return {
    isolation: !allowRules.some(rule => !rule.direction && rule.target === '0.0.0.0/0'),
    outbound(destination) {
      const action = lpm(destination, 'out');
      if (action) return action;
      if (!NOT_GLOBAL.some(range => contains(prefix(range), destination))) return 'allow';
      return destination === host ? 'allow' : 'block';
    },
    inbound(source) { return lpm(source, 'in') ?? 'allow'; }
  };
}
