// Discord, with no library: its REST API for the feed and direct messages,
// and its interactions endpoint for the commands and buttons, each request
// checked against the application's Ed25519 public key.
import { createPublicKey, verify } from 'node:crypto';

const API = 'https://discord.com/api/v10';

/** The REST calls the watchtower makes, as its bot. In a dry run it only prints them. */
export class Discord {
  constructor({ token, applicationId, channel, dryRun = false, log = console.log }) {
    this.token = token;
    this.applicationId = applicationId;
    this.channel = channel;
    this.dryRun = dryRun || !token;
    this.log = log;
    this.dms = new Map();
  }

  async request(method, path, body) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await fetch(API + path, {
        method,
        headers: { authorization: `Bot ${this.token}`, 'content-type': 'application/json', 'user-agent': 'DiscordBot (ting-swap-watchtower, 1)' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (response.status === 429) {
        const wait = Number((await response.json().catch(() => ({}))).retry_after ?? 1);
        await new Promise((r) => setTimeout(r, Math.ceil(wait * 1000) + 50));
        continue;
      }
      const answer = response.status === 204 ? null : await response.json().catch(() => null);
      if (!response.ok) throw Object.assign(new Error(`Discord ${response.status}: ${answer?.message ?? 'no message'}`), { status: response.status, code: answer?.code });
      return answer;
    }
    throw new Error('Discord kept saying to wait');
  }

  /** Posts a feed message; its id. */
  async post(message) {
    if (this.dryRun) {
      this.log(`[feed] ${message.embeds[0].title} — ${message.embeds[0].description.replace(/\n/g, ' · ')}`);
      return `dry-${Date.now()}`;
    }
    return (await this.request('POST', `/channels/${this.channel}/messages`, message)).id;
  }

  /** Edits a feed message in place. */
  async edit(id, message) {
    if (this.dryRun) {
      this.log(`[feed edit] ${message.embeds[0].title} — ${message.embeds[0].description.split('\n').at(-1)}`);
      return;
    }
    await this.request('PATCH', `/channels/${this.channel}/messages/${id}`, message);
  }

  /** Sends a direct message; throws (code 50007) when the user does not take them. */
  async dm(user, content) {
    if (this.dryRun) {
      this.log(`[dm ${user}] ${content}`);
      return;
    }
    if (!this.dms.has(user)) this.dms.set(user, (await this.request('POST', '/users/@me/channels', { recipient_id: user })).id);
    await this.request('POST', `/channels/${this.dms.get(user)}/messages`, { content, allowed_mentions: { parse: [] } });
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

/**
 * What to answer an interaction: Discord's ping, a command or a button. `watch`
 * and `unwatch` change the watch list; `welcome(user, id, role)` sends the
 * first direct message and says whether it could. Returns the response body.
 */
export async function answer(interaction, { watch, unwatch, watching, welcome, known }) {
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
  const ok = await welcome(user, id, role);
  if (!ok) return reply('I cannot send you direct messages. Allow direct messages from this server\'s members (the server\'s Privacy settings), then try again.');
  watch(user, id, role);
  return reply(`You get a direct message about listing #${id} at each step that needs you as its ${role}. These are reminders only: your page does the work. \`/unwatch listing:${id}\` stops them.`);
}
