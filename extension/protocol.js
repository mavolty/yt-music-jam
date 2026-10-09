export const MAX_QUEUE = 1000;
export const MAX_FRAME = 256 * 1024;
export const ID = /^[\w-]{11}$/;
export const TOKEN = /^[\w-]{43}$/;
export const ROOM = /^[a-f0-9]{32}$/;
export const shortText = (value, length = 180) => typeof value === 'string' ? value.slice(0, length) : '';

export function validQueue(queue, allowEmpty = false) {
  return Array.isArray(queue) && (allowEmpty || queue.length > 0) && queue.length <= MAX_QUEUE &&
    queue.every(item => item && ID.test(item.videoId) && /^[\w-]{1,80}$/.test(item.key) &&
      typeof item.title === 'string' && item.title.length <= 180 &&
      typeof item.byline === 'string' && item.byline.length <= 180 &&
      typeof item.length === 'string' && item.length.length <= 20 &&
      ['MUSIC_VIDEO_TYPE_ATV', 'MUSIC_VIDEO_TYPE_OMV', 'MUSIC_VIDEO_TYPE_UGC', 'MUSIC_VIDEO_TYPE_PODCAST_EPISODE'].includes(item.musicVideoType)) &&
    new Set(queue.map(item => item.key)).size === queue.length;
}

export function validCommand(state) {
  return !!state && ID.test(state.videoId) && Number.isFinite(state.position) && state.position >= 0 &&
    Number.isFinite(state.duration) && state.duration >= 0 && state.duration <= 604800 &&
    typeof state.paused === 'boolean' && typeof state.ready === 'boolean' &&
    (!state.ready || state.duration > 0) &&
    Number.isInteger(state.index) && validQueue(state.queue) && state.index >= 0 && state.index < state.queue.length &&
    state.queue[state.index].videoId === state.videoId &&
    ['NONE', 'ONE', 'ALL'].includes(state.repeat) && typeof state.shuffle === 'boolean';
}

export function validState(state) {
  // A canonical loading snapshot can have no duration yet. It must stay paused
  // until a matching native player has loaded the selected song.
  return validCommand(state) && (state.duration > 0 || (state.paused && !state.ready));
}

export function queueSignature(queue) {
  return JSON.stringify(queue.map(item => [item.key, item.videoId]));
}

export function positionAt(state, now = Date.now()) {
  return Math.min(state.duration, Math.max(0, state.position + (state.paused ? 0 : Math.max(0, now - state.at) / 1000)));
}

// Apply removals/reordering while retaining additions accepted since the sender's base.
export function mergeQueue(before, after, current, replace = false) {
  if (replace) return after;
  const beforeKeys = new Set(before.map(item => item.key));
  const afterKeys = new Set(after.map(item => item.key));
  const currentMap = new Map(current.map(item => [item.key, item]));
  const result = after.filter(item => !beforeKeys.has(item.key) || currentMap.has(item.key));
  for (let i = 0; i < current.length; i++) {
    const item = current[i];
    if (beforeKeys.has(item.key) || afterKeys.has(item.key)) continue;
    const next = current.slice(i + 1).find(candidate => result.some(entry => entry.key === candidate.key));
    const target = next ? result.findIndex(candidate => candidate.key === next.key) : result.length;
    result.splice(target, 0, item);
  }
  return result;
}
