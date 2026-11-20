// LTC's price in USD, for an estimate next to LTC amounts, for the page and
// the watchtower alike. Never a price for DLR. From litecoinspace.org, and
// while it has none recent enough, from the next source in line: a source
// can answer and still be stuck on an old price.

/** A price older than this many seconds is not shown. */
export const MAX_PRICE_AGE = 2 * 3600;

/** litecoinspace.org's shape, `{ "time": …, "USD": … }`, which a test setup's own source answers in too. */
const plain = (a) => ({ usd: Number(a?.USD), time: Number(a?.time) });

export const PRICE_SOURCES = [
  { url: 'https://litecoinspace.org/api/v1/prices', read: plain },
  { url: 'https://api.exchange.coinbase.com/products/LTC-USD/ticker', read: (a) => ({ usd: Number(a?.price), time: Math.floor(Date.parse(a?.time) / 1000) }) },
  {
    url: 'https://api.coingecko.com/api/v3/simple/price?ids=litecoin&vs_currencies=usd&include_last_updated_at=true',
    read: (a) => ({ usd: Number(a?.litecoin?.usd), time: Number(a?.litecoin?.last_updated_at) }),
  },
];

/** A source of litecoinspace.org's shape at `url`. */
export const plainSource = (url) => ({ url, read: plain });

/**
 * The first price at most `maxAge` seconds old, in the sources' order:
 * `{ url, usd, time }`, or null when none has one. Never throws.
 */
export async function readPrice(sources, { maxAge, now = Math.floor(Date.now() / 1000) }) {
  for (const s of sources) {
    try {
      const response = await fetch(s.url, { cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(10_000) });
      if (!response.ok) continue;
      const { usd, time } = s.read(await response.json());
      if (Number.isFinite(usd) && usd > 0 && Number.isInteger(time) && time > 0 && now - time <= maxAge) return { url: s.url, usd, time };
    } catch { /* the next source */ }
  }
  return null;
}
