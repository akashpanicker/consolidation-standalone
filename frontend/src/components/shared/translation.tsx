import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import { fetchTranslation, type TranslationResult } from "@/api/translation";

// ── Language helpers ────────────────────────────────────────────────────

/** ISO 639-1 codes rendered right-to-left. */
const RTL_LANGUAGES = new Set(["ar", "he", "fa", "ur"]);

/** ISO 639-1 → display name (short). Falls back to uppercase code. */
const LANGUAGE_LABELS: Record<string, string> = {
  en: "English",
  de: "German",
  fr: "French",
  es: "Spanish",
  it: "Italian",
  pt: "Portuguese",
  nl: "Dutch",
  ar: "Arabic",
  he: "Hebrew",
  fa: "Persian",
  ur: "Urdu",
  ru: "Russian",
  zh: "Chinese",
  ja: "Japanese",
  ko: "Korean",
  tr: "Turkish",
  pl: "Polish",
  no: "Norwegian",
  sv: "Swedish",
  da: "Danish",
  fi: "Finnish",
  cs: "Czech",
  ro: "Romanian",
  hu: "Hungarian",
  el: "Greek",
  id: "Indonesian",
  ms: "Malay",
  vi: "Vietnamese",
  th: "Thai",
  hi: "Hindi",
};

/** Whether a language is non-English (translation is meaningful). */
export function isForeignLanguage(language: string | undefined | null): boolean {
  if (!language) return false;
  const code = language.toLowerCase();
  return code !== "" && code !== "en" && code !== "und";
}

/** Whether a language renders right-to-left. */
export function isRTL(language: string | undefined | null): boolean {
  if (!language) return false;
  return RTL_LANGUAGES.has(language.toLowerCase());
}

/** Display name for a language code (e.g., "de" -> "German"). */
export function languageLabel(language: string | undefined | null): string {
  if (!language) return "";
  const code = language.toLowerCase();
  return LANGUAGE_LABELS[code] ?? code.toUpperCase();
}

/** Short code for badges (e.g., "de" -> "DE"). */
export function languageBadge(language: string | undefined | null): string {
  if (!language) return "";
  return language.toUpperCase().slice(0, 2);
}

// ── Hook ────────────────────────────────────────────────────────────────

export type TranslationMode = "original" | "translated";

export interface UseTextTranslationOptions {
  /** When true, automatically fetch+flip to translated as soon as the text's
   *  language is known to be non-English. Default: false.
   *  Enable for tabs where reviewers want English by default (Extraction tab,
   *  whole-document translate). Leave off for per-item toggles (chunk cards). */
  autoTranslate?: boolean;
  /** Optional "pushed" mode from a parent component — e.g., a tab-level
   *  banner flipping every card between original and translated together.
   *  When this prop changes, the hook's internal mode follows. The hook's
   *  own toggle() still works for per-item overrides. */
  externalMode?: TranslationMode | null;
}

export interface UseTextTranslationResult {
  /** Whether translation is worth offering (non-English / non-empty). */
  canTranslate: boolean;
  /** Current mode: "original" or "translated". */
  mode: TranslationMode;
  /** Text to render at the current mode. */
  displayText: string;
  /** `dir` attribute to apply to the rendered text container. */
  dir: "ltr" | "rtl";
  /** Toggle between original and translated. First toggle fetches; later toggles are instant. */
  toggle: () => Promise<void>;
  /** True during a network call. */
  isLoading: boolean;
  /** Non-null when the last translation attempt failed. */
  error: string | null;
  /** True if backend hit the translation cache. */
  cached: boolean;
  /** Effective language code (from caller or after backend detection). */
  effectiveLanguage: string;
  /** True iff auto-translate fired and flipped into translated mode on behalf of the user. */
  autoTranslated: boolean;
}

