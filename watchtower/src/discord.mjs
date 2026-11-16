// Discord, with no library: its REST API for the feed and direct messages,
// and its interactions endpoint for the commands and buttons, each request
// checked against the application's Ed25519 public key.
import { createPublicKey, verify } from 'node:crypto';

const API = 'https://discord.com/api/v10';

/** How long the watchtower waits out a 429 at most, and how often: a round's claims and refunds do not wait behind Discord. */
const MAX_WAIT = 10;
const ATTEMPTS = 3;

/** Whether Discord's answer means the message is gone: deleted by a moderator, or never there. */
export const gone = (e) => e?.status === 404 || e?.code === 10008;

/**
 * The REST calls the watchtower makes, as its bot. Without a token, or in a
 * dry run, it is not `live`: each call is printed and nothing is made, and the
 * callers keep nothing of it.
 */
export class Discord {
  constructor({ token, applicationId, channel, dryRun = false, log = console.log }) {
    this.token = token;
    this.applicationId = applicationId;
    this.channel = channel;
    this.live = Boolean(token) && !dryRun;
    this.log = log;
    this.dms = new Map();
  }

  async request(method, path, body, { auth = true } = {}) {
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const response = await fetch(API + path, {
        method,
        headers: {
          ...(auth ? { authorization: `Bot ${this.token}` } : {}),
          'content-type': 'application/json', 'user-agent': 'DiscordBot (ting-swap-watchtower, 1)',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (response.status === 429) {
        const wait = Math.min(MAX_WAIT, Number((await response.json().catch(() => ({}))).retry_after ?? 1));
        await new Promise((r) => setTimeout(r, Math.ceil(wait * 1000) + 50));
        continue;
      }
      const answer = response.status === 204 ? null : await response.json().catch(() => null);
      if (!response.ok) throw Object.assign(new Error(`Discord ${response.status}: ${answer?.message ?? 'no message'}`), { status: response.status, code: answer?.code });
      return answer;
    }
    throw new Error('Discord kept saying to wait');
  }

  /** Posts a feed message: its id, or null when not live. */
  async post(message) {
    if (!this.live) {
      this.log(`[feed] ${message.embeds[0].title} — ${message.embeds[0].description.replace(/\n/g, ' · ')}`);
      return null;
    }
    return (await this.request('POST', `/channels/${this.channel}/messages`, message)).id;
  }

  /** Edits a feed message in place; throws, `gone`, when it is not there. */
  async edit(id, message) {
    await this.request('PATCH', `/channels/${this.channel}/messages/${id}`, message);
  }

  /** Sends a direct message; throws (code 50007) when the user does not take them. Whether it was really sent. */
  async dm(user, content) {
    if (!this.live) {
      this.log(`[dm ${user}] ${content}`);
      return false;
    }
    if (!this.dms.has(user)) this.dms.set(user, (await this.request('POST', '/users/@me/channels', { recipient_id: user })).id);
    await this.request('POST', `/channels/${this.dms.get(user)}/messages`, { content, allowed_mentions: { parse: [] } });
    return true;
  }

  /** Replaces a deferred interaction reply with its answer, through the interaction's own token. */
  async followUp(interaction, content) {
    if (!this.live) {
      this.log(`[reply ${interaction.member?.user?.id ?? interaction.user?.id}] ${content}`);
      return;
    }
    await this.request('PATCH', `/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, { content, allowed_mentions: { parse: [] } }, { auth: false });
  }

  /** Registers the slash commands, for the whole application. */
  async register() {
    return this.request('PUT', `/applications/${this.applicationId}/commands`, COMMANDS);
  }
}

const ROLE = { type: 3, name: 'role', description: 'Whether you sell (made the listing) or buy (locked LTC for it)', required: true, choices: [{ name: 'seller', value: 'seller' }, { name: 'buyer', value: 'buyer' }] };
const LISTING = { type: 4, name: 'listing', description: 'The listing number, as in #42', required: true, min_value: 1 };

export const COMMANDS = [
  { name: 'watch', description: 'Get direct messages about a Ting Swap listing at the steps that need you', options: [LISTING, ROLE] },
  { name: 'unwatch', description: 'Stop the direct messages about a listing', options: [LISTING] },
  { name: 'watching', description: 'The listings you get direct messages about' },
];

/** Ed25519's SubjectPublicKeyInfo prefix, so that Node takes the application's raw 32-byte public key. */
const SPKI = Buffer.from('302a300506032b6570032100', 'hex');

/** Whether an interaction request is Discord's: the signature over its timestamp and body. */
export function signedByDiscord(publicKeyHex, signatureHex, timestamp, body) {
  try {
    const key = createPublicKey({ key: Buffer.concat([SPKI, Buffer.from(publicKeyHex, 'hex')]), format: 'der', type: 'spki' });
    return verify(null, Buffer.concat([Buffer.from(timestamp ?? '', 'utf8'), Buffer.from(body)]), key, Buffer.from(signatureHex ?? '', 'hex'));
  } catch {
    return false;
  }
}

/** An ephemeral reply, which only the one who asked sees. */
export const reply = (content) => ({ type: 4, data: { content, flags: 64, allowed_mentions: { parse: [] } } });

/** A deferred ephemeral reply: Discord shows that the bot is working, and the answer replaces it (Discord.followUp). */
export const DEFERRED = { type: 5, data: { flags: 64 } };

/**
 * What to answer an interaction: Discord's ping, a command or a button. `watch`
 * and `unwatch` change the watch list; `welcome(user, id, role)` sends the
 * first direct message and says whether it could. Discord wants an answer
 * within 3 seconds, and a direct message can take longer: watching answers at
 * once with DEFERRED, and `later` is the answer that then replaces it.
 * Returns `{ now, later }`, `later` a function giving the text, or undefined.
 */
export function answer(interaction, hooks) {
  const r = route(interaction, hooks);
  return typeof r === 'function' ? { now: DEFERRED, later: r } : { now: r };
}

function route(interaction, { watch, unwatch, watching, welcome, known }) {
  if (interaction.type === 1) return { type: 1 };
  const user = interaction.member?.user?.id ?? interaction.user?.id;
  if (!user) return reply('No user in this interaction.');
  let id = null;
  let role = null;
  if (interaction.type === 2) {
    const name = interaction.data?.name;
    const opt = (n) => interaction.data?.options?.find((o) => o.name === n)?.value;
    if (name === 'watching') {
      const list = watching(user);
      return reply(list.length ? `You get direct messages about: ${list.map(([i, r]) => `#${i} (${r})`).join(', ')}.` : 'You are not watching any listing.');
    }
    id = Number(opt('listing'));
    if (name === 'unwatch') {
      unwatch(user, id);
      return reply(`No more direct messages about listing #${id}.`);
    }
    if (name !== 'watch') return reply('Not a command of this bot.');
    role = opt('role');
  } else if (interaction.type === 3) {
    const m = /^watch:(\d+):(seller|buyer)$/.exec(interaction.data?.custom_id ?? '');
    if (!m) return reply('Not a button of this bot.');
    id = Number(m[1]);
    role = m[2];
  } else {
    return reply('Not an interaction this bot answers.');
  }
  if (!Number.isSafeInteger(id) || id < 1 || (role !== 'seller' && role !== 'buyer')) return reply('Name a listing and whether you are its seller or a buyer.');
  if (!known(id)) return reply(`There is no listing #${id} of Ting Swap's Litecoin page.`);
  return async () => {
    if (!(await welcome(user, id, role))) return 'I cannot send you direct messages. Allow direct messages from this server\'s members (the server\'s Privacy settings), then try again.';
    watch(user, id, role);
    return `You get a direct message about listing #${id} at each step that needs you as its ${role}. These are reminders only: your page does the work. \`/unwatch listing:${id}\` stops them.`;
  };
}
