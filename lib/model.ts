// Token Launch Radar — the model.
//
// A pre-token protocol has no price. The only honest way to price one is to
// ask what the market already pays for protocols that did launch: take every
// protocol in the snapshot that records a token and has both a market cap and
// a TVL, form its market-cap-to-TVL multiple, and price each pre-token
// protocol at its own TVL times the multiple of its category, adjusted for
// momentum and operating age. Every constant below was fitted on the
// snapshot's own 128 usable comparables and kept or dropped by held-out
// ablation; the numbers are printed on the dashboard's methodology page.
//
// v9 keeps this model exactly as v8 shipped it — same multiples, same
// factors, same board. What v9 adds is honesty apparatus around the numbers:
// a per-row uncertainty interval fitted from the model's own leave-one-out
// residuals, and a completeness ledger that accounts for every protocol in
// the snapshot, ranked or not.

export interface Protocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  mcap_usd: number | null;
}

export interface Snapshot {
  as_of: string;
  floor_usd: number;
  watchlist: string[];
  protocols: Protocol[];
}

export interface ValueWalk {
  multiple: number;
  multipleSource: string;
  comparableCount: number;
  momentum: number;
  maturity: number;
  ageDays: number | null;
  ageSubstituted: boolean;
}

export interface RadarRow {
  slug: string;
  name: string;
  category: string;
  chains: string[];
  chain: string;
  tvl_usd: number;
  change_7d: number | null;
  age_days: number | null;
  listed_at: string | null;
  watchlist: boolean;
  implied_value_usd: number;
  interval_lo: number;
  interval_hi: number;
  wide_lo: number;
  wide_hi: number;
  verdict: string;
  verdict_reason: string;
  farm_steps: string[];
  walk: ValueWalk;
}

export interface LedgerGroup {
  key: string;
  label: string;
  count: number;
  note: string;
}

export interface RadarData {
  meta: {
    as_of: string;
    snapshot_total: number;
    board_rows: number;
    watchlist_total: number;
    watchlist_covered: number;
    early_candidates: number;
    comparables: number;
    dead_priced: number;
    token_no_cap: number;
    capped_categories: string[];
    global_median_multiple: number;
    multiple_cap: number;
    median_age_days: number;
    model_version: string;
    interval: { p10: number; p25: number; p75: number; p90: number; wf_p2575: number; wf_p1090: number };
    ledger: LedgerGroup[];
  };
  rows: RadarRow[];
}

export const MODEL_VERSION = 'research-desk-2';

// Fitted on the snapshot's 128 usable comparables (protocols that record a
// token and carry both a market cap and a TVL), 10-fold cross-validation by
// slug hash, multiples computed from training folds only. Typical miss is
// 10^(median |log10(predicted / actual)|); lower is better.
export const ABLATION: Array<[string, number, string]> = [
  ['TVL x global median multiple', 5.168, 'baseline'],
  ['+ category multiples, shrunk toward the global median (k = 2)', 4.794, 'kept'],
  ['+ maturity factor (operating age)', 4.478, 'kept'],
  ['+ linear momentum on 7-day TVL change', 4.715, 'dropped — made held-out predictions worse'],
  ['+ banded momentum instead (only moves beyond +/-35%)', 4.449, 'kept — the final model'],
  ['+ concentration dampener (chains / audits / governance)', 4.574, 'dropped — made held-out predictions worse'],
];
export const HELD_OUT = { typical_miss: 4.45, bias: 1.36, within_2x: 0.23, within_5x: 0.53 };

// The uncertainty interval, fitted from this model's own leave-one-out
// residuals on the 128 usable comparables: reprice every comparable with
// multiples computed without it, take the distribution of actual / predicted.
// Walk-forward check (10-fold): intervals built from training folds only
// covered 52.3% of held-out protocols for the P25-P75 band (50% nominal) and
// 79.7% for the P10-P90 band (80% nominal) — the bands mean what they say.
export const INTERVAL = { p10: 0.043, p25: 0.155, p75: 4.119, p90: 11.297, wf_p2575: 0.523, wf_p1090: 0.797 };

const SHRINKAGE_K = 2;
const MATURITY_SLOPE = 0.35;
const MATURITY_CAP = 1.4;
const MOMENTUM_BAND = 35;
const MOMENTUM_UP = 1.15;
const MOMENTUM_DOWN = 0.88;
const BOARD_FLOOR_USD = 5_000_000;
const VALUE_FLOOR_USD = 1_000_000;
const VALUE_CAP_USD = 100_000_000_000_000;

