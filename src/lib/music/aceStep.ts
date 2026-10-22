/**
 * ACE-Step engine client for the AI Music Studio (/music).
 *
 * Talks to the public ACE-Step 1.5 Hugging Face Space over its Gradio queue
 * API. The engine is swappable: point ACESPACE_BASE_URL at any compatible
 * ACE-Step Space (for example one running on your own GPU machine) and
 * nothing else changes. No secrets are needed; the Space is public.
 *
 * Flow: submitGeneration() POSTs to /gradio_api/queue/join and returns the
 * job handle. awaitGeneration() then opens the session's
 * /gradio_api/queue/data stream exactly once and stays connected until the
 * terminal process_completed event. Never poll or re-open the stream: the
 * earlier design polled the /gradio_api/call event stream, which is
 * single-consumption, so every poll destroyed the job it was checking (a
 * later read returns "404: Not Found") and its failures arrive as
 * data: null with no error text. The queue channel carries the real
 * terminal payload, including error text such as the ZeroGPU quota
 * message, and the audio file on success.
 *
 * Payload quirk, verified live: /gradio_api/info lists 49 parameters for
 * the generation endpoint, but the function takes 54 inputs; the info
 * list omits gradio State components. Submitting only 49 values fails
 * instantly ("didn't receive enough input values"), so the payload is
 * built from the Space's /config: dependency inputs in order, State
 * components on their configured defaults, named parameters aligned onto
 * the rest in order.
 */

const DEFAULT_BASE_URL = 'https://ace-step-ace-step-v1-5.hf.space';
const ENDPOINT = '/generation_wrapper';

export const QUOTA_MESSAGE =
  'The free engine is out of GPU quota right now. Try again later, or run the studio engine on your own GPU machine.';
export const DROPPED_MESSAGE =
  'The engine dropped this job before it finished. Please try again.';
export const TIMEOUT_MESSAGE =
  'The engine took too long to finish. Please try again.';
export const GENERIC_ERROR_MESSAGE =
  'The music engine reported an error. Please try again.';

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

export interface SubmittedJob {
  eventId: string;
  sessionHash: string;
}

export type AwaitResult = { audioUrl: string } | { error: string };

interface GradioParameter {
  parameter_name?: string;
  parameter_default?: unknown;
}

interface InputSpec {
  /** Info parameter name, or null for State inputs that take no override. */
  name: string | null;
  value: unknown;
}

interface EngineShape {
  inputs: InputSpec[];
  fnIndex: number;
}

let cachedShape: Promise<EngineShape> | null = null;

async function fetchInfoParams(): Promise<GradioParameter[]> {
  const res = await fetch(`${baseUrl()}/gradio_api/info`);
  if (!res.ok) {
    throw new Error(`Engine info request failed with status ${res.status}.`);
  }
  const info = (await res.json()) as {
    named_endpoints?: Record<string, { parameters?: GradioParameter[] }>;
  };
  const params = info.named_endpoints?.[ENDPOINT]?.parameters;
  if (!Array.isArray(params) || params.length === 0) {
    throw new Error('Engine info did not describe the generation endpoint.');
  }
  return params;
}

/**
 * Build the full input array and function index from the Space's /config:
 * the generation dependency's inputs in declared order. State components
 * are absent from the info parameter list; they keep their configured
 * default values and the named parameters align onto the remaining inputs
 * in order.
 */
async function loadShape(): Promise<EngineShape> {
  const params = await fetchInfoParams();
  const res = await fetch(`${baseUrl()}/config`);
  if (!res.ok) {
    throw new Error(`Engine config request failed with status ${res.status}.`);
  }
  const config = (await res.json()) as {
    components?: { id: number; type: string; props?: { value?: unknown } }[];
    dependencies?: { id?: number; api_name?: string; inputs?: number[] }[];
  };
  const dep = (config.dependencies ?? []).find(
    (d) => d.api_name === ENDPOINT.replace(/^\//, '')
  );
  if (!dep || typeof dep.id !== 'number' || !Array.isArray(dep.inputs)) {
    throw new Error('Engine config did not describe the generation inputs.');
  }
  const components = new Map(
    (config.components ?? []).map((c) => [c.id, c] as const)
  );
  const named = [...params];
  const inputs: InputSpec[] = dep.inputs.map((componentId) => {
    const comp = components.get(componentId);
    if (!comp) throw new Error('Engine config referenced a missing input.');
    const configured = comp.props?.value;
    if (comp.type === 'state') {
      return { name: null, value: configured ?? null };
    }
    const param = named.shift();
    if (!param) throw new Error('Engine config has more inputs than names.');
    return {
      name: param.parameter_name ?? '',
      value:
        configured !== undefined
          ? configured
          : param.parameter_default ?? null,
    };
  });
  if (named.length !== 0) {
    throw new Error('Engine config has fewer inputs than named parameters.');
  }
  return { inputs, fnIndex: dep.id };
}

function engineShape(): Promise<EngineShape> {
  if (!cachedShape) {
    cachedShape = loadShape().catch((err) => {
      cachedShape = null;
      throw err;
    });
  }
  return cachedShape;
}

function isQuotaText(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes('quota') ||
    lower.includes('zerogpu') ||
    lower.includes('zero gpu')
  );
}

