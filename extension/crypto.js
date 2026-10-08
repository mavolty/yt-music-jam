import { ROOM, TOKEN, MAX_FRAME } from './protocol.js';

export function encode(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function decode(value) {
  if (typeof value !== 'string' || !/^[\w-]+$/.test(value) || value.length > MAX_FRAME * 2) throw new Error('Invalid encoded message.');
  return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0));
}
export const randomToken = () => encode(crypto.getRandomValues(new Uint8Array(32)));
export const randomId = () => [...crypto.getRandomValues(new Uint8Array(16))].map(byte => byte.toString(16).padStart(2, '0')).join('');
export async function digest(value) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
export function relayOrigin(value) {
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))) {
    throw new Error('Use an HTTPS relay address (HTTP is allowed only for local development).');
  }
  return url.origin;
}
export function invitation(config) {
  return `${config.relay}/join#${encode(new TextEncoder().encode(JSON.stringify({ v: 1, room: config.room, token: config.joinToken, key: config.key })))}`;
}
export function parseInvitation(value) {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('Paste the complete session invitation.');
  const url = new URL(value.trim());
  const relay = relayOrigin(url.origin);
  const data = JSON.parse(new TextDecoder().decode(decode(url.hash.slice(1))));
  if (data.v !== 1 || !ROOM.test(data.room) || !TOKEN.test(data.token) || !TOKEN.test(data.key)) throw new Error('Invalid session invitation.');
  return { relay, room: data.room, token: data.token, key: data.key };
}

export class Cipher {
  constructor(config) {
    this.room = config.room;
    this.role = config.role;
    this.epoch = randomId();
    this.sequence = 0;
    this.received = new Map();
    this.key = crypto.subtle.importKey('raw', decode(config.key), 'AES-GCM', false, ['encrypt', 'decrypt']);
  }
  async seal(message) {
    const frame = { type: 'sealed', role: this.role, epoch: this.epoch, seq: ++this.sequence, iv: '', data: '' };
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode(JSON.stringify(message));
    if (plaintext.length > MAX_FRAME * 0.7) throw new Error('The native queue is too large to synchronize safely.');
    const aad = new TextEncoder().encode(`${this.room}:${frame.role}:${frame.epoch}:${frame.seq}`);
    frame.iv = encode(iv);
    const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, await this.key, plaintext));
    // Chunk encoding avoids spread argument limits for large native queues.
    let binary = '';
    for (let i = 0; i < encrypted.length; i += 8192) binary += String.fromCharCode(...encrypted.subarray(i, i + 8192));
    frame.data = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return frame;
  }
  async open(frame) {
    if (!frame || frame.type !== 'sealed' || frame.role === this.role || !['host', 'guest'].includes(frame.role) ||
      !ROOM.test(frame.epoch) || !Number.isSafeInteger(frame.seq) || frame.seq < 1 ||
      typeof frame.iv !== 'string' || typeof frame.data !== 'string') throw new Error('Invalid encrypted session message.');
    const stream = `${frame.role}:${frame.epoch}`;
    if (frame.seq <= (this.received.get(stream) || 0)) throw new Error('Replayed session message rejected.');
    if (!this.received.has(stream) && this.received.size >= 32) throw new Error('Too many session restarts. Create a fresh room.');
    const iv = decode(frame.iv);
    if (iv.length !== 12) throw new Error('Invalid message nonce.');
    const aad = new TextEncoder().encode(`${this.room}:${frame.role}:${frame.epoch}:${frame.seq}`);
    const result = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad }, await this.key, decode(frame.data));
    const message = JSON.parse(new TextDecoder().decode(result));
    this.received.set(stream, frame.seq);
    return message;
  }
}