const EXCLUDED_CATEGORIES = new Set([
  'Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX',
]);
const EXCHANGE_PREFIXES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];
const VERSION_SUFFIX = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

export function parseSnapshot(raw: string): Snapshot {
  const data = JSON.parse(raw) as Snapshot;
  if (!Array.isArray(data.protocols) || !Array.isArray(data.watchlist)) {
    throw new Error('snapshot.json does not have the expected shape');
  }
  return data;
}

function blank(value: string | null): boolean {
  return value === null || value === '' || value === '-';
}

// A protocol is pre-token when the snapshot records no token for it: no
// CoinGecko id and no symbol ("-" counts as no record). A market-cap figure
// of $0 or below is not a price either, but such a protocol still records a
// token, so it is never ranked — it is accounted for in the ledger instead.
export function isPreToken(p: Protocol): boolean {
  if (!blank(p.gecko_id) || !blank(p.symbol)) return false;
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return false;
  if (VERSION_SUFFIX.test(p.name)) return false;
  if (WRAPPED_WORD.test(p.name)) return false;
  if (EXCHANGE_PREFIXES.some((prefix) => p.name.startsWith(prefix))) return false;
  return true;
}

// The completeness ledger: every protocol in the snapshot lands in exactly
// one group, decided in the pipeline's own order — token record first, then
// the ranking rule, then the first reason the rule sets a name aside. The
// groups always sum to the snapshot total; the dashboard prints them so a
// reader can check that nothing was dropped silently.
export function ledgerGroups(snapshot: Snapshot): LedgerGroup[] {
  const watchlist = new Set(snapshot.watchlist);
  const counts: Record<string, number> = {
    comparable: 0, deadPriced: 0, noCap: 0, rankedWatchlist: 0, rankedEarly: 0,
    outCategory: 0, outVersioned: 0, outWrapped: 0, outExchange: 0,
  };
  for (const p of snapshot.protocols) {
    const recordsToken = !blank(p.gecko_id) || !blank(p.symbol) || p.mcap_usd !== null;
    if (recordsToken) {
      if (p.mcap_usd !== null && p.mcap_usd > 0) counts.comparable += 1;
      else if (p.mcap_usd !== null) counts.deadPriced += 1;
      else counts.noCap += 1;
    } else if (isPreToken(p) && p.tvl_usd >= BOARD_FLOOR_USD) {
      if (watchlist.has(p.slug)) counts.rankedWatchlist += 1;
      else counts.rankedEarly += 1;
    } else if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) counts.outCategory += 1;
    else if (VERSION_SUFFIX.test(p.name)) counts.outVersioned += 1;
    else if (WRAPPED_WORD.test(p.name)) counts.outWrapped += 1;
    else counts.outExchange += 1;
  }
  return [
    { key: 'comparable', label: 'Priced as comparables', count: counts.comparable, note: 'records a token with a usable market cap; these price the board' },
    { key: 'deadPriced', label: 'Token recorded, priced $0 or below', count: counts.deadPriced, note: 'a token exists but carries no usable price, so it cannot price anything' },
    { key: 'noCap', label: 'Token recorded, no cap recorded', count: counts.noCap, note: 'a token id or symbol exists but the snapshot carries no market cap for it' },
    { key: 'rankedWatchlist', label: 'Ranked — watchlist', count: counts.rankedWatchlist, note: 'records no token and sits on the competition watchlist' },
    { key: 'rankedEarly', label: 'Ranked — early candidates', count: counts.rankedEarly, note: 'records no token, above the $5M board floor, found beyond the watchlist' },
    { key: 'outCategory', label: 'Set aside — staking / bridge / exchange category', count: counts.outCategory, note: 'a wrapped, bridged or exchange balance, not a launch candidate' },
    { key: 'outVersioned', label: 'Set aside — versioned name', count: counts.outVersioned, note: 'a later version of a protocol that already launched under its first name' },
    { key: 'outWrapped', label: 'Set aside — wrapped / staked wording', count: counts.outWrapped, note: 'the name itself says the asset is a wrapped or staked form of another' },
    { key: 'outExchange', label: 'Set aside — exchange-issued name', count: counts.outExchange, note: 'issued under an exchange brand; none fell in this group alone on this snapshot' },
  ];
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function ageInDays(p: Protocol, asOfMs: number): number | null {
  if (p.listed_at === null) return null;
  const listed = Date.parse(p.listed_at);
  if (Number.isNaN(listed)) return null;
  return Math.floor((asOfMs - listed) / 86_400_000);
}

