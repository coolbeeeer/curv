import type { NextApiRequest, NextApiResponse } from 'next';
import { QUOTA_MESSAGE, submitGeneration } from '@/lib/music/aceStep';

export interface GenerateResponse {
  eventId?: string;
  error?: string;
}

const LANGUAGES = new Set(['en', 'hi']);

function badRequest(res: NextApiResponse<GenerateResponse>, message: string) {
  return res.status(400).json({ error: message });
}

/**
 * POST /api/music/generate
 * Validates the studio form payload, composes the engine style prompt, and
 * submits a job to the ACE-Step engine. Returns { eventId } for polling.
 */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<GenerateResponse>
) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  const body = (req.body ?? {}) as Record<string, unknown>;

  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (title.length > 120)
    return badRequest(res, 'Title is too long (120 characters max).');

  const style = typeof body.style === 'string' ? body.style.trim() : '';
  if (!style) return badRequest(res, 'A style prompt is required.');
  if (style.length > 1000)
    return badRequest(res, 'Style prompt is too long (1000 characters max).');

  const genre = typeof body.genre === 'string' ? body.genre.trim() : '';
  if (genre.length > 60) return badRequest(res, 'Genre is too long.');
  const mood = typeof body.mood === 'string' ? body.mood.trim() : '';
  if (mood.length > 60) return badRequest(res, 'Mood is too long.');

  const instrumental = body.instrumental === true;

  const lyrics = typeof body.lyrics === 'string' ? body.lyrics : '';
  if (lyrics.length > 3000)
    return badRequest(res, 'Lyrics are too long (3000 characters max).');
  if (!instrumental && !lyrics.trim()) {
    return badRequest(
      res,
      'Lyrics are required unless the track is instrumental.'
    );
  }

  const bpm = Number(body.bpm);
  if (!Number.isInteger(bpm) || bpm < 40 || bpm > 240) {
    return badRequest(
      res,
      'Tempo must be a whole BPM value between 40 and 240.'
    );
  }

  const language = typeof body.language === 'string' ? body.language : '';
  if (!LANGUAGES.has(language)) {
    return badRequest(res, 'Language must be one of: en, hi.');
  }

  const durationSec = Number(body.durationSec);
  if (!Number.isInteger(durationSec) || durationSec < 30 || durationSec > 300) {
    return badRequest(
      res,
      'Duration must be a whole number of seconds between 30 and 300.'
    );
  }

  const composedStyle = [
    genre ? `${genre} music` : '',
    mood ? `${mood} mood` : '',
    style,
    instrumental ? 'instrumental, no vocals' : '',
  ]
    .filter(Boolean)
    .join(', ');

  try {
    const eventId = await submitGeneration({
      style: composedStyle,
      lyrics: instrumental ? '' : lyrics,
      bpm,
      language,
      durationSec,
    });
    return res.status(200).json({ eventId });
  } catch (err) {
    const message =
      err instanceof Error && err.message === QUOTA_MESSAGE
        ? QUOTA_MESSAGE
        : 'The music engine could not accept the job. Please try again in a moment.';
    return res.status(502).json({ error: message });
  }
}
