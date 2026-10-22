import { useCallback, useEffect, useRef, useState } from 'react';
import Head from 'next/head';
import Page from '@/components/ui/Page/Page';

const GENRES = ['Phonk', 'EDM', 'Pop', 'Hip-Hop', 'Lo-fi', 'Rock'];
const MOODS = ['Aggressive', 'Energetic', 'Chill', 'Dark', 'Uplifting'];
const TEMPOS: { label: string; bpm: number }[] = [
  { label: 'Slow', bpm: 80 },
  { label: 'Medium', bpm: 100 },
  { label: 'Fast', bpm: 120 },
  { label: 'Very fast', bpm: 140 },
];
const LANGUAGES: { label: string; code: string }[] = [
  { label: 'English', code: 'en' },
  { label: 'Hindi', code: 'hi' },
  { label: 'Hinglish', code: 'en' },
];
const DURATIONS = [60, 90, 120, 150];

const LIBRARY_KEY = 'curv-music-library';
const POLL_INTERVAL_MS = 5000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000;

interface LibraryEntry {
  id: string;
  title: string;
  createdAt: string;
  durationSec: number;
  audioUrl: string;
}

const inputClass =
  'w-full rounded-lg border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 outline-none focus:border-[#32f27b]/50 placeholder:text-neutral-600';
const labelClass =
  'mb-1.5 block text-xs font-semibold uppercase tracking-wide text-neutral-400';

