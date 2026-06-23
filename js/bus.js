// FaceTracker — cross-window sync over BroadcastChannel.
// The control panel publishes "changed" notifications; the display reloads the
// affected store from IndexedDB. Also provides lightweight presence so the
// control panel can show whether a display window is live.

import { CHANNEL_NAME, MSG } from './config.js';

export function createBus(role /* 'control' | 'display' */) {
  const ch = new BroadcastChannel(CHANNEL_NAME);
  const handlers = new Set();

  ch.onmessage = (e) => {
    const msg = e.data;
    if (!msg || typeof msg !== 'object') return;
    handlers.forEach((h) => {
      try {
        h(msg);
      } catch (err) {
        console.error('[bus] handler error', err);
      }
    });
  };

  const post = (type, payload = {}) => ch.postMessage({ type, role, t: Date.now(), ...payload });

  return {
    role,
    on(fn) {
      handlers.add(fn);
      return () => handlers.delete(fn);
    },
    post,
    // Notify the other side that a store changed and should be reloaded.
    changed(store) {
      post(MSG.CHANGED, { store });
    },
    command(command, args = {}) {
      post(MSG.COMMAND, { command, ...args });
    },
    ping() {
      post(MSG.PING);
    },
    pong() {
      post(MSG.PONG);
    },
    hello() {
      post(role === 'display' ? MSG.HELLO_DISPLAY : MSG.HELLO_CONTROL);
    },
    close() {
      handlers.clear();
      ch.close();
    },
  };
}

// Tracks whether at least one window of `watchFor` role is alive, by pinging
// and listening for pongs/hellos. Calls onChange(boolean) on transitions.
export function trackPresence(bus, watchFor, onChange, { timeout = 4000, interval = 1500 } = {}) {
  let lastSeen = 0;
  let online = false;

  const wantType = watchFor === 'display' ? MSG.HELLO_DISPLAY : MSG.HELLO_CONTROL;

  const off = bus.on((msg) => {
    const fromWatched = msg.role === watchFor;
    if (fromWatched && (msg.type === wantType || msg.type === MSG.PONG || msg.type === MSG.HELLO_DISPLAY || msg.type === MSG.HELLO_CONTROL)) {
      lastSeen = Date.now();
    }
    // Answer pings so the other side can detect us too.
    if (msg.type === MSG.PING && msg.role !== bus.role) bus.pong();
  });

  const timer = setInterval(() => {
    bus.ping();
    const isOnline = Date.now() - lastSeen < timeout;
    if (isOnline !== online) {
      online = isOnline;
      onChange(online);
    }
  }, interval);

  bus.ping();
  bus.hello();

  return () => {
    clearInterval(timer);
    off();
  };
}