/** Manage on-demand translation for an arbitrary text blob.
 *
 *  - Stores the translation in component state after the first fetch so
 *    repeated toggles cost nothing.
 *  - Uses the caller-supplied `language` as the source language. If absent,
 *    backend runs detection on first translate.
 *  - When `autoTranslate` is true AND the supplied language is non-English,
 *    the hook fetches + flips to translated automatically on mount (and on
 *    text/language change). Reviewers can always click "Show original".
 */
export function useTextTranslation(
  text: string,
  language: string | undefined | null,
  options: UseTextTranslationOptions = {},
): UseTextTranslationResult {
  const { autoTranslate = false, externalMode = null } = options;
  const [mode, setMode] = useState<TranslationMode>("original");
  const [translation, setTranslation] = useState<TranslationResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autoTranslated, setAutoTranslated] = useState(false);

  // Follow parent-pushed mode when provided. If the parent flips to
  // "translated" before we've fetched, the auto-translate effect below
  // owns the fetch; this effect just syncs mode once data is available.
  useEffect(() => {
    if (externalMode == null) return;
    if (externalMode === "translated" && !translation) return;
    setMode(externalMode);
  }, [externalMode, translation]);

  const effectiveLanguage = translation?.source_language ?? (language ?? "");
  const hasText = text.trim().length > 0;
  const canTranslate = useMemo(() => {
    if (!hasText) return false;
    if (isForeignLanguage(effectiveLanguage)) return true;
    return !language;
  }, [hasText, effectiveLanguage, language]);

  const toggle = useCallback(async () => {
    if (!hasText) return;

    if (mode === "translated") {
      setMode("original");
      setError(null);
      return;
    }

    if (translation) {
      setMode("translated");
      setError(null);
      return;
    }

    setIsLoading(true);
    setError(null);
    try {
      const result = await fetchTranslation(text, language ?? undefined);
      setTranslation(result);
      if (isForeignLanguage(result.source_language)) {
        setMode("translated");
      } else {
        setError("Text appears to already be in English.");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Translation failed");
    } finally {
      setIsLoading(false);
    }
  }, [hasText, mode, translation, text, language]);

  // One-attempt-per-(text,language) guard. A ref, not state — touching it
  // mustn't re-run the auto-fetch effect, which is what caused the earlier
  // self-cancelling loop (setIsLoading(true) re-ran the effect whose
  // cleanup cancelled its own in-flight fetch).
  const attemptedRef = useRef(false);

  // Reset translation state + attempt guard when the text or language
  // changes so a new document doesn't show the previous document's
  // translation and gets a fresh auto-fetch.
  useEffect(() => {
    setTranslation(null);
    setMode("original");
    setError(null);
    setAutoTranslated(false);
    attemptedRef.current = false;
  }, [text, language]);

  // Either `autoTranslate` or a parent pushing `externalMode="translated"`
  // triggers the background fetch. Deps are intentionally limited to the
  // identity inputs (shouldAutoFetch/hasText/language/text) — never add
  // `translation` or `isLoading` here; the ref guards against re-entry.
  const shouldAutoFetch = autoTranslate || externalMode === "translated";
  useEffect(() => {
    if (!shouldAutoFetch || !hasText) return;
    if (!isForeignLanguage(language)) return;
    if (attemptedRef.current) return;
    attemptedRef.current = true;

    let cancelled = false;
    (async () => {
      setIsLoading(true);
      try {
        const result = await fetchTranslation(text, language ?? undefined);
        if (cancelled) return;
        setTranslation(result);
        if (isForeignLanguage(result.source_language)) {
          setMode("translated");
          setAutoTranslated(true);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Translation failed");
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [shouldAutoFetch, hasText, language, text]);

  const displayText = mode === "translated" && translation
    ? translation.translated_text
    : text;

  const dir: "ltr" | "rtl" =
    mode === "translated" ? "ltr" : isRTL(effectiveLanguage) ? "rtl" : "ltr";

  return {
    canTranslate,
    mode,
    displayText,
    dir,
    toggle,
    isLoading,
    error,
    cached: translation?.cached ?? false,
    effectiveLanguage,
    autoTranslated,
  };
}

/** @deprecated Prefer `useTextTranslation`. Kept as an alias so existing
 *  consolidation call sites don't need to change. */
export const useChunkTranslation = useTextTranslation;

// ── Components ──────────────────────────────────────────────────────────

/** Small amber badge showing the detected language code. */
export function LanguageBadge({
  language,
  className = "",
}: {
  language: string | undefined | null;
  className?: string;
}) {
  if (!isForeignLanguage(language)) return null;
  return (
    <span
      className={`inline-flex items-center text-[11px] font-mono px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-600 dark:text-amber-300 border border-amber-500/30 ${className}`}
      title={languageLabel(language)}
    >
      {languageBadge(language)}
    </span>
  );
}

/** Toggle button that switches text between original and translated. */
export function TranslateToggle({
  mode,
  isLoading,
  onClick,
  size = "sm",
  className = "",
}: {
  mode: TranslationMode;
  isLoading: boolean;
  onClick: (e?: React.MouseEvent) => void;
  size?: "xs" | "sm";
  className?: string;
}) {
  const sizeClasses =
    size === "xs"
      ? "text-[11px] px-1.5 py-0.5 gap-1"
      : "text-xs px-2 py-1 gap-1.5";

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onClick(e);
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={isLoading}
      className={`inline-flex items-center ${sizeClasses} rounded border border-border text-muted-foreground hover:text-foreground hover:bg-muted/50 active:bg-muted/70 active:translate-y-px transition-all disabled:opacity-60 ${className}`}
    >
      {isLoading ? (
        <>
          <SpinnerIcon />
          Translating…
        </>
      ) : mode === "original" ? (
        <>
          <TranslateIcon />
          Translate
        </>
      ) : (
        <>
          <OriginalIcon />
          Show original
        </>
      )}
    </button>
  );
}

/** Inline error line for translation failures. */
export function TranslationError({ message }: { message: string }) {
  return (
    <div className="text-[11px] text-red-400 mt-1 italic">
      {message}
    </div>
  );
}

// ── Segmented translation (e.g., breadcrumb paths) ───────────────────────

/** Translate an ordered list of short text segments independently, then
 *  rejoin them with a fixed separator. Maximises reuse of the backend's
 *  content-hash cache when the same segment appears in many paths (e.g.,
 *  a KCAD document's top-level section name on every chunk's breadcrumb).
 *
 *  Display-only: callers MUST keep the original `heading_path` string for
 *  identity lookups (chunk_id generation, judge prompts, polish endpoint
 *  keys, block grouping). Translation is purely cosmetic.
 */
export function useSegmentedTranslation(
  segments: readonly string[],
  language: string | undefined | null,
  separator: string = " > ",
  options: UseTextTranslationOptions = {},
): {
  displayText: string;
  mode: TranslationMode;
  dir: "ltr" | "rtl";
  isLoading: boolean;
  error: string | null;
  toggle: () => void;
} {
  const { autoTranslate = false, externalMode = null } = options;
  const [mode, setMode] = useState<TranslationMode>("original");
  const [translations, setTranslations] = useState<Record<string, string>>({});
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attemptedRef = useRef<string | null>(null);

  // Single stable key over the segment array, so effect deps are primitives.
  // \u0001 is unlikely to appear in any heading; avoids false collisions.
  const segmentsKey = useMemo(() => segments.join("\u0001"), [segments]);
  const shouldAutoFetch = autoTranslate || externalMode === "translated";

  // Follow parent-pushed mode.
  useEffect(() => {
    if (externalMode == null) return;
    setMode(externalMode);
  }, [externalMode]);

  // Reset when the path identity changes.
  useEffect(() => {
    setTranslations({});
    setMode("original");
    setError(null);
    attemptedRef.current = null;
  }, [segmentsKey, language]);

  useEffect(() => {
    if (!shouldAutoFetch) return;
    if (!isForeignLanguage(language)) return;
    const attemptKey = `${segmentsKey}|${language}`;
    if (attemptedRef.current === attemptKey) return;
    attemptedRef.current = attemptKey;

    const unique = Array.from(
      new Set(segments.filter((s) => s.trim().length > 0)),
    );
    if (unique.length === 0) return;

    let cancelled = false;
    setIsLoading(true);
    (async () => {
      try {
        const results = await Promise.all(
          unique.map(async (seg) => {
            try {
              const r = await fetchTranslation(seg, language ?? undefined);
              return [seg, r.translated_text || seg] as const;
            } catch {
              return [seg, seg] as const;
            }
          }),
        );
        if (cancelled) return;
        const map: Record<string, string> = {};
        for (const [orig, trans] of results) map[orig] = trans;
        setTranslations(map);
        setMode("translated");
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Translation failed");
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [shouldAutoFetch, language, segmentsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const displayText =
    mode === "translated"
      ? segments.map((s) => translations[s] ?? s).join(separator)
      : segments.join(separator);

  const dir: "ltr" | "rtl" =
    mode === "translated"
      ? "ltr"
      : isRTL(language ?? "")
        ? "rtl"
        : "ltr";

  const toggle = useCallback(() => {
    setMode((m) => (m === "translated" ? "original" : "translated"));
  }, []);

  return { displayText, mode, dir, isLoading, error, toggle };
}

/** Convenience wrapper for ` > `-separated breadcrumb paths. */
export function useHeadingPathTranslation(
  path: string,
  language: string | undefined | null,
  options: UseTextTranslationOptions = {},
) {
  const segments = useMemo(() => path.split(" > "), [path]);
  return useSegmentedTranslation(segments, language, " > ", options);
}

/** Wrap a single string in a translation-aware span.
 *
 *  Used by the Metadata tab to translate free-text fields (summary,
 *  sections, evidence) without re-rendering every leaf through the hook
 *  manually. `externalMode` ties this instance to a tab-level mode so a
 *  single banner flips every wrapped string together.
 */
export function TranslatableText({
  text,
  language,
  externalMode = null,
  className = "",
  as: Component = "span",
}: {
  text: string;
  language: string | undefined | null;
  externalMode?: TranslationMode | null;
  className?: string;
  as?: "span" | "p" | "div";
}) {
  const t = useTextTranslation(text, language, { externalMode });
  return (
    <Component dir={t.dir} className={className}>
      {t.displayText}
    </Component>
  );
}

/** Amber banner shown atop a tab when content was auto-translated.
 *  Click the toggle to flip back to the original. */
export function AutoTranslationBanner({
  sourceLanguage,
  mode,
  isLoading,
  onToggle,
  className = "",
}: {
  sourceLanguage: string;
  mode: TranslationMode;
  isLoading: boolean;
  onToggle: () => void;
  className?: string;
}) {
  const label = languageLabel(sourceLanguage);
  return (
    <div
      className={`flex items-center justify-between gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-xs ${className}`}
    >
      <span className="text-amber-700 dark:text-amber-200">
        {mode === "translated"
          ? `Auto-translated from ${label}.`
          : `This document is in ${label}.`}
      </span>
      <TranslateToggle
        mode={mode}
        isLoading={isLoading}
        onClick={onToggle}
        size="xs"
      />
    </div>
  );
}

// ── Icons (inline SVG, 12px) ─────────────────────────────────────────────

function TranslateIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m5 8 6 6" />
      <path d="m4 14 6-6 2-3" />
      <path d="M2 5h12" />
      <path d="M7 2h1" />
      <path d="m22 22-5-10-5 10" />
      <path d="M14 18h6" />
    </svg>
  );
}

function OriginalIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12a9 9 0 1 0 9-9" />
      <path d="M3 4v5h5" />
    </svg>
  );
}

function SpinnerIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="animate-spin">
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  );
}