function loadLibrary(): LibraryEntry[] {
  try {
    const raw = window.localStorage.getItem(LIBRARY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as LibraryEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export default function MusicStudioPage() {
  const [title, setTitle] = useState('');
  const [style, setStyle] = useState('');
  const [lyrics, setLyrics] = useState('');
  const [genre, setGenre] = useState(GENRES[0]);
  const [mood, setMood] = useState(MOODS[1]);
  const [bpm, setBpm] = useState(140);
  const [language, setLanguage] = useState('English');
  const [instrumental, setInstrumental] = useState(false);
  const [durationSec, setDurationSec] = useState(90);

  const [library, setLibrary] = useState<LibraryEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [latest, setLatest] = useState<LibraryEntry | null>(null);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setLibrary(loadLibrary());
    return () => {
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
  }, []);

  const saveLibrary = useCallback((entries: LibraryEntry[]) => {
    setLibrary(entries);
    try {
      window.localStorage.setItem(LIBRARY_KEY, JSON.stringify(entries));
    } catch {
      // Storage full or unavailable; the in-memory list still works.
    }
  }, []);

  const poll = useCallback(
    (
      eventId: string,
      startedAt: number,
      pendingTitle: string,
      pendingDuration: number
    ) => {
      const tick = async () => {
        if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
          setBusy(false);
          setStatus('');
          setError(
            'Generation is taking too long and was stopped. Please try again.'
          );
          return;
        }
        try {
          const res = await fetch(
            `/api/music/status?eventId=${encodeURIComponent(eventId)}`
          );
          const data = (await res.json()) as {
            state?: string;
            audioUrl?: string;
            message?: string;
          };
          if (data.state === 'complete' && data.audioUrl) {
            const entry: LibraryEntry = {
              id: `${Date.now()}`,
              title: pendingTitle,
              createdAt: new Date().toISOString(),
              durationSec: pendingDuration,
              audioUrl: data.audioUrl,
            };
            setLatest(entry);
            saveLibrary([entry, ...loadLibrary()]);
            setBusy(false);
            setStatus('');
            return;
          }
          if (data.state === 'error') {
            setBusy(false);
            setStatus('');
            setError(
              data.message ??
                'The music engine reported an error. Please try again.'
            );
            return;
          }
        } catch {
          // A failed poll is not fatal; keep waiting for the next one.
        }
        setStatus('Generating your song. This can take a few minutes.');
        pollTimer.current = setTimeout(tick, POLL_INTERVAL_MS);
      };
      void tick();
    },
    [saveLibrary]
  );

  const onGenerate = async () => {
    setError('');
    setStatus('');
    if (!style.trim()) {
      setError('Describe the style of the song first.');
      return;
    }
    if (!instrumental && !lyrics.trim()) {
      setError('Add lyrics, or tick Instrumental for a track without vocals.');
      return;
    }
    setBusy(true);
    setStatus('Sending your song to the engine.');
    try {
      const res = await fetch('/api/music/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title.trim(),
          style: style.trim(),
          lyrics,
          genre,
          mood,
          bpm,
          language: LANGUAGES.find((l) => l.label === language)?.code ?? 'en',
          instrumental,
          durationSec,
        }),
      });
      const data = (await res.json()) as { eventId?: string; error?: string };
      if (!res.ok || !data.eventId) {
        setBusy(false);
        setStatus('');
        setError(
          data.error ??
            'The music engine could not accept the job. Please try again.'
        );
        return;
      }
      setStatus('Queued on the engine.');
      poll(
        data.eventId,
        Date.now(),
        title.trim() || 'Untitled song',
        durationSec
      );
    } catch {
      setBusy(false);
      setStatus('');
      setError('Could not reach the studio server. Please try again.');
    }
  };

  const onDelete = (id: string) => {
    saveLibrary(loadLibrary().filter((entry) => entry.id !== id));
    if (latest?.id === id) setLatest(null);
  };

  return (
    <Page>
      <Head>
        <title>AI Music Studio | Curv</title>
        <meta
          name="description"
          content="Create full songs with vocals from a style prompt and your lyrics, powered by the open source ACE-Step 1.5 engine."
        />
      </Head>
      <main className="mx-auto w-full max-w-2xl px-4 pb-16 pt-8">
        <h1 className="text-2xl font-bold text-white">AI Music Studio</h1>
        <p className="mt-2 text-[15px] leading-relaxed text-neutral-400">
          Create full songs with vocals from a style and lyrics. No credits, no
          paywall: generate, listen, and download the MP3.
        </p>
        <p className="mt-1 text-[13px] text-neutral-500">
          Powered by ACE-Step 1.5 (open source).
        </p>

        <section className="mt-8 rounded-2xl border border-neutral-800 bg-neutral-900/40 p-5">
          <label className={labelClass} htmlFor="music-title">
            Title
          </label>
          <input
            id="music-title"
            className={inputClass}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Last Rep"
            maxLength={120}
          />

          <div className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-3">
            <div>
              <label className={labelClass} htmlFor="music-genre">
                Genre
              </label>
              <select
                id="music-genre"
                className={inputClass}
                value={genre}
                onChange={(e) => setGenre(e.target.value)}
              >
                {GENRES.map((g) => (
                  <option key={g} value={g}>
                    {g}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelClass} htmlFor="music-mood">
                Mood
              </label>
              <select
                id="music-mood"
                className={inputClass}
                value={mood}
                onChange={(e) => setMood(e.target.value)}
              >
                {MOODS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelClass} htmlFor="music-tempo">
                Tempo
              </label>
              <select
                id="music-tempo"
                className={inputClass}
                value={bpm}
                onChange={(e) => setBpm(Number(e.target.value))}
              >
                {TEMPOS.map((t) => (
                  <option key={t.bpm} value={t.bpm}>
                    {t.label} ({t.bpm} BPM)
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelClass} htmlFor="music-language">
                Vocal language
              </label>
              <select
                id="music-language"
                className={inputClass}
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
              >
                {LANGUAGES.map((l) => (
                  <option key={l.label} value={l.label}>
                    {l.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelClass} htmlFor="music-duration">
                Duration
              </label>
              <select
                id="music-duration"
                className={inputClass}
                value={durationSec}
                onChange={(e) => setDurationSec(Number(e.target.value))}
              >
                {DURATIONS.map((d) => (
                  <option key={d} value={d}>
                    {d} seconds
                  </option>
                ))}
              </select>
            </div>
            <div className="flex items-end pb-1">
              <label className="flex cursor-pointer items-center gap-2 text-sm text-neutral-300">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-[#32f27b]"
                  checked={instrumental}
                  onChange={(e) => setInstrumental(e.target.checked)}
                />
                Instrumental
              </label>
            </div>
          </div>

          <div className="mt-5">
            <label className={labelClass} htmlFor="music-style">
              Style prompt
            </label>
            <textarea
              id="music-style"
              rows={3}
              className={inputClass}
              value={style}
              onChange={(e) => setStyle(e.target.value)}
              placeholder="e.g. High energy gym phonk, heavy 808 bass, dark synth stabs, aggressive male rap verses, big group chant chorus"
              maxLength={1000}
            />
          </div>

          <div className="mt-5">
            <label className={labelClass} htmlFor="music-lyrics">
              Lyrics
            </label>
            <textarea
              id="music-lyrics"
              rows={10}
              className={`${inputClass} font-mono text-[13px] leading-relaxed`}
              value={lyrics}
              onChange={(e) => setLyrics(e.target.value)}
              placeholder={
                '[Verse]\nYour first verse lines here\n\n[Chorus]\nThe hook everyone remembers'
              }
              maxLength={3000}
              disabled={instrumental}
            />
            <p className="mt-1.5 text-xs text-neutral-500">
              Use section tags like [Verse], [Pre-Chorus], [Chorus] and [Bridge]
              to structure the song. Ignored when Instrumental is ticked.
            </p>
          </div>

          <button
            type="button"
            onClick={onGenerate}
            disabled={busy}
            className="mt-6 w-full rounded-lg bg-[#32f27b] px-4 py-2.5 text-sm font-semibold text-black transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto sm:px-8"
          >
            {busy ? 'Generating...' : 'Generate song'}
          </button>

          {status && (
            <p className="mt-4 text-sm text-neutral-300" role="status">
              {status}
            </p>
          )}
          {error && (
            <div
              className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300"
              role="alert"
            >
              {error}
            </div>
          )}
        </section>

        {latest && (
          <section className="mt-8 rounded-2xl border border-[#32f27b]/25 bg-[#32f27b]/[0.03] p-5">
            <h2 className="text-base font-semibold text-neutral-100">
              Latest result: {latest.title}
            </h2>
            <audio controls src={latest.audioUrl} className="mt-3 w-full" />
            <div className="mt-3 flex flex-wrap gap-4 text-sm">
              <a
                href={latest.audioUrl}
                download
                className="font-semibold text-[#32f27b] hover:underline"
              >
                Download MP3
              </a>
              <span className="text-neutral-500">
                Saved to your library below.
              </span>
            </div>
          </section>
        )}

        <section className="mt-10">
          <h2 className="text-lg font-semibold text-white">Your library</h2>
          <p className="mt-1 text-sm text-neutral-500">
            Songs you generate are kept in this browser.
          </p>
          {library.length === 0 ? (
            <p className="mt-4 rounded-2xl border border-dashed border-neutral-800 px-5 py-6 text-sm text-neutral-500">
              Nothing here yet. Generate your first song above.
            </p>
          ) : (
            <div className="mt-4 space-y-3">
              {library.map((entry) => (
                <article
                  key={entry.id}
                  className="rounded-2xl border border-neutral-800 bg-neutral-900/40 px-5 py-4"
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <h3 className="text-[15px] font-semibold text-neutral-100">
                      {entry.title}
                    </h3>
                    <span className="text-xs text-neutral-500">
                      {new Date(entry.createdAt).toLocaleDateString(undefined, {
                        year: 'numeric',
                        month: 'short',
                        day: 'numeric',
                      })}{' '}
                      · {entry.durationSec}s
                    </span>
                  </div>
                  <audio
                    controls
                    src={entry.audioUrl}
                    className="mt-3 w-full"
                  />
                  <div className="mt-3 flex flex-wrap gap-4 text-sm">
                    <a
                      href={entry.audioUrl}
                      download
                      className="font-semibold text-[#32f27b] hover:underline"
                    >
                      Download MP3
                    </a>
                    <button
                      type="button"
                      onClick={() => onDelete(entry.id)}
                      className="font-semibold text-red-400 hover:underline"
                    >
                      Delete
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      </main>
    </Page>
  );
}