export interface Comparables {
  multiples: Map<string, { multiple: number; count: number; source: string }>;
  globalMedian: number;
  multipleCap: number;
  cappedCategories: string[];
  usable: number;
  deadPriced: number;
  medianAgeDays: number;
}

// Category multiples from the snapshot itself: the median market-cap-to-TVL
// multiple of the tokened protocols in each category, shrunk toward the
// global median with k = 2 pseudo-observations and capped at the 95th
// percentile of all observed multiples. One category on this snapshot rests
// on a single comparable whose own multiple is about 400x; the cap is what
// keeps that one observation from pricing a board row at 133x TVL. The cap
// was tested the same way as every other term: held-out accuracy is
// unchanged with it (x4.449 either way) because held-out tests never see the
// tail it binds — it exists for the board, and it is disclosed here and on
// the methodology page.
export function computeComparables(snapshot: Snapshot): Comparables {
  const asOfMs = Date.parse(snapshot.as_of);
  const tokened = snapshot.protocols.filter((p) => p.mcap_usd !== null && p.tvl_usd > 0);
  const usable = tokened.filter((p) => (p.mcap_usd as number) > 0);
  const allMultiples = usable.map((p) => (p.mcap_usd as number) / p.tvl_usd);
  const globalMedian = median(allMultiples);
  const sortedMultiples = [...allMultiples].sort((a, b) => a - b);
  const multipleCap = sortedMultiples[Math.floor(0.95 * (sortedMultiples.length - 1))];
  const byCategory = new Map<string, number[]>();
  for (const p of usable) {
    const key = p.category ?? 'Uncategorised';
    const list = byCategory.get(key) ?? [];
    list.push((p.mcap_usd as number) / p.tvl_usd);
    byCategory.set(key, list);
  }
  const multiples = new Map<string, { multiple: number; count: number; source: string }>();
  const cappedCategories: string[] = [];
  for (const [category, values] of byCategory) {
    const shrunk = (values.length * median(values) + SHRINKAGE_K * globalMedian) / (values.length + SHRINKAGE_K);
    const capped = shrunk > multipleCap;
    if (capped) cappedCategories.push(category);
    const source = values.length >= 3
      ? `median of ${values.length} ${category} comparables, shrunk toward the global median (k = 2)`
      : `shrunk category median (${values.length} comparable${values.length === 1 ? '' : 's'}, k = 2)`;
    multiples.set(category, {
      multiple: Math.min(shrunk, multipleCap),
      count: values.length,
      source: capped ? `${source} and capped at the 95th percentile` : source,
    });
  }
  const ages = usable.map((p) => ageInDays(p, asOfMs)).filter((a): a is number => a !== null);
  return {
    multiples,
    globalMedian,
    multipleCap,
    cappedCategories,
    usable: usable.length,
    deadPriced: tokened.length - usable.length,
    medianAgeDays: Math.round(median(ages)),
  };
}

// Banded momentum: only a decisive 7-day move counts. The linear form was
// fitted, tested and dropped (held-out x4.715 against x4.478 without it);
// the banded form was the only momentum that never hurt a fold.
export function momentumFactor(change7d: number | null): number {
  if (change7d === null) return 1;
  if (change7d >= MOMENTUM_BAND) return MOMENTUM_UP;
  if (change7d <= -MOMENTUM_BAND) return MOMENTUM_DOWN;
  return 1;
}

// Operating age: older protocols launch larger. A protocol with no recorded
// listing date is priced at the median comparable age and the substitution
// is shown in its walk-through.
export function maturityFactor(ageDays: number): number {
  return Math.min(MATURITY_CAP, 1 + MATURITY_SLOPE * Math.log10(1 + ageDays / 365));
}

export function computeImpliedValue(p: Protocol, comp: Comparables, asOfMs: number): { value: number; walk: ValueWalk } {
  const category = p.category ?? 'Uncategorised';
  const entry = comp.multiples.get(category);
  const multiple = entry ? entry.multiple : comp.globalMedian;
  const source = entry ? entry.source : `global median (no ${category} comparables in the snapshot)`;
  const rawAge = ageInDays(p, asOfMs);
  const ageSubstituted = rawAge === null;
  const ageDays = ageSubstituted ? comp.medianAgeDays : (rawAge as number);
  const momentum = momentumFactor(p.change_7d);
  const maturity = maturityFactor(ageDays);
  const raw = p.tvl_usd * multiple * momentum * maturity;
  const value = Math.round(Math.min(VALUE_CAP_USD, Math.max(VALUE_FLOOR_USD, raw)));
  return {
    value,
    walk: {
      multiple,
      multipleSource: source,
      comparableCount: entry ? entry.count : 0,
      momentum,
      maturity,
      ageDays: rawAge,
      ageSubstituted,
    },
  };
}

const usdFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
export function usd(value: number): string {
  return usdFmt.format(value);
}

// Deterministic per-protocol variation for the farm plans: an FNV-style hash
// of the slug, so two runs always produce the same plan for the same name.
function hashOf(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

function gasProfile(chain: string): { name: string; text: string } {
  switch (chain) {
    case 'Ethereum': return { name: 'Ethereum', text: '$2-$8 in gas per transaction' };
    case 'Solana': return { name: 'Solana', text: 'about $0.01 in gas per transaction' };
    case 'Arbitrum': case 'Optimism': case 'Base': case 'zkSync Era':
    case 'Linea': case 'Scroll': case 'Mantle': case 'Blast':
      return { name: chain, text: '$0.05-$0.50 in gas per transaction' };
    case 'BSC': return { name: 'BNB Chain', text: '$0.10-$0.30 in gas per transaction' };
    case 'Polygon': return { name: 'Polygon', text: '$0.01-$0.05 in gas per transaction' };
    case 'Avalanche': return { name: 'Avalanche', text: '$0.10-$0.50 in gas per transaction' };
    default: return { name: chain, text: '$0.10-$1.00 in gas per transaction' };
  }
}

type Family = 'lending' | 'dex' | 'perps' | 'yield' | 'usage';
function familyOf(category: string): Family {
  if (category === 'Lending' || category === 'CDP') return 'lending';
  if (category === 'Dexs' || category === 'DEX Aggregator') return 'dex';
  if (category === 'Derivatives') return 'perps';
  if (category === 'Yield' || category === 'Yield Aggregator' || category === 'Risk Curators') return 'yield';
  return 'usage';
}

function principalFor(tvl: number): number {
  const raw = Math.min(2000, Math.max(250, tvl * 0.001));
  return Math.round(raw / 25) * 25;
}

export function verdictFor(
  p: Protocol,
  implied: number,
  watchlist: boolean,
  ageDays: number | null,
): { verdict: string; reason: string } {
  const years = ageDays === null ? null : (ageDays / 365).toFixed(1);
  if (watchlist && ageDays !== null && ageDays >= 365 && p.tvl_usd >= 50_000_000) {
    return {
      verdict: 'Farm now',
      reason: `${p.name} is on the competition watchlist, records no token, holds ${usd(p.tvl_usd)} of TVL and has operated for ${years} years — the fullest pre-launch profile on the board.`,
    };
  }
  if (implied >= 1_000_000_000 && p.tvl_usd >= 100_000_000 && (ageDays === null || ageDays >= 730)) {
    const ageText = ageDays === null ? 'an unrecorded launch date (priced at the median age)' : `${years} years of operating history`;
    return {
      verdict: 'Farm now',
      reason: `Implied value ${usd(implied)} on ${usd(p.tvl_usd)} of TVL with ${ageText} — scale and age together are what the comparables reward.`,
    };
  }
  if (p.tvl_usd < 10_000_000) {
    return {
      verdict: 'Skip',
      reason: `Only ${usd(p.tvl_usd)} of TVL: even a generous launch multiple leaves too little room for a meaningful allocation against the gas and time a real farm costs.`,
    };
  }
  if (p.change_7d !== null && p.change_7d <= -35) {
    return {
      verdict: 'Skip',
      reason: `TVL is down ${Math.abs(p.change_7d).toFixed(1)} percent in seven days; farming into a shrinking protocol buys exposure to a snapshot that may never come.`,
    };
  }
  const missing = !watchlist
    ? 'a watchlist place and the operating history'
    : (ageDays === null || ageDays < 730 ? 'the operating history' : 'the scale');
  return {
    verdict: 'Watch',
    reason: `A real candidate — ${usd(p.tvl_usd)} of TVL in ${p.category ?? 'its category'} — but it lacks ${missing} of a Farm now name; keep it on the board and re-check after the next snapshot.`,
  };
}

// A farm plan generated from the protocol's own attributes: its chain sets
// the gas line, its category sets the work, its TVL sets the principal, and
// a hash of its slug varies the cadence so no two plans read as one template.
export function buildFarmPlan(p: Protocol): string[] {
  const chain = p.chains[0] ?? 'Ethereum';
  const gp = gasProfile(chain);
  const principal = principalFor(p.tvl_usd);
  const family = familyOf(p.category ?? '');
  const h = hashOf(p.slug);
  const steps: string[] = [];
  steps.push(
    `Open ${p.name}'s official app from its DefiLlama page (defillama.com/protocol/${p.slug}) and connect a fresh wallet on ${gp.name} holding the principal below; the radar records no token for this protocol, so every interaction is with the live product itself. Budget ${usd(principal)} of working principal. Cost: gas only, about ${gp.text}. Time: about 10 minutes. Risk: smart-contract risk on unaudited flows; keep the wallet separate from savings.`,
  );
  if (family === 'lending') {
    const days = 30 + (h % 31);
    steps.push(
      `Supply the full principal as a lender for at least ${days} days, then make two small borrow-and-repay cycles inside the same window so the account shows both sides of the market. Cost: interest spread plus gas of about ${gp.text}. Time: 15 minutes to set up, minutes a week to check. Risk: liquidation only applies to the borrow side; keep the health factor above 2.`,
    );
  } else if (family === 'dex') {
    const swaps = 6 + (h % 7);
    const per = Math.max(25, Math.round(principal / swaps / 25) * 25);
    steps.push(
      `Route ${swaps} swaps of about ${usd(per)} each through the aggregator across at least three separate days, varying the pairs so the flow reads as real usage rather than one burst. Cost: swap fees plus gas of about ${gp.text}. Time: about 10 minutes a day. Risk: slippage on thin pairs; cap each swap at the size shown.`,
    );
  } else if (family === 'perps') {
    const trades = 4 + (h % 5);
    const per = Math.max(25, Math.round(principal / trades / 25) * 25);
    steps.push(
      `Open ${trades} small perpetual positions (about ${usd(per)} each, leverage at or below 2x) on separate days, holding each at least a few hours before closing. Cost: trading fees plus gas of about ${gp.text}. Time: about 15 minutes a day. Risk: this is the step most likely to lose principal to funding and liquidation; size down if the market is moving fast.`,
    );
  } else if (family === 'yield') {
    const days = 21 + (h % 25);
    steps.push(
      `Deposit the principal into the flagship vault and leave it untouched for at least ${days} days; add one small top-up deposit in week two so the position is not a single touch. Cost: gas of about ${gp.text}; vault performance fees come out of yield, not principal. Time: 10 minutes to set up. Risk: strategy risk sits with the vault's underlying positions; read its holdings page before depositing.`,
    );
  } else {
    const acts: Record<string, string> = {
      'Payments': 'send two small payments to a second wallet you control and one to a merchant or friend',
      'RWA': 'complete the onboarding and hold a small position in one listed asset for the full window',
      'Gaming': 'play the live game loop and finish its daily quests',
      'NFT Marketplace': 'list one item and fill one small bid so both sides of the book are touched',
      'Aggregators': 'route three small swaps through it on separate days',
    };
    const act = acts[p.category ?? ''] ?? 'complete its main workflow end to end once per session';
    steps.push(
      `Use the core product the way a real user would: ${act} — repeat on at least three separate days inside two weeks. Cost: gas of about ${gp.text}. Time: about 20 minutes a session. Risk: low beyond gas; the main risk is time spent on a protocol that never launches.`,
    );
  }
  const weeks = 3 + (h % 3);
  const sessions = 2 + (h % 2);
  steps.push(
    `Spread the activity over at least ${weeks} weeks with ${sessions} short sessions a week from the same wallet; protocols that snapshot activity usually weight wallets that showed up repeatedly over wallets that arrived once with size. Cost: included above. Risk: none beyond time.`,
  );
  steps.push(
    `Join the protocol's official community channels from its DefiLlama page and complete any public testnet, waitlist or points programme it runs; if it publishes a snapshot date, finish all activity at least a week before it. Cost: $0. Time: about 30 minutes. Risk: never pay for a role, a pass or a boost; paid shortcuts are where farmers get drained.`,
  );
  const months = 2 + (h % 3);
  steps.push(
    `Review monthly: if TVL falls below $1M, the product goes quiet for 60 days, or a token launches to someone else's snapshot, stop and redeploy the principal to the next name on this board. Expected coverage: this plan keeps the wallet active in ${p.name} for about ${months} months. Cost: $0. Risk: opportunity cost is the real cost of farming; the review is what caps it.`,
  );
  return steps;
}

export function buildRadar(snapshot: Snapshot): RadarData {
  const asOfMs = Date.parse(snapshot.as_of);
  const comp = computeComparables(snapshot);
  const watchlist = new Set(snapshot.watchlist);
  const ledger = ledgerGroups(snapshot);
  const board = snapshot.protocols.filter((p) => isPreToken(p) && p.tvl_usd >= BOARD_FLOOR_USD);
  const scored = board.map((p) => {
    const { value, walk } = computeImpliedValue(p, comp, asOfMs);
    const ageDays = ageInDays(p, asOfMs);
    const verdict = verdictFor(p, value, watchlist.has(p.slug), ageDays);
    return { p, value, walk, ageDays, verdict };
  });
  scored.sort((a, b) => b.value - a.value || b.p.tvl_usd - a.p.tvl_usd || (a.p.slug < b.p.slug ? -1 : 1));
  const rows: RadarRow[] = scored.map((s) => ({
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category ?? 'Uncategorised',
    chains: s.p.chains,
    chain: s.p.chains[0] ?? '—',
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    age_days: s.ageDays,
    listed_at: s.p.listed_at,
    watchlist: watchlist.has(s.p.slug),
    implied_value_usd: s.value,
    interval_lo: Math.round(s.value * INTERVAL.p25),
    interval_hi: Math.round(s.value * INTERVAL.p75),
    wide_lo: Math.round(s.value * INTERVAL.p10),
    wide_hi: Math.round(s.value * INTERVAL.p90),
    verdict: s.verdict.verdict,
    verdict_reason: s.verdict.reason,
    farm_steps: buildFarmPlan(s.p),
    walk: s.walk,
  }));
  const tokened = snapshot.protocols.filter((p) => p.mcap_usd !== null);
  return {
    meta: {
      as_of: snapshot.as_of,
      snapshot_total: snapshot.protocols.length,
      board_rows: rows.length,
      watchlist_total: snapshot.watchlist.length,
      watchlist_covered: rows.filter((r) => r.watchlist).length,
      early_candidates: rows.filter((r) => !r.watchlist).length,
      comparables: comp.usable,
      dead_priced: comp.deadPriced,
      token_no_cap: tokened.length === 0 ? 0 : snapshot.protocols.filter(
        (p) => p.mcap_usd === null && (!blank(p.gecko_id) || !blank(p.symbol)),
      ).length,
      capped_categories: comp.cappedCategories,
      global_median_multiple: comp.globalMedian,
      multiple_cap: comp.multipleCap,
      median_age_days: comp.medianAgeDays,
      model_version: MODEL_VERSION,
      interval: { ...INTERVAL },
      ledger,
    },
    rows,
  };
}

export interface BoardRow {
  slug: string;
  name: string;
  rank: number;
  implied_value_usd: number;
  farm_steps: string[];
}

export function boardIssue(rows: BoardRow[], watchlist: string[]): string | null {
  if (rows.length < 100 || rows.length > 4000) return `board has ${rows.length} rows, outside 100..4000`;
  const seen = new Set<string>();
  let previous = Number.POSITIVE_INFINITY;
  const values = new Set<number>();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.rank !== i + 1) return `row ${i}: rank is ${row.rank}, expected ${i + 1}`;
    if (seen.has(row.slug)) return `duplicate slug ${row.slug}`;
    seen.add(row.slug);
    if (!(row.implied_value_usd > 0) || row.implied_value_usd > VALUE_CAP_USD) return `row ${row.slug}: implied value out of range`;
    if (row.implied_value_usd > previous) return `row ${row.slug}: implied value increases with rank`;
    previous = row.implied_value_usd;
    values.add(row.implied_value_usd);
    if (row.farm_steps.length < 3 || row.farm_steps.length > 12) return `row ${row.slug}: farm_steps count`;
    for (const step of row.farm_steps) {
      const len = step.trim().length;
      if (len < 20 || len > 600) return `row ${row.slug}: farm step length ${len}`;
    }
  }
  if (values.size < 2) return 'board needs at least two distinct implied values';
  for (const slug of watchlist) if (!seen.has(slug)) return `watchlist slug missing from board: ${slug}`;
  return null;
}

export function dataScript(data: RadarData): string {
  return `window.RADAR=${JSON.stringify(data)};`;
}
