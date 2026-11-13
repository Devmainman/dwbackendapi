// src/services/realtime.js
// WebSocket connection registry. Kept separate from app.js so controllers can
// import it without creating a circular dependency on the app module.

/** userId -> Set<WebSocket> (a user may have several tabs/devices open). */
const connections = new Map();

export const activeConnections = {
  has: (userId) => (connections.get(String(userId))?.size || 0) > 0,
  get size() { return connections.size; },
  keys: () => connections.keys()
};

export const registerConnection = (userId, ws) => {
  const id = String(userId);
  if (!connections.has(id)) connections.set(id, new Set());
  connections.get(id).add(ws);
};

export const unregisterConnection = (userId, ws) => {
  const id = String(userId);
  const set = connections.get(id);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) connections.delete(id);
};

export const forEachConnection = (fn) => {
  connections.forEach((set, userId) => set.forEach((ws) => fn(ws, userId)));
};

export const sendNotification = (userId, data) => {
  const set = connections.get(String(userId));
  if (!set || set.size === 0) return false;
  let delivered = false;
  set.forEach((ws) => {
    if (ws.readyState !== ws.OPEN) return;
    try {
      ws.send(JSON.stringify({ type: 'notification', data, timestamp: Date.now() }));
      delivered = true;
    } catch (err) {
      console.error('WebSocket send error:', err.message);
      unregisterConnection(userId, ws);
    }
  });
  return delivered;
};
