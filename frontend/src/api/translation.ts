/** Shared translation + language-detection API client.
 *
 *  Used by the Consolidation, Extraction, Metadata, and Chunks tabs.
 *  Backend handler: api/routers/translation.py.
 *
 *  Concurrency: the auto-translate flow on the Chunks tab can fire one
 *  request per chunk on first open of a foreign-language doc. An uncapped
 *  stampede blows past LLM-provider rate limits and inflates cost during
 *  the cold-cache path. We gate both endpoints behind small FIFO queues —
 *  translations are slow and expensive (lower cap), detection is cheap
 *  (higher cap).
 */

export interface TranslationResult {
  translated_text: string;
  source_language: string;
  is_rtl: boolean;
  detected: boolean;
  cached: boolean;
}

export interface LanguageDetectionResult {
  language: string;
  confidence: "high" | "medium" | "low";
}

// ── Global concurrency gates ─────────────────────────────────────────────

function makeGate(maxConcurrent: number) {
  const waiters: Array<() => void> = [];
  let active = 0;
  return async function run<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= maxConcurrent) {
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
    active++;
    try {
      return await fn();
    } finally {
      active--;
      const next = waiters.shift();
      if (next) next();
    }
  };
}

const translateGate = makeGate(4);
const detectGate = makeGate(8);

// ── Public API ───────────────────────────────────────────────────────────

/** Translate arbitrary text to English. Backend caches by content hash.
 *  Globally gated to at most 4 concurrent requests. */
export async function fetchTranslation(
  text: string,
  sourceLanguage?: string,
): Promise<TranslationResult> {
  return translateGate(async () => {
    const res = await fetch("/api/v1/translate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        source_language: sourceLanguage,
      }),
    });
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`Translation failed: ${detail}`);
    }
    return res.json();
  });
}

/** Detect the dominant language of a text sample. Cheap, cached.
 *  Callers use this to decide whether to auto-translate.
 *  Globally gated to at most 8 concurrent requests. */
export async function detectLanguage(
  text: string,
): Promise<LanguageDetectionResult> {
  return detectGate(async () => {
    const res = await fetch("/api/v1/detect-language", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`Language detection failed: ${detail}`);
    }
    return res.json();
  });
}
