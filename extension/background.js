import { Session } from './session.js';
import { digest, randomToken, randomId, relayOrigin, parseInvitation } from './crypto.js';
import { validState } from './protocol.js';

let session = null;
const ports = new Map();
const sendNative = async (tabId, message) => {
  const result = await chrome.tabs.sendMessage(tabId, message);
  if (!result?.ok) throw new Error(result?.error || 'The YouTube Music tab is unavailable. Reload it.');
  return result.state;
};
function publishStatus(status) {
  for (const [tabId, port] of ports) {
    try { port.postMessage({ type: 'status', active: status.active && session?.config.tabId === tabId, label: status.label, error: status.error }); } catch {}
  }
  chrome.action.setBadgeText({ text: status.active ? (status.error ? '!' : '2') : '' }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: status.error ? '#b84e43' : '#1b7c61' }).catch(() => {});
}
function hooks(tabId) {
  return {
    apply: state => sendNative(tabId, { type: 'apply', state }),
    pause: () => sendNative(tabId, { type: 'pause' }),
    status: publishStatus,
    save: config => chrome.storage.session.set({ session: config }),
    clear: async () => { await chrome.storage.session.remove('session'); session = null; },
  };
}
const restored = (async () => {
  const stored = await chrome.storage.session.get('session');
  if (stored.session) {
    const config = /** @type {any} */ (stored.session);
    session = new Session(config, hooks(config.tabId));
    try { await session.start(); } catch (error) { await session.fail(error.message); }
  }
})();
async function selectedTab() {
  const active = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = active.find(tab => tab.url?.startsWith('https://music.youtube.com/')) ||
    (await chrome.tabs.query({ url: 'https://music.youtube.com/*' })).find(tab => ports.has(tab.id));
  if (!tab || !ports.has(tab.id)) throw new Error('Open YouTube Music, reload its tab, and open Up next before starting a session.');
  return tab.id;
}
async function requirePermission(relay) {
  if (!await chrome.permissions.contains({ origins: [`${relay}/*`] })) throw new Error('Allow access to this relay address in the extension popup.');
}
async function begin(config) {
  if (session && !session.closed) throw new Error('End your current session before creating or joining another.');
  session = new Session(config, hooks(config.tabId));
  await chrome.storage.session.set({ session: config });
  await session.start();
  return session.view();
}
chrome.runtime.onConnect.addListener(port => {
  const sender = port.sender;
  if (port.name !== 'native-player' || sender?.id !== chrome.runtime.id || !sender.tab?.id ||
    !sender.url?.startsWith('https://music.youtube.com/')) { port.disconnect(); return; }
  const tabId = sender.tab.id;
  ports.set(tabId, port);
  port.onMessage.addListener(message => {
    restored.then(async () => {
      if (message.type === 'attached') {
        publishStatus(session?.view() || { active: false, label: '' });
        return;
      }
      if (message.type === 'network' && session?.config.tabId === tabId && typeof message.online === 'boolean') {
        await session.network(message.online); return;
      }
      if (message.type === 'native' && session?.config.tabId === tabId) await session.nativeUpdate(message);
      if (message.type === 'native-intent' && session?.config.tabId === tabId) await session.nativeIntent(message);
    }).catch(error => session?.fail(error.message));
  });
  port.onDisconnect.addListener(() => {
    if (ports.get(tabId) === port) ports.delete(tabId);
    if (session?.config.tabId === tabId && !session.closed) session.detached().catch(() => {});
  });
});
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(`chrome-extension://${chrome.runtime.id}/`)) return;
  (async () => {
    await restored;
    if (message.type === 'status') return session?.view() || { active: false };
    if (message.type === 'diagnostics') {
      const tabId = await selectedTab();
      const state = await sendNative(tabId, { type: 'snapshot' });
      return { supported: state.supported, queueLength: state.queue?.length || 0, ready: state.ready, error: state.error || '' };
    }
    if (message.type === 'approve') { session?.approve(); return session?.view(); }
    if (message.type === 'end') { await session?.end(); return { active: false }; }
    if (message.type === 'create') {
      if (session && !session.closed) throw new Error('End the existing session first.');
      const relay = relayOrigin(message.relay);
      await requirePermission(relay);
      const tabId = await selectedTab();
      const state = await sendNative(tabId, { type: 'snapshot' });
      if (!validState(state) || !state.ready) throw new Error(state.error || 'Choose a song in YouTube Music and let it load before creating a session.');
      const token = randomToken(); const joinToken = randomToken();
      const response = await fetch(`${relay}/rooms`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hostHash: await digest(token), joinHash: await digest(joinToken) }),
      });
      if (!response.ok) throw new Error(`The relay could not create a room (${response.status}). Check its address.`);
      const { room, expiresAt } = await response.json();
      await chrome.storage.local.set({ relay });
      return begin({ role: 'host', relay, room, expiresAt, token, joinToken, key: randomToken(), clientId: randomId(), tabId, state, desiredPlaying: !state.paused });
    }
    if (message.type === 'join') {
      const config = parseInvitation(message.invite);
      await requirePermission(config.relay);
      const tabId = await selectedTab();
      const state = await sendNative(tabId, { type: 'snapshot' });
      if (!state.supported) throw new Error(state.error || 'The native YouTube Music player is unavailable.');
      await chrome.storage.local.set({ relay: config.relay });
      return begin({ ...config, role: 'guest', clientId: randomId(), tabId });
    }
    throw new Error('Unknown extension action.');
  })().then(value => respond({ ok: true, value })).catch(error => respond({ ok: false, error: error.message }));
  return true;
});
