import type { NextApiRequest, NextApiResponse } from 'next';
import { verifyWalletSignature } from '@/lib/signatures';
import {
  buildDuelActionMessage,
  isFreshTimestamp,
} from '@/lib/signature-messages';
import { acceptDuel, getDuel } from '@/lib/db/duels';
import { getPoolState } from '@/lib/db/states';
import { randomUUID } from 'crypto';
import { insertNotification } from '@/lib/db/notifications';

/**
 * POST /api/duels/[id]/accept
 *
 * The challenged creator accepts. Both pools are re-checked as
 * ungraduated inside the transaction; terms lock on accept
 * (activated_at, expires_at = +30 days).
 *
 * Body: { wallet, timestamp, signature }
 */
export const config = {
  api: { bodyParser: { sizeLimit: '8kb' } },
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const id = Number(req.query.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid duel id' });
  }
  const duel = await getDuel(id);
  if (!duel) return res.status(404).json({ error: 'Duel not found' });
  if (duel.status !== 'challenged') {
    return res.status(400).json({ error: 'Duel is not awaiting accept' });
  }

  const b = req.body ?? {};
  const wallet = typeof b.wallet === 'string' ? b.wallet.trim() : '';
  const timestamp = Number(b.timestamp);
  const signature = typeof b.signature === 'string' ? b.signature : '';
  if (!wallet || !signature || !isFreshTimestamp(timestamp)) {
    return res.status(400).json({ error: 'Valid wallet, timestamp and signature are required' });
  }
  if (wallet.toLowerCase() !== duel.challengedWallet.toLowerCase()) {
    return res.status(403).json({ error: 'Only the challenged creator can accept' });
  }

  const message = buildDuelActionMessage(duel.poolA, duel.poolB, 'accept', duel.id, timestamp);
  const ok = await verifyWalletSignature(message, signature, wallet);
  if (!ok) return res.status(401).json({ error: 'Invalid signature' });

  const isGraduated = async (poolAddress: string): Promise<boolean> => {
    const state = await getPoolState(poolAddress);
    return state?.graduated === true;
  };

  let accepted;
  try {
    accepted = await acceptDuel(id, isGraduated);
  } catch (e) {
    return res.status(400).json({ error: e instanceof Error ? e.message : 'Accept failed' });
  }

  try {
    await insertNotification({
      id: randomUUID(),
      wallet: accepted.challengerWallet,
      type: 'duel_accepted',
      title: 'Duel accepted',
      body: 'The challenge was accepted. First coin to graduate wins.',
      link: `/duels/${accepted.id}`,
    });
  } catch {
    // Best-effort.
  }

  return res.status(200).json({ duel: accepted });
}