/** Map a raw engine error string to the message shown to the user. */
export function toFriendlyError(raw: string): string {
  if (raw === 'timeout') return TIMEOUT_MESSAGE;
  if (isQuotaText(raw)) return QUOTA_MESSAGE;
  const lower = raw.toLowerCase();
  if (lower.includes('404') || lower.includes('not found')) {
    return DROPPED_MESSAGE;
  }
  return GENERIC_ERROR_MESSAGE;
}

async function submitWithModel(
  req: GenerationRequest,
  model: string
): Promise<SubmittedJob> {
  const { inputs, fnIndex } = await engineShape();
  const overrides: Record<string, unknown> = {
    selected_model: model,
    param_4: req.style,
    param_5: req.lyrics,
    param_6: req.bpm,
    param_9: req.language,
    param_15: req.durationSec,
    param_16: 1,
  };
  const data = inputs.map((entry) =>
    entry.name !== null &&
    Object.prototype.hasOwnProperty.call(overrides, entry.name)
      ? overrides[entry.name]
      : entry.value
  );
  const sessionHash = `curv${Date.now().toString(36)}${Math.random()
    .toString(36)
    .slice(2, 10)}`;

  const res = await fetch(`${baseUrl()}/gradio_api/queue/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data, fn_index: fnIndex, session_hash: sessionHash }),
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
  return { eventId: parsed.event_id, sessionHash };
}

/**
 * Submit a generation job. Tries the XL model first and falls back to the
 * smaller turbo model if the submit fails. Returns the job handle.
 */
export async function submitGeneration(
  req: GenerationRequest
): Promise<SubmittedJob> {
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

interface QueueEvent {
  msg?: string;
  success?: boolean;
  output?: { data?: unknown; error?: unknown };
}

/**
 * Interpret one queue event. Returns the terminal result, or null for
 * progress events (estimation, process_starts, heartbeats).
 */
function parseQueueEvent(event: QueueEvent): AwaitResult | null {
  if (event.msg !== 'process_completed' && event.msg !== 'process_failed') {
    return null;
  }
  const errText = event.output?.error;
  if (typeof errText === 'string' && errText.length > 0) {
    return { error: errText };
  }
  if (event.success === false || event.msg === 'process_failed') {
    return { error: 'The engine reported an error with no details.' };
  }
  const audioUrl = findAudioUrl(event.output?.data);
  if (audioUrl) return { audioUrl };
  return { error: 'The engine finished but returned no audio file.' };
}

/**
 * Open the queue stream for a submitted job exactly once and read it until
 * the terminal event, the stream ending, or the overall timeout. Never
 * abort early for any other reason and never reconnect: one submission,
 * one connection, one terminal answer.
 */
export async function awaitGeneration(
  job: SubmittedJob,
  opts: { timeoutMs: number }
): Promise<AwaitResult> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, opts.timeoutMs);
  try {
    const res = await fetch(
      `${baseUrl()}/gradio_api/queue/data?session_hash=${encodeURIComponent(job.sessionHash)}`,
      { signal: controller.signal }
    );
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { error: body.trim() || `HTTP ${res.status}` };
    }
    if (!res.body) return { error: 'The engine stream was empty.' };
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        let event: QueueEvent;
        try {
          event = JSON.parse(line.slice('data:'.length).trim()) as QueueEvent;
        } catch {
          continue;
        }
        const terminal = parseQueueEvent(event);
        if (terminal) return terminal;
      }
    }
  } catch {
    if (timedOut) return { error: 'timeout' };
    return { error: 'The engine connection closed before the job finished.' };
  } finally {
    clearTimeout(timer);
  }
  if (timedOut) return { error: 'timeout' };
  return { error: 'The engine stream ended before the job finished.' };
}
