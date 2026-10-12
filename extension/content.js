// Isolated world: relays between page.js (main world) and the background
// session, and draws the Jam panel. Strings only cross the world boundary.

const TO_PAGE = 'ytm-jam:to-page';
const FROM_PAGE = 'ytm-jam:from-page';

let port = null;
let jam = null;

function toPage(message) {
  document.dispatchEvent(new CustomEvent(TO_PAGE, { detail: JSON.stringify(message) }));
}

function connect() {
  port = chrome.runtime.connect({ name: 'ytm-jam' });
  port.onMessage.addListener(message => {
    if (message.type === 'jam') render(message.jam);
    else toPage(message);
  });
  port.onDisconnect.addListener(() => {
    port = null;
    setTimeout(connect, 200); // service worker restarted
  });
  port.postMessage({ type: 'hello' });
}

document.addEventListener(FROM_PAGE, event => {
  const message = JSON.parse(event.detail);
  if (message.type === 'toast') return toast(message.text);
  port?.postMessage(message);
});

connect();

// ---------- panel ----------

const host = document.createElement('div');
host.id = 'ytm-jam-root';
const shadow = host.attachShadow({ mode: 'open' });
shadow.innerHTML = `
<style>
  :host { all: initial; }
  .wrap {
    --ink: #17131f; --surface: #221c2d; --line: #352c44;
    --text: #f3eef8; --muted: #a59bb3; --me: #c9b6ff; --them: #ffb59a;
    position: fixed; left: 20px; bottom: 92px; z-index: 2147483000;
    font: 14px/1.4 Roboto, "YouTube Sans", system-ui, sans-serif; color: var(--text);
    display: flex; flex-direction: column; align-items: flex-start; gap: 10px;
  }
  .wrap[hidden] { display: none; }
  .pill {
    display: flex; align-items: center; gap: 10px; padding: 8px 14px 8px 8px;
    background: var(--ink); border: 1px solid var(--line); border-radius: 999px;
    color: inherit; font: inherit; cursor: pointer;
    box-shadow: 0 10px 30px rgba(10, 4, 20, .5);
  }
  .pill:focus-visible, button:focus-visible { outline: 2px solid var(--me); outline-offset: 2px; }
  .faces { display: flex; }
  .face {
    width: 26px; height: 26px; border-radius: 50%; display: grid; place-items: center;
    font-weight: 700; font-size: 12px; color: var(--ink); border: 2px solid var(--ink);
  }
  .face.me { background: var(--me); }
  .face.them { background: var(--them); margin-left: -8px; }
  .face.empty { background: transparent; border: 2px dashed var(--muted); color: var(--muted); }
  .label { font-weight: 500; }
  .sub { color: var(--muted); font-size: 12px; }
  .live { width: 8px; height: 8px; border-radius: 50%; background: #7be0b0; }
  .live.off { background: #f0a35e; animation: blink 1s steps(2) infinite; }
  @keyframes blink { 50% { opacity: .2; } }
  @media (prefers-reduced-motion: reduce) { .live.off { animation: none; } }

  .card {
    width: 320px; max-height: min(460px, 60vh); overflow: auto;
    background: var(--surface); border: 1px solid var(--line); border-radius: 18px;
    box-shadow: 0 18px 50px rgba(10, 4, 20, .55);
  }
  .card[hidden] { display: none; }
  .head { padding: 16px 16px 8px; display: flex; justify-content: space-between; align-items: baseline; }
  .head h2 { margin: 0; font-size: 16px; font-weight: 700; }
  .code { color: var(--muted); font-size: 12px; letter-spacing: .08em; }
  ol { list-style: none; margin: 0; padding: 4px 8px 10px; }
  li {
    display: grid; grid-template-columns: 40px minmax(0, 1fr) auto; gap: 10px; align-items: center;
    padding: 6px 8px; border-radius: 12px; border-left: 3px solid var(--who);
  }
  li:hover { background: rgba(255,255,255,.04); }
  li img { width: 40px; height: 40px; border-radius: 6px; object-fit: cover; background: var(--line); }
  .t { font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .a { color: var(--muted); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .a b { color: var(--who); font-weight: 500; }
  .acts { display: flex; gap: 2px; }
  .acts button {
    width: 30px; height: 30px; border: 0; border-radius: 50%; background: transparent;
    color: var(--muted); cursor: pointer; font-size: 15px;
  }
  .acts button:hover { background: rgba(255,255,255,.08); color: var(--text); }
  .now { margin: 0 8px 4px; }
  .now li { border-left-color: transparent; background: rgba(201,182,255,.08); }
  .empty-note { padding: 6px 16px 18px; color: var(--muted); font-size: 13px; }
  .toast {
    background: var(--ink); border: 1px solid var(--line); border-radius: 12px;
    padding: 10px 14px; box-shadow: 0 10px 30px rgba(10,4,20,.5);
  }
</style>
<div class="wrap" hidden>
  <div class="toasts"></div>
  <section class="card" hidden aria-label="Jam queue">
    <div class="head"><h2>Your Jam</h2><span class="code"></span></div>
    <ol class="now"></ol>
    <ol class="queue"></ol>
    <p class="empty-note" hidden>Use "Add to queue" or "Play next" on any song to line it up for both of you. When the queue is empty, the host's autoplay picks.</p>
  </section>
  <button class="pill" aria-expanded="false">
    <span class="faces"></span>
    <span><span class="label"></span><br><span class="sub"></span></span>
    <span class="live"></span>
  </button>
</div>`;

