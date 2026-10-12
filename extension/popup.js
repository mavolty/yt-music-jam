const $ = id => document.getElementById(id);
const views = [...document.querySelectorAll('[data-view]')];

const REASONS = {
  missing: 'No Jam uses that code. Check it with your partner and try again.',
  expired: 'This Jam passed its 12 hour limit. Start a new one.',
  ended: 'The host ended the Jam.',
  full: 'This Jam is full.',
  taken: 'That code belongs to someone else\'s Jam.',
  left: 'You left the Jam.'
};

const call = message => chrome.runtime.sendMessage(message);

function show(name) {
  for (const view of views) view.hidden = view.dataset.view !== name;
}

function render(s) {
  $('notab').hidden = s.hasTab;
  if (s.status === 'idle') return show('idle');
  if (s.status === 'ended') {
    $('ended-reason').textContent = REASONS[s.endedReason] || 'The Jam is over.';
    return show('ended');
  }
  show('live');
  const partner = s.partners.join(' & ');
  document.querySelector('.duo').classList.toggle('paired', Boolean(partner));
  $('caption').textContent = s.status === 'reconnecting' ? 'Reconnecting…'
    : partner ? `Jamming with ${partner}`
    : s.role === 'host' ? 'Waiting for your partner' : 'Joining…';
  $('bigcode').replaceChildren(...[...s.code].map(c => Object.assign(document.createElement('span'), { textContent: c })));
  $('hint').textContent = s.role === 'host' ? 'Your partner types this code in their Jam popup.' : '';
  $('hint').hidden = s.role !== 'host';
  const np = s.nowPlaying;
  $('np').hidden = !np?.videoId;
  if (np?.videoId) {
    $('np-art').src = np.art || `https://i.ytimg.com/vi/${np.videoId}/mqdefault.jpg`;
    $('np-title').textContent = np.title || 'Unknown song';
    $('np-artist').textContent = np.artist || '';
  }
  const bits = [];
  if (s.queueLength) bits.push(`${s.queueLength} in the queue`);
  if (s.rtt != null) bits.push(`${s.rtt} ms to the relay`);
  $('meta').textContent = bits.join(', ');
  $('leave').textContent = s.role === 'host' ? 'End Jam for everyone' : 'Leave Jam';
}

async function init() {
  const { name } = await chrome.storage.local.get('name');
  $('name').value = name || '';
  render(await call({ type: 'status' }));
}

function myName() {
  const value = $('name').value.trim();
  if (!value) {
    $('error').textContent = 'Add your name so your partner knows who joined.';
    $('name').focus();
    return null;
  }
  return value;
}

$('start').addEventListener('click', async () => {
  const name = myName();
  if (name) render(await call({ type: 'start', name }));
});

$('join').addEventListener('submit', async event => {
  event.preventDefault();
  const name = myName();
  const code = $('code').value.trim().toUpperCase();
  if (!name) return;
  if (code.length !== 6) {
    $('error').textContent = 'Codes are 6 characters long.';
    return $('code').focus();
  }
  render(await call({ type: 'join', code, name }));
});

$('leave').addEventListener('click', async () => render(await call({ type: 'leave' })));
$('dismiss').addEventListener('click', async () => render(await call({ type: 'dismiss' })));
chrome.runtime.onMessage.addListener(message => message.type === 'status' && render(message.status));

init();
