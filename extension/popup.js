import { relayOrigin, parseInvitation } from './crypto.js';

const element = id => /** @type {any} */ (document.getElementById(id));
let view = { active: false, invite: '' };
let busy = false;
async function request(message) {
  const result = await chrome.runtime.sendMessage(message);
  if (!result?.ok) throw new Error(result?.error || 'The extension did not respond. Reload it.');
  return result.value;
}
function error(message = '') { element('error').textContent = message; element('error').hidden = !message; }
function render(value) {
  view = value;
  element('setup').hidden = !!value.active;
  element('session').hidden = !value.active;
  if (!value.active) { if (value.notice) error(value.notice); return; }
  element('status').textContent = value.label;
  element('track').textContent = value.title;
  element('invite-box').hidden = !value.invite;
  element('pairing').hidden = !value.pairingCode;
  element('pairing-code').textContent = value.pairingCode;
  element('approve').hidden = !value.approvalNeeded;
  element('discard').hidden = !value.canDiscard;
  element('status-dot').style.background = value.error ? '#df9d7b' : '#a8d8b9';
  error(value.error || '');
}
async function permission(relay) {
  const origins = [`${relay}/*`];
  if (!await chrome.permissions.contains({ origins }) && !await chrome.permissions.request({ origins })) {
    throw new Error('Allow access to your session server to connect.');
  }
}
async function run(work) {
  if (busy) return;
  busy = true; error();
  for (const button of document.querySelectorAll('button')) button.disabled = true;
  try { await work(); } catch (issue) { error(issue.message); }
  finally { busy = false; for (const button of document.querySelectorAll('button')) button.disabled = false; }
}
function tab(join) {
  element('create-panel').hidden = join;
  element('join-panel').hidden = !join;
  element('create-tab').setAttribute('aria-selected', String(!join));
  element('join-tab').setAttribute('aria-selected', String(join));
  error();
}
element('create-tab').addEventListener('click', () => tab(false));
element('join-tab').addEventListener('click', () => tab(true));
element('create-panel').addEventListener('submit', event => {
  event.preventDefault();
  run(async () => {
    const relay = relayOrigin(element('relay').value.trim());
    await permission(relay);
    render(await request({ type: 'create', relay }));
  });
});
element('join-panel').addEventListener('submit', event => {
  event.preventDefault();
  run(async () => {
    const invite = element('invite').value.trim();
    await permission(parseInvitation(invite).relay);
    render(await request({ type: 'join', invite }));
    element('invite').value = '';
  });
});
element('approve').addEventListener('click', () => run(async () => render(await request({ type: 'approve' }))));
element('end').addEventListener('click', () => run(async () => render(await request({ type: 'end' }))));
element('discard').addEventListener('click', () => run(async () => render(await request({ type: 'discard' }))));
element('copy-invite').addEventListener('click', () => run(async () => {
  try { await navigator.clipboard.writeText(view.invite); element('copy-invite').textContent = 'Invitation copied'; }
  catch { element('invite-fallback').hidden = false; element('invite-fallback').value = view.invite; element('invite-fallback').select(); }
}));
element('diagnostics').addEventListener('click', () => run(async () => {
  const result = await request({ type: 'diagnostics' });
  element('diagnostic-result').textContent = result.supported ? `Native player connected · ${result.queueLength} songs${result.ready ? ' · ready' : ' · choose a song and let it load'}` : result.error;
}));
chrome.storage.local.get('relay').then(value => { if (value.relay) element('relay').value = value.relay; });
request({ type: 'status' }).then(render).catch(issue => error(issue.message));
setInterval(() => { if (!busy) request({ type: 'status' }).then(render).catch(() => {}); }, 800);