const $ = selector => shadow.querySelector(selector);
const wrap = $('.wrap');
const card = $('.card');
const pill = $('.pill');

pill.addEventListener('click', () => {
  card.hidden = !card.hidden;
  pill.setAttribute('aria-expanded', String(!card.hidden));
});

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'style') node.style.cssText = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  node.append(...children.filter(c => c != null));
  return node;
}

const initial = name => (name || '?').trim().charAt(0).toUpperCase() || '?';

function songRow(song, { who, mine, actions }) {
  return el('li', { style: `--who: ${mine ? 'var(--me)' : 'var(--them)'}` },
    el('img', { src: song.art || `https://i.ytimg.com/vi/${song.videoId}/mqdefault.jpg`, alt: '' }),
    el('div', {},
      el('div', { class: 't', title: song.title || '' }, song.title || 'Unknown song'),
      el('div', { class: 'a' }, song.artist || '', who ? ' ' : '', who ? el('b', {}, `${mine ? 'you' : who} added`) : null)),
    actions || el('span'));
}

function render(next) {
  jam = next;
  const active = jam && jam.status !== 'idle';
  wrap.hidden = !active;
  if (!active) return;

  const partner = jam.partners[0];
  const faces = $('.faces');
  faces.replaceChildren(
    el('span', { class: 'face me', title: 'You' }, initial(jam.myName)),
    el('span', { class: partner ? 'face them' : 'face them empty', title: partner || 'Waiting' }, partner ? initial(partner) : '?'));

  const label = jam.status === 'ended' ? 'Jam ended'
    : partner ? `Jamming with ${jam.partners.join(' & ')}`
    : jam.role === 'host' ? 'Waiting for your partner' : 'Joining the Jam';
  $('.label').textContent = label;
  $('.sub').textContent = jam.status === 'reconnecting' ? 'Reconnecting…'
    : jam.status === 'ended' ? 'Playback is yours again'
    : `Code ${jam.code}`;
  $('.live').className = jam.status === 'live' ? 'live' : 'live off';
  $('.code').textContent = jam.code;

  const np = jam.nowPlaying;
  $('.now').replaceChildren(...(np?.videoId ? [songRow(np, { who: null })] : []));
  $('.queue').replaceChildren(...jam.queue.map(item => {
    const mine = item.by === jam.me;
    return songRow(item, {
      who: item.byName || 'Partner', mine,
      actions: el('span', { class: 'acts' },
        el('button', { title: 'Play now', 'aria-label': `Play ${item.title} now`, onclick: () => intent({ kind: 'jump', id: item.id }) }, '▶'),
        el('button', { title: 'Remove', 'aria-label': `Remove ${item.title}`, onclick: () => intent({ kind: 'remove', id: item.id }) }, '✕'))
    });
  }));
  $('.empty-note').hidden = jam.queue.length > 0;
}

function intent(value) {
  port?.postMessage({ type: 'intent', intent: value });
}

function toast(text) {
  const node = el('div', { class: 'toast', role: 'status' }, text);
  $('.toasts').append(node);
  setTimeout(() => node.remove(), 2600);
}

(document.body ? Promise.resolve() : new Promise(r => addEventListener('DOMContentLoaded', r, { once: true })))
  .then(() => document.body.append(host));
