import type { NextApiRequest, NextApiResponse } from 'next';
import { pollGeneration } from '@/lib/music/aceStep';

export interface StatusResponse {
  state: 'pending' | 'complete' | 'error';
  audioUrl?: string;
  message?: string;
}

/**
 * GET /api/music/status?eventId=<id>
 * One short poll of the ACE-Step engine for a submitted generation job.
 */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<StatusResponse>
) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res
      .status(405)
      .json({ state: 'error', message: 'Method not allowed.' });
  }

  const eventId =
    typeof req.query.eventId === 'string' ? req.query.eventId.trim() : '';
  if (!eventId || eventId.length > 128) {
    return res
      .status(400)
      .json({ state: 'error', message: 'A valid eventId is required.' });
  }

  const result = await pollGeneration(eventId);
  if (result.state === 'complete') {
    return res
      .status(200)
      .json({ state: 'complete', audioUrl: result.audioUrl });
  }
  if (result.state === 'error') {
    return res.status(200).json({ state: 'error', message: result.message });
  }
  return res.status(200).json({ state: 'pending' });
}
