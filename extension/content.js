// Isolated-world bridge: page code never receives invitations, keys or relay credentials.
(() => {
  const channel = crypto.randomUUID();
  const pending = new Map();
  let port;
  let active = false;
  let notice;
  const send = message => window.dispatchEvent(new CustomEvent('ytmt:to-page', { detail: { channel, ...message } }));
  function connect() {
    try {
      port = chrome.runtime.connect({ name: 'native-player' });
      port.onDisconnect.addListener(() => { if (active) send({ kind: 'pause' }); setTimeout(connect, 1000); });
      port.onMessage.addListener(message => {
        if (message.type === 'status') {
          active = !!message.active;
          if (!notice) {
            notice = document.createElement('div');
            notice.id = 'ytmt-status';
            notice.style.cssText = 'position:fixed;bottom:105px;right:20px;z-index:2147483647;background:#18201e;color:#e7f6ee;border:1px solid #33554b;border-radius:12px;padding:10px 16px;font:13px system-ui;max-width:320px;box-shadow:0 8px 24px #0006;pointer-events:none';
            document.body.appendChild(notice);
          }
          notice.textContent = message.label;
          notice.hidden = !active && !message.error;
        }
      });
      port.postMessage({ type: 'attached' });
    } catch { if (active) send({ kind: 'pause' }); }
  }
  window.addEventListener('ytmt:from-page', event => {
    const message = /** @type {CustomEvent} */ (event).detail;
    if (message?.channel !== channel) return;
    if (message.kind === 'reply' && pending.has(message.id)) {
      const request = pending.get(message.id); pending.delete(message.id); clearTimeout(request.timer);
      if (message.error) request.reject(new Error(message.error)); else request.resolve(message.state);
    } else if (message.kind === 'snapshot') {
      try { port?.postMessage({ type: 'native', state: message.state, previous: message.previous, changes: message.changes, applying: message.applying }); } catch {}
    } else if (message.kind === 'intent') {
      try { port?.postMessage({ type: 'native-intent', state: message.state, previous: message.previous, changes: message.changes }); } catch {}
    }
  });
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id || !['snapshot', 'apply', 'pause'].includes(message.type)) return;
    if (message.type === 'pause') { send({ kind: 'pause' }); respond({ ok: true }); return; }
    const id = crypto.randomUUID();
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('The YouTube Music adapter did not respond. Reload the tab.')); }, 15000);
      pending.set(id, { resolve, reject, timer });
      send({ kind: message.type, id, state: message.state });
    }).then(state => respond({ ok: true, state })).catch(error => respond({ ok: false, error: error.message }));
    return true;
  });
  connect();
  window.addEventListener('offline', () => {
    if (active) send({ kind: 'pause' });
    try { port?.postMessage({ type: 'network', online: false }); } catch {}
  });
  window.addEventListener('online', () => { try { port?.postMessage({ type: 'network', online: true }); } catch {} });
  send({ kind: 'init' });
  // Covers different ordering of the two declarative content-script worlds.
  setTimeout(() => send({ kind: 'init' }), 800);
})();
