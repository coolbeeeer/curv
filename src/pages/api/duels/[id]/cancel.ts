import type { NextApiRequest, NextApiResponse } from 'next';
import { verifyWalletSignature } from '@/lib/signatures';
import {
  buildDuelActionMessage,
  isFreshTimestamp,
} from '@/lib/signature-messages';
import { cancelDuel, getDuel } from '@/lib/db/duels';

/**
 * POST /api/duels/[id]/cancel
 *
 * The challenger cancels while the duel is still awaiting accept.
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

  const b = req.body ?? {};
  const wallet = typeof b.wallet === 'string' ? b.wallet.trim() : '';
  const timestamp = Number(b.timestamp);
  const signature = typeof b.signature === 'string' ? b.signature : '';
  if (!wallet || !signature || !isFreshTimestamp(timestamp)) {
    return res.status(400).json({ error: 'Valid wallet, timestamp and signature are required' });
  }
  if (wallet.toLowerCase() !== duel.challengerWallet.toLowerCase()) {
    return res.status(403).json({ error: 'Only the challenger can cancel' });
  }

  const message = buildDuelActionMessage(duel.poolA, duel.poolB, 'cancel', duel.id, timestamp);
  const ok = await verifyWalletSignature(message, signature, wallet);
  if (!ok) return res.status(401).json({ error: 'Invalid signature' });

  try {
    const cancelled = await cancelDuel(id);
    return res.status(200).json({ duel: cancelled });
  } catch (e) {
    return res.status(400).json({ error: e instanceof Error ? e.message : 'Cancel failed' });
  }
}
