import type { ConsolidatedBlock } from "./types";

// ── Normative mode ──────────────────────────────────────────────────────
//
// These are the five binding strengths that HSE-051 recognises. Reviewers
// need to distinguish them at a glance — a "policy" statement and an
// "informational" one look similar in prose but have very different
// compliance weight. The color palette is chosen for legibility in both
// dark and light themes, not thematic meaning.

const NORMATIVE_MODE_STYLES: Record<string, string> = {
  policy: "bg-purple-500/15 text-purple-400 border-purple-500/30",
  standard: "bg-red-500/15 text-red-400 border-red-500/30",
  procedure: "bg-blue-500/15 text-blue-400 border-blue-500/30",
  guideline: "bg-green-500/15 text-green-400 border-green-500/30",
  informational: "bg-zinc-500/15 text-zinc-400 border-zinc-500/30",
};

// Section function badge uses a neutral treatment — 14 categories is too
// many distinct colors to be helpful at a glance. The label itself is the
// differentiator; color only escalates to normative_mode.
const SECTION_FUNCTION_STYLE =
  "bg-muted/50 text-muted-foreground border-border";

// Format badge only appears for non-prose — prose is the default and
// would otherwise add noise to every block.
const FORMAT_STYLES: Record<string, string> = {
  form: "bg-indigo-500/15 text-indigo-400 border-indigo-500/30",
  table: "bg-teal-500/15 text-teal-400 border-teal-500/30",
  image: "bg-pink-500/15 text-pink-400 border-pink-500/30",
};

const PILL =
  "inline-flex items-center px-1.5 py-0.5 rounded text-[10px] border font-medium whitespace-nowrap";

export function NormativeModeBadge({ mode }: { mode: string | undefined | null }) {
  if (!mode) return null;
  const cls = NORMATIVE_MODE_STYLES[mode] ?? SECTION_FUNCTION_STYLE;
  return <span className={`${PILL} ${cls}`}>{mode}</span>;
}

export function SectionFunctionBadge({ fn }: { fn: string | undefined | null }) {
  if (!fn) return null;
  return <span className={`${PILL} ${SECTION_FUNCTION_STYLE}`}>{fn}</span>;
}

export function FormatBadge({ format }: { format: string | undefined | null }) {
  if (!format || format === "prose") return null;
  const cls = FORMAT_STYLES[format] ?? SECTION_FUNCTION_STYLE;
  return <span className={`${PILL} ${cls}`}>{format}</span>;
}

/** Convenience: all three badges in a flex row. Used in detail panel header
 *  and inline on KCAD cards. Hides badges that don't apply (empty
 *  section_function, prose format) so the row degrades gracefully. */
export function ClassificationBadges({
  block,
  includeFormat = true,
}: {
  block: ConsolidatedBlock;
  /** Set to false to suppress format badge (e.g. where space is tight). */
  includeFormat?: boolean;
}) {
  return (
    <div className="flex items-center gap-1 flex-wrap">
      <NormativeModeBadge mode={block.normative_mode} />
      <SectionFunctionBadge fn={block.section_function} />
      {includeFormat && <FormatBadge format={block.format} />}
    </div>
  );
}
