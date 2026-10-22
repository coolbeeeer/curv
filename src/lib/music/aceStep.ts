/**
 * ACE-Step engine client for the AI Music Studio (/music).
 *
 * Talks to the public ACE-Step 1.5 Hugging Face Space over its Gradio API.
 * The engine is swappable: point ACESPACE_BASE_URL at any compatible
 * ACE-Step Space (for example one running on your own GPU machine) and
 * nothing else changes. No secrets are needed; the Space is public.
 *
 * Flow: submitGeneration() POSTs to /gradio_api/call/generation_wrapper and
 * returns an event id. pollGeneration() reads that event's SSE stream for a
 * short window and reports pending / complete / error, so the browser can
 * poll our /api/music/status route instead of holding a connection open.
 */

const DEFAULT_BASE_URL = 'https://ace-step-ace-step-v1-5.hf.space';
const ENDPOINT = '/generation_wrapper';

export const QUOTA_MESSAGE =
  'The free engine is out of GPU quota right now. Try again later, or run the studio engine on your own GPU machine.';

function baseUrl(): string {
  const fromEnv = process.env.ACESPACE_BASE_URL?.trim();
  return (fromEnv && fromEnv.length > 0 ? fromEnv : DEFAULT_BASE_URL).replace(
    /\/+$/,
    ''
  );
}

export interface GenerationRequest {
  /** Fully composed style prompt (genre, mood and free text combined). */
  style: string;
  /** Structured lyrics, or an empty string for instrumental tracks. */
  lyrics: string;
  bpm: number;
  /** Engine language code, e.g. "en" or "hi". */
  language: string;
  durationSec: number;
}

export type PollResult =
  | { state: 'pending' }
  | { state: 'complete'; audioUrl: string }
  | { state: 'error'; message: string };

interface GradioParameter {
  parameter_name?: string;
  parameter_default?: unknown;
}

let cachedDefaults: Promise<unknown[]> | null = null;

/** Parameter defaults for /generation_wrapper, in the Space's declared order. */
function loadDefaults(): Promise<unknown[]> {
  if (!cachedDefaults) {
    cachedDefaults = (async () => {
      const res = await fetch(`${baseUrl()}/gradio_api/info`);
      if (!res.ok) {
        throw new Error(
          `Engine info request failed with status ${res.status}.`
        );
      }
      const info = (await res.json()) as {
        named_endpoints?: Record<string, { parameters?: GradioParameter[] }>;
      };
      const params = info.named_endpoints?.[ENDPOINT]?.parameters;
      if (!Array.isArray(params) || params.length === 0) {
        throw new Error(
          'Engine info did not describe the generation endpoint.'
        );
      }
      return params.map((p) => ({
        name: p.parameter_name ?? '',
        value: p.parameter_default ?? null,
      })) as unknown as unknown[];
    })().catch((err) => {
      cachedDefaults = null;
      throw err;
    });
  }
  return cachedDefaults;
}

function isQuotaText(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes('quota') ||
    lower.includes('zerogpu') ||
    lower.includes('zero gpu')
  );
}

async function submitWithModel(
  req: GenerationRequest,
  model: string
): Promise<string> {
  const defaults = (await loadDefaults()) as { name: string; value: unknown }[];
  const overrides: Record<string, unknown> = {
    selected_model: model,
    param_4: req.style,
    param_5: req.lyrics,
    param_6: req.bpm,
    param_9: req.language,
    param_15: req.durationSec,
    param_16: 1,
  };
  const data = defaults.map((entry) =>
    Object.prototype.hasOwnProperty.call(overrides, entry.name)
      ? overrides[entry.name]
      : entry.value
  );

  const res = await fetch(`${baseUrl()}/gradio_api/call${ENDPOINT}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data }),
  });
  const text = await res.text();
  if (!res.ok) {
    if (isQuotaText(text)) throw new Error(QUOTA_MESSAGE);
    throw new Error(`Engine submit failed with status ${res.status}.`);
  }
  let parsed: { event_id?: string };
  try {
    parsed = JSON.parse(text) as { event_id?: string };
  } catch {
    throw new Error('Engine submit returned an unreadable response.');
  }
  if (!parsed.event_id) {
    if (isQuotaText(text)) throw new Error(QUOTA_MESSAGE);
    throw new Error('Engine submit did not return a job id.');
  }
  return parsed.event_id;
}

/**
 * Submit a generation job. Tries the XL model first and falls back to the
 * smaller turbo model if the submit fails. Returns the Gradio event id.
 */
export async function submitGeneration(
  req: GenerationRequest
): Promise<string> {
  try {
    return await submitWithModel(req, 'acestep-v15-xl-turbo');
  } catch (firstErr) {
    if (firstErr instanceof Error && firstErr.message === QUOTA_MESSAGE)
      throw firstErr;
    return submitWithModel(req, 'acestep-v15-turbo');
  }
}

interface FileDataLike {
  path?: string;
  url?: string;
}

function findAudioUrl(data: unknown): string | null {
  if (!Array.isArray(data)) return null;
  for (const item of data) {
    if (item && typeof item === 'object') {
      const file = item as FileDataLike;
      if (typeof file.url === 'string' && file.url.length > 0) {
        return file.url.startsWith('http')
          ? file.url
          : `${baseUrl()}${file.url}`;
      }
      if (typeof file.path === 'string' && file.path.length > 0) {
        return `${baseUrl()}/gradio_api/file=${file.path}`;
      }
    }
  }
  return null;
}

function parseTerminalEvent(text: string): PollResult | null {
  if (text.includes('event: error')) {
    return {
      state: 'error',
      message: isQuotaText(text)
        ? QUOTA_MESSAGE
        : 'The music engine reported an error. Please try again.',
    };
  }
  if (!text.includes('event: complete')) return null;

  // The complete event carries the outputs as a JSON array on its data: line.
  const dataLines = text
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim());
  for (let i = dataLines.length - 1; i >= 0; i--) {
    try {
      const audioUrl = findAudioUrl(JSON.parse(dataLines[i]));
      if (audioUrl) return { state: 'complete', audioUrl };
    } catch {
      // Not the payload line; keep looking.
    }
  }
  return {
    state: 'error',
    message:
      'The engine finished but returned no audio file. Please try again.',
  };
}

/**
 * Read one event stream for up to ~20 seconds. Gradio holds the stream open
 * until the job finishes, so we abort as soon as a terminal event arrives or
 * the window elapses, and report pending in the latter case.
 */
export async function pollGeneration(eventId: string): Promise<PollResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  let text = '';
  try {
    const res = await fetch(
      `${baseUrl()}/gradio_api/call${ENDPOINT}/${eventId}`,
      {
        signal: controller.signal,
      }
    );
    if (!res.ok) {
      if (res.status === 404) {
        return {
          state: 'error',
          message: 'That generation job was not found. Please generate again.',
        };
      }
      return { state: 'pending' };
    }
    if (!res.body) return { state: 'pending' };
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      const terminal = parseTerminalEvent(text);
      if (terminal) {
        controller.abort();
        return terminal;
      }
    }
  } catch {
    // Aborted by our own timer or by finding a terminal event mid-stream:
    // whatever accumulated decides, otherwise the job is still running.
    const terminal = parseTerminalEvent(text);
    if (terminal) return terminal;
    return { state: 'pending' };
  } finally {
    clearTimeout(timer);
  }
  const terminal = parseTerminalEvent(text);
  return terminal ?? { state: 'pending' };
}
