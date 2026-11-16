// What the watchtower keeps between runs, in one JSON file: who watches what,
// the feed message of each listing, the reminders sent, what it sent, and
// the Litecoin outputs it read.
// Nothing in it is secret, and losing it loses only that bookkeeping.
import { readFileSync, renameSync, writeFileSync } from 'node:fs';

export const empty = () => ({ version: 1, feed: {}, watch: {}, sent: {}, claims: {}, refunds: {}, outs: {} });

export function load(path) {
  try {
    const s = JSON.parse(readFileSync(path, 'utf8'));
    if (s?.version !== 1) throw new Error(`a state file of version ${s?.version}`);
    return { ...empty(), ...s };
  } catch (e) {
    if (e.code === 'ENOENT') return empty();
    throw e;
  }
}

/** Writes the state whole, through a file beside it, so that a crash never leaves half of one. */
export function save(path, state) {
  writeFileSync(`${path}.tmp`, JSON.stringify(state, null, 1));
  renameSync(`${path}.tmp`, path);
}

/** The watchers of a listing, `[user, role]`. */
export const watchersOf = (state, id) => Object.entries(state.watch[id] ?? {});

export function watch(state, user, id, role) {
  (state.watch[id] ??= {})[user] = role;
}

export function unwatch(state, user, id) {
  if (!state.watch[id]) return;
  delete state.watch[id][user];
  if (!Object.keys(state.watch[id]).length) delete state.watch[id];
}

export const watching = (state, user) => Object.entries(state.watch).filter(([, w]) => w[user]).map(([id, w]) => [Number(id), w[user]]);

export const sentKey = (user, id, key) => `${user}|${id}|${key}`;
