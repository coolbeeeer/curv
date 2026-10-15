import type { NextApiRequest, NextApiResponse } from 'next';
import { getTrackedPool } from '@/lib/pool-registry';
import { verifyWalletSignature } from '@/lib/signatures';
import { parseAddress } from '@/lib/api-validation';
import {
  buildDuelActionMessage,
  isFreshTimestamp,
} from '@/lib/signature-messages';
import { createDuel, getActiveDuelForPool } from '@/lib/db/duels';
import { getPoolState } from '@/lib/db/states';
import { hitRateLimit } from '@/lib/db/rate-limits';
import { randomUUID } from 'crypto';
import { insertNotification } from '@/lib/db/notifications';

/**
 * POST /api/duels/challenge
 *
 * Creator A challenges pool B to a duel. A signs the challenge message
 * with the creator wallet of pool A. Both pools must be registered and
 * ungraduated; neither may be in a live duel. Rate-limited to 5 per
 * wallet per day.
 *
 * Body: { poolA, poolB, wallet, timestamp, signature }
 */
export const config = {
  api: { bodyParser: { sizeLimit: '8kb' } },
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const b = req.body ?? {};
  const poolA = parseAddress(b.poolA);
  const poolB = parseAddress(b.poolB);
  const wallet = typeof b.wallet === 'string' ? b.wallet.trim() : '';
  const timestamp = Number(b.timestamp);
  const signature = typeof b.signature === 'string' ? b.signature : '';
  if (!poolA || !poolB) return res.status(400).json({ error: 'Both pool addresses are required' });
  if (poolA === poolB) return res.status(400).json({ error: 'A pool cannot duel itself' });
  if (!wallet || !signature || !isFreshTimestamp(timestamp)) {
    return res.status(400).json({ error: 'Valid wallet, timestamp and signature are required' });
  }

  const trackedA = await getTrackedPool(poolA);
  const trackedB = await getTrackedPool(poolB);
  if (!trackedA || !trackedB) return res.status(404).json({ error: 'Pool not registered' });
  if (wallet.toLowerCase() !== trackedA.creator.toLowerCase()) {
    return res.status(403).json({ error: 'Only the creator of pool A can issue the challenge' });
  }

  const message = buildDuelActionMessage(poolA, poolB, 'challenge', null, timestamp);
  const ok = await verifyWalletSignature(message, signature, wallet);
  if (!ok) return res.status(401).json({ error: 'Invalid signature' });

  const limit = await hitRateLimit(
    `duel-challenge:${wallet.toLowerCase()}`,
    5,
    24 * 3600_000,
    Date.now(),
  );
  if (!limit.allowed) {
    return res.status(429).json({ error: 'Challenge rate limit reached. Try again tomorrow.' });
  }

  for (const [pool, label] of [[poolA, 'A'], [poolB, 'B']] as const) {
    const state = await getPoolState(pool);
    if (state?.graduated) {
      return res.status(400).json({ error: `Pool ${label} has already graduated` });
    }
    if (await getActiveDuelForPool(pool)) {
      return res.status(400).json({ error: `Pool ${label} is already in a live duel` });
    }
  }

  const duel = await createDuel({
    poolA,
    poolB,
    challengerWallet: trackedA.creator,
    challengedWallet: trackedB.creator,
  });

  // Notify the challenged creator's wallet inbox.
  try {
    await insertNotification({
      id: randomUUID(),
      wallet: trackedB.creator,
      type: 'duel_challenge',
      title: 'Duel challenge',
      body: `Your coin was challenged to a coin duel by ${trackedA.baseSymbol ?? 'a rival'}. First to graduate takes the loser's creator fees.`,
      link: `/duels/${duel.id}`,
    });
  } catch {
    // Notifications are best-effort; the duel is already created.
  }

  return res.status(201).json({ duel });
}
