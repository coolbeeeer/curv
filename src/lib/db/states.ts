import { query } from './index';

/**
 * Latest sampled on-chain state per pool, the read model every user-facing
 * API serves from. Written ONLY by the background indexer
 * (src/indexer.ts), which calls fetchPoolLiveState once per pool per
 * interval. API routes never write here and never read the chain.
 *
 * Failure handling: a failed sample never overwrites the last good one.
 * It only advances last_attempt_at and bumps consecutive_failures, so the
 * API keeps serving the most recent real values with stale: true instead
 * of blanking the pool or inventing numbers.
 */

export interface PoolStateSample {
  /** Quote tokens per 1 base token. Null when unreadable. */
  price: number | null;
  /** Quote reserve in UI units. */
  quoteReserve: number | null;
  /** Base reserve in UI units. */
  baseReserve: number | null;
  /** 0-100 progress toward the migration (graduation) threshold. */
  progress: number | null;
  graduated: boolean;
  hasSwap: boolean;
  /** Market cap denominated in quote tokens. */
  marketCap: number | null;
  baseDecimals: number;
  quoteDecimals: number;
  /** Migration threshold in quote UI units. */
  migrationQuoteThreshold: number | null;
  /**
   * Accrued creator trading fees in RAW integer units (decimal strings).
   * Kept as strings end-to-end: u64 values can exceed float precision,
   * so they are never converted to numbers until display formatting.
   * Optional for backward compatibility; missing normalizes to null.
   */
  creatorBaseFeeRaw?: string | null;
  /** Accrued creator quote fee in raw integer units (decimal string). */
  creatorQuoteFeeRaw?: string | null;
}

export interface StoredPoolState extends PoolStateSample {
  poolAddress: string;
  /** Unix ms of the last SUCCESSFUL sample; null when never sampled. */
  sampledAt: number | null;
  /** Unix ms of the last attempt (success or failure). */
  lastAttemptAt: number | null;
  consecutiveFailures: number;
  /** First-seen graduation timestamp; null until the pool graduates. */
  graduatedAt: number | null;
}

interface StateRow {
  pool_address: string;
  price: number | null;
  quote_reserve: number | null;
  base_reserve: number | null;
  progress: number | null;
  graduated: number;
  graduated_at: number | null;
  has_swap: number;
  market_cap: number | null;
  base_decimals: number;
  quote_decimals: number;
  migration_quote_threshold: number | null;
  creator_base_fee_raw: string | null;
  creator_quote_fee_raw: string | null;
  sampled_at: number | null;
  last_attempt_at: number | null;
  consecutive_failures: number;
}

function rowToState(r: StateRow): StoredPoolState {
  return {
    poolAddress: r.pool_address,
    price: r.price,
    quoteReserve: r.quote_reserve,
    baseReserve: r.base_reserve,
    progress: r.progress,
    graduated: r.graduated === 1,
    hasSwap: r.has_swap === 1,
    marketCap: r.market_cap,
    baseDecimals: r.base_decimals,
    quoteDecimals: r.quote_decimals,
    migrationQuoteThreshold: r.migration_quote_threshold,
    creatorBaseFeeRaw: r.creator_base_fee_raw,
    creatorQuoteFeeRaw: r.creator_quote_fee_raw,
    sampledAt: r.sampled_at,
    lastAttemptAt: r.last_attempt_at,
    consecutiveFailures: r.consecutive_failures,
    graduatedAt: r.graduated_at == null ? null : Number(r.graduated_at),
  };
}

export async function getPoolState(poolAddress: string): Promise<StoredPoolState | null> {
  const rows = await query<StateRow>('SELECT * FROM pool_states WHERE pool_address = $1', [
    poolAddress,
  ]);
  return rows[0] ? rowToState(rows[0]) : null;
}

/**
 * Batch version of getPoolState: one query per chunk instead of one per
 * pool. The list endpoint serves thousands of pools; N+1 here is the
 * difference between ~70 req/s and ~5 req/s. Results identical to calling
 * getPoolState per address (pools with no row are absent from the map).
 */
export async function getPoolStatesBatch(
  poolAddresses: string[],
): Promise<Map<string, StoredPoolState>> {
  const out = new Map<string, StoredPoolState>();
  for (const chunk of chunkArray([...new Set(poolAddresses)], 500)) {
    const placeholders = chunk.map((_, i) => `$${i + 1}`).join(',');
    const rows = await query<StateRow>(
      `SELECT * FROM pool_states WHERE pool_address IN (${placeholders})`,
      chunk,
    );
    for (const row of rows) out.set(row.pool_address, rowToState(row));
  }
  return out;
}

/** Split an array into chunks of at most `size` (for IN (...) batching). */
export function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

/**
 * Record one indexer sample. Pass `sample: null` when the on-chain read
 * failed: the last good values are preserved and only the attempt
 * bookkeeping advances. Portable ON CONFLICT upsert (SQLite + Postgres).
 */
export async function recordPoolSample(
  poolAddress: string,
  sample: PoolStateSample | null,
  atMs: number,
): Promise<void> {
  if (sample) {
    await query(
      `INSERT INTO pool_states
       (pool_address, price, quote_reserve, base_reserve, progress, graduated,
        has_swap, market_cap, base_decimals, quote_decimals,
        migration_quote_threshold, creator_base_fee_raw, creator_quote_fee_raw,
        sampled_at, last_attempt_at, consecutive_failures,
        graduated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 0,
        CASE WHEN $6::bigint = 1 THEN $14::bigint ELSE NULL END)
       ON CONFLICT (pool_address) DO UPDATE SET
         price = excluded.price,
         quote_reserve = excluded.quote_reserve,
         base_reserve = excluded.base_reserve,
         progress = excluded.progress,
         graduated = excluded.graduated,
         -- First-seen graduation timestamp: set once, never overwritten.
         -- Lets the duel keeper answer "who graduated first" from the DB.
         graduated_at = CASE
           WHEN excluded.graduated = 1 AND pool_states.graduated_at IS NULL
           THEN excluded.sampled_at
           ELSE pool_states.graduated_at
         END,
         has_swap = excluded.has_swap,
         market_cap = excluded.market_cap,
         base_decimals = excluded.base_decimals,
         quote_decimals = excluded.quote_decimals,
         migration_quote_threshold = excluded.migration_quote_threshold,
         creator_base_fee_raw = excluded.creator_base_fee_raw,
         creator_quote_fee_raw = excluded.creator_quote_fee_raw,
         sampled_at = excluded.sampled_at,
         last_attempt_at = excluded.last_attempt_at,
         consecutive_failures = 0`,
      [
        poolAddress,
        sample.price,
        sample.quoteReserve,
        sample.baseReserve,
        sample.progress,
        sample.graduated ? 1 : 0,
        sample.hasSwap ? 1 : 0,
        sample.marketCap,
        sample.baseDecimals,
        sample.quoteDecimals,
        sample.migrationQuoteThreshold,
        sample.creatorBaseFeeRaw ?? null,
        sample.creatorQuoteFeeRaw ?? null,
        atMs,
        atMs,
      ],
    );
  } else {
    await query(
      `INSERT INTO pool_states (pool_address, last_attempt_at, consecutive_failures)
       VALUES ($1, $2, 1)
       ON CONFLICT (pool_address) DO UPDATE SET
         last_attempt_at = excluded.last_attempt_at,
         consecutive_failures = pool_states.consecutive_failures + 1`,
      [poolAddress, atMs],
    );
  }
}
