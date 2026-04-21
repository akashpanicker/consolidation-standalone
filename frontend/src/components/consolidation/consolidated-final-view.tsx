/**
 * ConsolidatedFinalView — unified preview of an HP document that reflects the
 * CURRENT reviewer state. Renders deterministically from the live view JSON
 * (same source as the Reviewer View) — no LLM merging, no frozen snapshot,
 * no paraphrased prose.
 *
 * Content methodology (why the render rules are what they are):
 * - HP canonical prose is preserved verbatim (only the reviewer's edited_text
 *   overrides it). The renderer never paraphrases HP.
 * - HP's canonical numbering is preserved. KCAD additions do NOT renumber
 *   HP's sequence — they appear as regional callouts or in appendices.
 * - Global vs Regional is a visual first-class distinction. Regional content
 *   lives in bordered callouts with a region badge, never inline in HP prose.
 * - Conflicts are structured decisions (HP position | KCAD position | status),
 *   never ambiguous both-statements prose.
 * - KCAD source provenance (region, document ID, scope, objective, concept)
 *   is always visible — the reviewer can see what's being integrated and why.
 * - Dismissed / removed blocks are hidden. Edited blocks use edited_text.
 *   Appendix-assigned blocks move to the bottom.
 *
 * Data sources:
 * - fetchConsolidatedView(slug) — same query key as Reviewer View, so any
 *   reviewer mutation (accept/dismiss/edit/move/reclassify/appendix) invalidates
 *   this query and the unified view re-renders instantly.
 * - fetchDocumentContext(slug) — HP identity (canonical fields) + concept
 *   coverage + KCAD source metadata (scope, objective, concept alignment).
 */
import { useCallback, useMemo, useState } from "react";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import {
  ConcurrencyError,
  clearSectionPolish,
  fetchConsolidatedView,
  fetchDocumentContext,
  listAppendices,
  polishSection,
  type Actor,
} from "@/api/consolidation";
import { useAuth } from "@/hooks/useAuth";
import type {
  Appendix,
  ConsolidatedBlock,
  ConsolidatedView,
  DocumentContext,
  ReviewStatus,
  UnifiedOverride,
} from "./types";

// ── Heading helpers ────────────────────────────────────────────────────────

function parseHeading(headingPath: string): { title: string; depth: number } {
  const parts = headingPath.split(">").map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return { title: "Untitled", depth: 1 };
  const title = parts[parts.length - 1];
  const depth = Math.max(1, parts.length - 1);
  return { title, depth };
}



/** Strip every leading markdown heading line (and blank-line separators).
 *  HP chunks frequently start with their doc title (`# Hydrogen Sulfide
 *  (H2S) Policy`) and their section title (`## 1. Scope and Application`)
 *  — both are redundant with our <HeadingTag> + the doc-identity panel up
 *  top. Non-leading sub-headings mid-chunk are preserved. */
function stripRedundantLeadingHeading(text: string, _title: string): string {
  if (!text) return text;
  void _title; // kept for readability at call site; logic strips all leading #s
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length) {
    const t = lines[i].trim();
    if (t === "") {
      i++;
      continue;
    }
    if (/^#{1,6}\s+/.test(t)) {
      i++;
      continue;
    }
    break;
  }
  return lines.slice(i).join("\n");
}

// ── Source-label prettifier ────────────────────────────────────────────────

const REGION_LABELS: Record<string, string> = {
  KS: "Saudi Arabia operations",
  OM: "Oman operations",
  EU: "European land drilling operations",
  AZ: "Azerbaijan operations",
  DZ: "Algerian operations",
  PK: "Pakistan operations",
  LD: "Land drilling operations",
  AL: "Algeria operations",
  CW: "Corporate-wide",
};

/** Convert a raw KCAD filename or region code to a human-readable label. */
function friendlyRegionLabel(source: { region?: string | null; document?: string | null }): string {
  const region = (source.region || "").trim();
  if (region && !/^K-/i.test(region)) return region;
  const doc = (source.document || "").trim();
  const match = doc.match(/^K-([A-Z]{2,4})-/i);
  if (match) {
    const code = match[1].toUpperCase();
    return REGION_LABELS[code] ?? `${code} operations`;
  }
  return region || doc || "Unknown region";
}

/** Consistent color for a region label — keeps the same region visually stable
 *  across multiple callouts in the document. Tailwind classes so no runtime CSS. */
function regionColorClasses(regionLabel: string): { border: string; badge: string; bg: string } {
  // Hash the region to a fixed palette slot — deterministic.
  const palette = [
    { border: "border-l-blue-400", badge: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200", bg: "bg-blue-50/40 dark:bg-blue-950/20" },
    { border: "border-l-amber-400", badge: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200", bg: "bg-amber-50/40 dark:bg-amber-950/20" },
    { border: "border-l-emerald-400", badge: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200", bg: "bg-emerald-50/40 dark:bg-emerald-950/20" },
    { border: "border-l-violet-400", badge: "bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-200", bg: "bg-violet-50/40 dark:bg-violet-950/20" },
    { border: "border-l-rose-400", badge: "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-200", bg: "bg-rose-50/40 dark:bg-rose-950/20" },
    { border: "border-l-teal-400", badge: "bg-teal-100 text-teal-800 dark:bg-teal-900/40 dark:text-teal-200", bg: "bg-teal-50/40 dark:bg-teal-950/20" },
  ];
  let hash = 0;
  for (let i = 0; i < regionLabel.length; i++) hash = (hash * 31 + regionLabel.charCodeAt(i)) >>> 0;
  return palette[hash % palette.length];
}

// ── UI primitives ──────────────────────────────────────────────────────────

function HeadingTag({ depth, children }: { depth: number; children: ReactNode }) {
  const level = Math.min(4, Math.max(2, depth + 1));
  const classNames: Record<number, string> = {
    2: "mt-10 mb-3 text-2xl font-semibold text-zinc-900 dark:text-zinc-100",
    3: "mt-8 mb-2 text-xl font-semibold text-zinc-900 dark:text-zinc-100",
    4: "mt-6 mb-2 text-lg font-semibold text-zinc-900 dark:text-zinc-100",
  };
  const className = classNames[level] ?? classNames[4];
  if (level === 2) return <h2 className={className}>{children}</h2>;
  if (level === 3) return <h3 className={className}>{children}</h3>;
  return <h4 className={className}>{children}</h4>;
}

function Prose({ children }: { children: ReactNode }) {
  return (
    <div className="prose prose-zinc max-w-none dark:prose-invert prose-headings:mt-6 prose-headings:mb-2 prose-p:my-3 prose-table:text-sm prose-pre:text-sm prose-li:my-1">
      {children}
    </div>
  );
}

/** Compact markdown renderer — strips the `node` prop ReactMarkdown injects. */
const MD_COMPONENTS = {
  p: ({ node: _node, ...rest }: ComponentPropsWithoutRef<"p"> & { node?: unknown }) => {
    void _node;
    return <p {...rest} />;
  },
  li: ({ node: _node, ...rest }: ComponentPropsWithoutRef<"li"> & { node?: unknown }) => {
    void _node;
    return <li {...rest} />;
  },
  td: ({ node: _node, ...rest }: ComponentPropsWithoutRef<"td"> & { node?: unknown }) => {
    void _node;
    return <td {...rest} />;
  },
  th: ({ node: _node, ...rest }: ComponentPropsWithoutRef<"th"> & { node?: unknown }) => {
    void _node;
    return <th {...rest} />;
  },
  strong: ({ node: _node, ...rest }: ComponentPropsWithoutRef<"strong"> & { node?: unknown }) => {
    void _node;
    return <strong {...rest} />;
  },
  em: ({ node: _node, ...rest }: ComponentPropsWithoutRef<"em"> & { node?: unknown }) => {
    void _node;
    return <em {...rest} />;
  },
} as const;

function MarkdownProse({ text }: { text: string }) {
  return (
    <Prose>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
        {text}
      </ReactMarkdown>
    </Prose>
  );
}

// ── Block filtering and grouping ──────────────────────────────────────────

/** Block text source: edited_text if the reviewer edited, else text.
 *  Leading markdown headings are stripped because chunks commonly include
 *  their KCAD-source doc title or section number at the top — that would
 *  otherwise duplicate the section heading and muddy the clean Unified View.
 *  Headings further down in the body are preserved. */
function blockDisplayText(block: ConsolidatedBlock): string {
  const raw = block.edited_text ?? block.text ?? "";
  if (!raw) return "";
  const lines = raw.split("\n");
  let i = 0;
  while (i < lines.length) {
    const t = lines[i].trim();
    if (t === "") {
      i++;
      continue;
    }
    if (/^#{1,6}\s+/.test(t)) {
      i++;
      continue;
    }
    break;
  }
  return lines.slice(i).join("\n");
}

/** Drop blocks that shouldn't appear in any rendered form. */
function isRenderable(block: ConsolidatedBlock): boolean {
  if (block.status === "dismissed" || block.status === "removed") return false;
  if (block.type === "gap_header") return false;
  return true;
}

interface Section {
  headingPath: string;
  heading: { title: string; depth: number };
  hpBlocks: ConsolidatedBlock[]; // hp_original + user_added — canonical body
  kcadBlocks: ConsolidatedBlock[]; // kcad_addition blocks not in appendix
  conflictBlocks: ConsolidatedBlock[]; // conflict blocks not in appendix
  gapBlocks: ConsolidatedBlock[]; // kcad content routed to this section with no anchor
}

/** Walk blocks in array order, group into sections by heading_path, classify by type. */
function buildSections(blocks: ConsolidatedBlock[]): {
  sections: Section[];
  appendixBlocks: ConsolidatedBlock[];
  orphanGaps: ConsolidatedBlock[];
} {
  const sections: Section[] = [];
  const appendixBlocks: ConsolidatedBlock[] = [];
  const orphanGaps: ConsolidatedBlock[] = [];
  let current: Section | null = null;

  const flush = () => {
    if (current && (current.hpBlocks.length || current.kcadBlocks.length || current.conflictBlocks.length || current.gapBlocks.length)) {
      sections.push(current);
    }
    current = null;
  };

  const startSection = (headingPath: string): Section => {
    return {
      headingPath,
      heading: parseHeading(headingPath),
      hpBlocks: [],
      kcadBlocks: [],
      conflictBlocks: [],
      gapBlocks: [],
    };
  };

  for (const block of blocks) {
    if (!isRenderable(block)) continue;

    // Appendix-assigned blocks skip inline rendering; they collect at the bottom.
    if (block.appendix_id) {
      appendixBlocks.push(block);
      continue;
    }

    // Gap blocks without an HP anchor — they attach to whichever section they
    // land in but also surface in a "Potential Additions" appendix at the bottom.
    if (block.type === "gap") {
      orphanGaps.push(block);
      continue;
    }

    const heading = block.heading_path || "(Untitled)";

    if (!current || heading !== current.headingPath) {
      flush();
      current = startSection(heading);
    }

    if (block.type === "hp_original" || block.type === "user_added") {
      current.hpBlocks.push(block);
    } else if (block.type === "conflict") {
      current.conflictBlocks.push(block);
    } else if (block.type === "kcad_addition") {
      current.kcadBlocks.push(block);
    }
    // other types (gap_header already filtered, unknown types) dropped defensively
  }
  flush();

  return { sections, appendixBlocks, orphanGaps };
}

// ── Document identity panel (HP metadata + concept coverage) ──────────────

function DocumentIdentityPanel({ context }: { context: DocumentContext }) {
  const hp = context.hp;
  const details = hp.details;
  const canonical = details.canonical ?? {};
  const concepts = hp.concepts;

  const kcadCount = context.kcad.length;
  const kcadRegions = useMemo(() => {
    const regions = new Set<string>();
    for (const k of context.kcad) {
      regions.add(friendlyRegionLabel({ document: k.filename, region: null }));
    }
    return Array.from(regions).sort();
  }, [context.kcad]);

  return (
    <div className="border-b border-zinc-200 bg-white/80 px-8 py-6 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/80">
      <h1 className="mb-1 text-3xl font-bold text-zinc-900 dark:text-zinc-100">
        {canonical.title || hp.filename.replace(/\.pdf$/i, "").replace(/_/g, " ")}
      </h1>

      {/* Identity grid */}
      <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
        {canonical.document_number && (
          <IdentityField label="Document" value={canonical.document_number} />
        )}
        {canonical.revision && (
          <IdentityField label="Revision" value={canonical.revision} />
        )}
        {canonical.effective_date && (
          <IdentityField label="Effective" value={canonical.effective_date} />
        )}
        {details.department && (
          <IdentityField label="Department" value={details.department} />
        )}
        {details.affected_entities && (
          <IdentityField label="Applies to" value={details.affected_entities} />
        )}
      </div>

      {/* Concept coverage + KCAD source summary */}
      <div className="mt-4 flex flex-wrap items-start gap-x-6 gap-y-3 text-sm text-zinc-600 dark:text-zinc-400">
        {concepts?.primary?.name && (
          <div>
            <span className="text-xs uppercase tracking-wide text-zinc-500">Primary topic</span>
            <div className="mt-0.5 flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1 rounded bg-zinc-900 px-2 py-0.5 text-xs font-medium text-white dark:bg-zinc-100 dark:text-zinc-900">
                {concepts.primary.code && <span className="opacity-70">{concepts.primary.code}</span>}
                <span>{concepts.primary.name}</span>
              </span>
              {concepts.primary.tier_name && (
                <span className="text-xs text-zinc-500">· {concepts.primary.tier_name}</span>
              )}
            </div>
          </div>
        )}
        {concepts && concepts.secondary.length > 0 && (
          <div>
            <span className="text-xs uppercase tracking-wide text-zinc-500">Also covers</span>
            <div className="mt-0.5 flex flex-wrap gap-1.5">
              {concepts.secondary.map((s) => (
                <span
                  key={s.code ?? s.name ?? Math.random()}
                  className="inline-flex items-center gap-1 rounded bg-zinc-100 px-2 py-0.5 text-xs text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                >
                  {s.code && <span className="opacity-60">{s.code}</span>}
                  {s.name}
                </span>
              ))}
            </div>
          </div>
        )}
        {kcadCount > 0 && (
          <div>
            <span className="text-xs uppercase tracking-wide text-zinc-500">Regional sources</span>
            <div className="mt-0.5 text-sm text-zinc-700 dark:text-zinc-300">
              {kcadCount} KCAD document{kcadCount === 1 ? "" : "s"} · {kcadRegions.join(" · ")}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function IdentityField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-zinc-500">{label}</div>
      <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{value}</div>
    </div>
  );
}

// ── Review-status badge ───────────────────────────────────────────────────

function StatusBadge({ status }: { status: ReviewStatus }) {
  const label =
    status === "ai_consolidated"
      ? "AI Draft — not yet reviewed"
      : status === "in_review"
      ? "Draft — reflects current reviewer state"
      : status === "approved"
      ? "Approved — pending publish"
      : "Published";

  const color =
    status === "published"
      ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200"
      : status === "approved"
      ? "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200"
      : status === "in_review"
      ? "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200"
      : "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300";

  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${color}`}>
      {label}
    </span>
  );
}

// ── Regional callout (approved / pending KCAD addition) ───────────────────

function RegionalCallout({
  block,
}: {
  block: ConsolidatedBlock;
  /** Deliberately unused — the Unified View is the signable document and must
   *  not surface review metadata (AI confidence, dimension-match strip, source
   *  filename, rationale, region labels). That information belongs in the
   *  Review View's DetailPanel only. */
  kcadMeta?: DocumentContext["kcad"][number];
}) {
  const regionLabel = friendlyRegionLabel(block.source);
  const color = regionColorClasses(regionLabel);

  // Language callout is kept in a subtle form — operationally meaningful
  // because a reader glancing at the document needs to know the passage
  // originates from a non-English source (in case of translation ambiguity).
  const lang = block.language && block.language.toLowerCase() !== "en" ? block.language.toUpperCase() : null;

  // Region intentionally NOT rendered in the callout chrome. The colored
  // left border (hashed from region name) keeps regional content visually
  // distinct without labeling the specific region here. Readers who need
  // the region click through to the DetailPanel in Review View.
  return (
    <aside
      className={`my-4 rounded-md border border-zinc-200 border-l-4 ${color.border} ${color.bg} p-4 dark:border-zinc-800`}
      role="note"
      aria-label={`Regional addition from ${regionLabel}`}
    >
      {lang && (
        <header className="mb-1 text-[11px] italic text-zinc-500 dark:text-zinc-400">
          translated from {lang}
        </header>
      )}
      <MarkdownProse text={blockDisplayText(block)} />
    </aside>
  );
}

// ── Conflict callout — structured HP vs KCAD decision ────────────────────

function ConflictCallout({ block }: { block: ConsolidatedBlock }) {
  const regionLabel = friendlyRegionLabel(block.source);
  const color = regionColorClasses(regionLabel);
  const severity = block.conflict?.severity ?? "material";
  const description = block.conflict?.description;

  // Resolution handling: if the reviewer resolved the conflict, render the
  // decided outcome. Specific region names stay in the DetailPanel — inline
  // callouts use generic "Regional variant" language so the signable doc
  // reads cleanly.
  if (block.status === "resolved" && block.resolution) {
    if (block.resolution === "keep_hp") {
      return (
        <aside className="my-4 rounded-md border border-emerald-200 bg-emerald-50/50 px-4 py-3 text-sm dark:border-emerald-900 dark:bg-emerald-950/20">
          <header className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-emerald-800 dark:text-emerald-300">
            Resolved — H&amp;P canonical (regional variant declined)
          </header>
          {block.hp_original_text && <MarkdownProse text={block.hp_original_text} />}
          {!block.hp_original_text && description && (
            <p className="text-zinc-700 dark:text-zinc-200">{description}</p>
          )}
        </aside>
      );
    }
    if (block.resolution === "keep_kcad") {
      return (
        <aside className={`my-4 rounded-md border border-zinc-200 border-l-4 ${color.border} ${color.bg} p-4 text-sm dark:border-zinc-800`}>
          <header className={`mb-2 inline-flex items-center rounded px-2 py-0.5 text-xs font-semibold uppercase tracking-wide ${color.badge}`}>
            Resolved — regional variant supersedes H&amp;P
          </header>
          <MarkdownProse text={blockDisplayText(block)} />
        </aside>
      );
    }
    if (block.resolution === "combined" && block.edited_text) {
      return (
        <aside className="my-4 rounded-md border border-blue-200 bg-blue-50/50 px-4 py-3 text-sm dark:border-blue-900 dark:bg-blue-950/20">
          <header className="mb-1 text-xs font-semibold uppercase tracking-wide text-blue-800 dark:text-blue-300">
            Resolved — combined (regional variant merged into H&amp;P)
          </header>
          <MarkdownProse text={block.edited_text} />
        </aside>
      );
    }
    if (block.resolution === "escalated") {
      // Fall through to the structured side-by-side with an escalation tag.
    }
  }

  // Unresolved — render HP side + KCAD side side-by-side, flag for decision.
  // The KCAD side is labeled "Regional variant" rather than the specific
  // region; readers who need the region click the block to open the
  // DetailPanel.
  const escalated = block.resolution === "escalated";
  const headerColor =
    severity === "critical"
      ? "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200"
      : severity === "material"
      ? "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200"
      : "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300";
  // Mark the regionLabel as referenced to satisfy no-unused-vars.
  void regionLabel;

  return (
    <aside className="my-4 overflow-hidden rounded-md border border-red-300 dark:border-red-900" role="alert">
      <header className={`flex flex-wrap items-center gap-2 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide ${headerColor}`}>
        <span>{severity} conflict</span>
        <span className="ml-auto rounded bg-white/60 px-1.5 py-0.5 text-[11px] font-medium text-zinc-700 dark:bg-zinc-900/50 dark:text-zinc-200">
          {escalated ? "Escalated — pending QHSE decision" : "Awaiting reviewer decision"}
        </span>
      </header>
      {description && (
        <div className="border-b border-red-200 bg-red-50/50 px-3 py-2 text-sm italic text-red-900 dark:border-red-900 dark:bg-red-950/30 dark:text-red-200">
          {description}
        </div>
      )}
      <div className="grid gap-0 md:grid-cols-2">
        <div className="border-b border-zinc-200 p-3 md:border-b-0 md:border-r dark:border-zinc-800">
          <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-500">
            H&amp;P canonical position
          </div>
          {block.hp_original_text ? (
            <MarkdownProse text={block.hp_original_text} />
          ) : (
            <div className="text-sm italic text-zinc-500">(HP text unavailable)</div>
          )}
        </div>
        <div className={`${color.bg} p-3`}>
          <div className={`mb-1 inline-flex items-center rounded px-2 py-0.5 text-xs font-semibold uppercase tracking-wide ${color.badge}`}>
            Regional variant
          </div>
          <MarkdownProse text={blockDisplayText(block)} />
        </div>
      </div>
    </aside>
  );
}

// ── Section renderer ──────────────────────────────────────────────────────

function SectionRenderer({
  section,
  kcadByFilename,
  override,
  isStale,
  isPolishing,
  canPolish,
  showDetails,
  onPolish,
  onClearPolish,
}: {
  section: Section;
  kcadByFilename: Map<string, DocumentContext["kcad"][number]>;
  /** LLM-polished prose for this section, if the reviewer has asked for one. */
  override?: UnifiedOverride;
  /** A block in this section has been mutated since the override was generated. */
  isStale?: boolean;
  /** A polish request for this section is in-flight. */
  isPolishing?: boolean;
  /** The view allows mutations (document not published). */
  canPolish?: boolean;
  /** When true, show polish controls, stale badge, refinement prompt.
   *  When false, render clean markdown with no UI chrome — used by default
   *  for the signable output view. */
  showDetails?: boolean;
  onPolish?: (headingPath: string, userPrompt?: string) => void;
  onClearPolish?: (headingPath: string) => void;
}) {
  // Combine consecutive HP blocks (hp_original + user_added) into canonical prose.
  // Keeping them together preserves HP's numbering and flow.
  const hpTextRaw = section.hpBlocks.map(blockDisplayText).filter(Boolean).join("\n\n");
  // HP chunks frequently start with their own markdown heading ("## 2. Definitions")
  // which duplicates the <HeadingTag> we render from heading_path. Strip the
  // leading markdown heading whenever it matches the section title — otherwise
  // the reader sees the same heading twice in a row.
  const hpText = stripRedundantLeadingHeading(hpTextRaw, section.heading.title);

  const useOverride = !!override;

  return (
    <section className="mb-8 group/section">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <HeadingTag depth={section.heading.depth}>{section.heading.title}</HeadingTag>
        </div>
        {showDetails && canPolish && onPolish && (
          <SectionPolishControls
            headingPath={section.headingPath}
            override={override}
            isStale={!!isStale}
            isPolishing={!!isPolishing}
            onPolish={onPolish}
            onClearPolish={onClearPolish}
          />
        )}
      </div>

      {useOverride ? (
        <>
          <MarkdownProse text={override.text} />
          {showDetails && override.fallback_to_block_level && (
            <p className="mt-2 text-xs italic text-amber-700 dark:text-amber-400">
              LLM polish fell back to block-level rendering — the merger could not
              produce a validated unified rewrite. Clear and retry or edit directly.
            </p>
          )}
          {showDetails && canPolish && onPolish && (
            <RefinementPrompt
              headingPath={section.headingPath}
              isPolishing={!!isPolishing}
              onRefine={(prompt) => onPolish(section.headingPath, prompt)}
            />
          )}
        </>
      ) : (
        <>
          {hpText && <MarkdownProse text={hpText} />}
          {/* Conflicts first — they demand attention before any regional
              addition is read. Hidden in clean-mode (non-details) when no
              override exists: user hasn't polished yet, but we still need to
              surface conflicts because they block a safe sign-off. */}
          {section.conflictBlocks.map((b) => (
            <ConflictCallout key={b.id} block={b} />
          ))}
          {/* Regional additions — show in detail mode OR when unpolished.
              When auto-consolidate ran, every such section has an override
              and this branch doesn't execute, so in clean-mode the reader
              sees polished prose only. */}
          {section.kcadBlocks.map((b) => (
            <RegionalCallout
              key={b.id}
              block={b}
              kcadMeta={kcadByFilename.get(b.source.document || "")}
            />
          ))}
        </>
      )}
    </section>
  );
}

function RefinementPrompt({
  headingPath,
  isPolishing,
  onRefine,
}: {
  headingPath: string;
  isPolishing: boolean;
  onRefine: (prompt: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState("");

  if (!open) {
    return (
      <div className="mt-3">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="text-xs text-zinc-500 hover:text-zinc-800 underline underline-offset-2 dark:text-zinc-400 dark:hover:text-zinc-200"
          title="Tell the LLM how to refine this section"
        >
          Refine with a custom instruction…
        </button>
      </div>
    );
  }

  const submit = () => {
    const t = prompt.trim();
    if (!t) return;
    onRefine(t);
    setPrompt("");
    setOpen(false);
  };

  return (
    <div className="mt-3 rounded border border-zinc-300 bg-zinc-50 p-3 text-xs dark:border-zinc-700 dark:bg-zinc-900/40">
      <label htmlFor={`refine-${headingPath}`} className="mb-1 block font-medium text-zinc-600 dark:text-zinc-300">
        Refine this section
      </label>
      <textarea
        id={`refine-${headingPath}`}
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="e.g. Make this more concise. Or: Emphasize the offshore-specific requirements. Or: Remove the Kuwait-Pakistan overlap and combine as a single bullet list."
        rows={3}
        className="w-full rounded border border-zinc-300 bg-white p-2 text-xs placeholder:text-zinc-400 focus:outline-none focus:ring-1 focus:ring-primary dark:border-zinc-700 dark:bg-zinc-950"
        disabled={isPolishing}
      />
      <div className="mt-2 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setPrompt("");
          }}
          className="px-2 py-0.5 text-xs text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
          disabled={isPolishing}
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={isPolishing || prompt.trim() === ""}
          className="px-2.5 py-0.5 text-xs rounded border border-zinc-300 text-zinc-700 hover:bg-zinc-100 hover:text-zinc-900 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          {isPolishing ? "Refining…" : "Refine"}
        </button>
      </div>
    </div>
  );
}

function SectionPolishControls({
  headingPath,
  override,
  isStale,
  isPolishing,
  onPolish,
  onClearPolish,
}: {
  headingPath: string;
  override?: UnifiedOverride;
  isStale: boolean;
  isPolishing: boolean;
  onPolish: (headingPath: string) => void;
  onClearPolish?: (headingPath: string) => void;
}) {
  const hasOverride = !!override;

  if (isPolishing) {
    return (
      <span className="shrink-0 inline-flex items-center gap-1.5 rounded border border-blue-300 bg-blue-50 px-2 py-0.5 text-xs text-blue-800 dark:border-blue-800 dark:bg-blue-950/30 dark:text-blue-200">
        <svg className="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeOpacity="0.25" />
          <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
        </svg>
        Polishing…
      </span>
    );
  }

  return (
    <div className="shrink-0 flex items-center gap-1.5">
      {hasOverride && isStale && (
        <span
          className="inline-flex items-center gap-1 rounded border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200"
          title="Blocks in this section were edited after the last polish — re-polish to apply."
        >
          Stale
        </span>
      )}
      {hasOverride && !isStale && (
        <span
          className="inline-flex items-center gap-1 rounded border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-200"
          title={`Polished at ${override?.generated_at ?? "—"}`}
        >
          Polished
        </span>
      )}
      <button
        type="button"
        onClick={() => onPolish(headingPath)}
        className="text-xs px-2 py-0.5 rounded border border-zinc-300 text-zinc-700 hover:bg-zinc-100 hover:text-zinc-900 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
        title={
          hasOverride
            ? "Re-run the LLM polish for this section, honoring current reviewer edits"
            : "Apply current reviewer decisions to this section as unified prose via LLM"
        }
      >
        {hasOverride ? "Re-polish" : "Polish"}
      </button>
      {hasOverride && onClearPolish && (
        <button
          type="button"
          onClick={() => onClearPolish(headingPath)}
          className="text-xs px-1.5 py-0.5 rounded text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
          title="Revert to deterministic block-level rendering for this section"
        >
          Clear
        </button>
      )}
    </div>
  );
}

// ── Appendices and potential additions ───────────────────────────────────

function AppendixGroup({
  title,
  blocks,
  kcadByFilename,
  subtitle,
  appendixLetter,
  appendix,
}: {
  title: string;
  blocks: ConsolidatedBlock[];
  kcadByFilename: Map<string, DocumentContext["kcad"][number]>;
  subtitle?: string;
  /** Letter used to prefix block numbers inside this appendix (A.1, A.2…). */
  appendixLetter?: string;
  /** Full appendix metadata — supplies the 4-variant scope header. */
  appendix?: Appendix;
}) {
  if (blocks.length === 0) return null;

  // Group blocks by the HP section they originated from (heading_path set by
  // reconstruction). Gives the appendix a predictable reading order that
  // mirrors HP's structure. Blocks without an HP anchor fall into a trailing
  // "Other" subgroup so nothing silently disappears.
  const bySection = new Map<string, ConsolidatedBlock[]>();
  for (const b of blocks) {
    const h = b.heading_path || "Other";
    if (!bySection.has(h)) bySection.set(h, []);
    bySection.get(h)!.push(b);
  }
  const sectionEntries = Array.from(bySection.entries());

  // Sequential numbering across the whole appendix — A.1, A.2, A.3, …
  // stable because iteration order preserves insertion order.
  let counter = 0;
  const itemNumber = (): string => {
    counter += 1;
    return `${appendixLetter ?? "A"}.${counter}`;
  };

  const scope = appendix?.scope;
  const scopeChips: Array<[string, string]> = [];
  if (scope?.region) scopeChips.push(["Region", scope.region]);
  if (scope?.environment) scopeChips.push(["Environment", scope.environment]);
  if (scope?.rig) scopeChips.push(["Rig", scope.rig]);
  if (scope?.customer) scopeChips.push(["Customer", scope.customer]);

  return (
    <section className="mt-12 border-t border-zinc-200 pt-6 dark:border-zinc-800">
      <HeadingTag depth={1}>{title}</HeadingTag>
      {scopeChips.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-zinc-500">Scope:</span>
          {scopeChips.map(([label, value]) => (
            <span
              key={label}
              className="inline-flex items-center gap-1 rounded bg-zinc-100 px-2 py-0.5 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
            >
              <span className="text-[11px] uppercase tracking-wide text-zinc-500">
                {label}
              </span>
              <span>·</span>
              <span>{value}</span>
            </span>
          ))}
        </div>
      )}
      {subtitle && (
        <p className="mb-4 text-sm italic text-zinc-600 dark:text-zinc-400">{subtitle}</p>
      )}
      {sectionEntries.map(([heading, sectionBlocks]) => {
        // Strip the leading HP doc title prefix from the heading for display
        // inside the appendix (e.g., "Hydrogen Sulfide (H2S) Policy > 4.
        // Response …" → "4. Response …"). Keeps appendix sub-headers terse.
        const parts = heading.split(">").map((s) => s.trim()).filter(Boolean);
        const leaf = parts.length > 1 ? parts.slice(1).join(" › ") : heading;
        return (
          <div key={heading} className="mb-6">
            {leaf !== "Other" && (
              <h3 className="mt-4 mb-2 text-base font-semibold text-zinc-800 dark:text-zinc-100">
                Re: {leaf}
              </h3>
            )}
            {sectionBlocks.map((b) => {
              const num = itemNumber();
              return (
                <div key={b.id} className="relative">
                  <span className="absolute -left-10 top-3 hidden text-xs font-semibold text-zinc-500 md:block">
                    {num}
                  </span>
                  {b.type === "conflict" ? (
                    <ConflictCallout block={b} />
                  ) : (
                    <RegionalCallout
                      block={b}
                      kcadMeta={kcadByFilename.get(b.source.document || "")}
                    />
                  )}
                </div>
              );
            })}
          </div>
        );
      })}
    </section>
  );
}

// ── Main component ───────────────────────────────────────────────────────

export function ConsolidatedFinalView({
  slug,
  onBackToList,
  onSwitchMode,
  embedded = false,
}: {
  slug: string;
  onBackToList: () => void;
  onSwitchMode: () => void;
  /** When true, hide the component's own top bar — parent owns chrome.
   *  Used in split-view mode where the ConsolidationPage renders the toggle. */
  embedded?: boolean;
}) {
  const queryClient = useQueryClient();
  const authUser = useAuth();
  const actor: Actor = {
    name: authUser?.name ?? "",
    email: authUser?.email ?? "",
  };

  // Use the SAME query key as the Reviewer View — every reviewer mutation
  // invalidates this key and the Unified View re-renders automatically.
  const { data: viewData, isLoading: viewLoading, error: viewError } = useQuery({
    queryKey: ["consolidated-view", slug],
    queryFn: () => fetchConsolidatedView(slug),
  });

  const { data: context, isLoading: ctxLoading } = useQuery({
    queryKey: ["consolidation-context", slug],
    queryFn: () => fetchDocumentContext(slug),
  });

  // Full appendix list — drives the scope header (Region/Rig/Customer/Env)
  // on each appendix section. Same query key the Reviewer View uses, so
  // appendix creates/deletes there invalidate and propagate here instantly.
  const { data: appendicesData } = useQuery({
    queryKey: ["appendix-list", slug],
    queryFn: () => listAppendices(slug),
  });
  const appendixById = useMemo(() => {
    const map = new Map<string, Appendix>();
    for (const a of appendicesData?.appendices ?? []) map.set(a.id, a);
    return map;
  }, [appendicesData]);

  const view: ConsolidatedView | undefined = viewData?.view;

  // Index KCAD metadata by source filename for O(1) lookups from blocks.
  const kcadByFilename = useMemo(() => {
    const map = new Map<string, DocumentContext["kcad"][number]>();
    if (context?.kcad) {
      for (const k of context.kcad) map.set(k.filename, k);
    }
    return map;
  }, [context]);

  const { sections, appendixBlocks, orphanGaps } = useMemo(() => {
    if (!view) return { sections: [] as Section[], appendixBlocks: [] as ConsolidatedBlock[], orphanGaps: [] as ConsolidatedBlock[] };
    return buildSections(view.blocks);
  }, [view]);

  // Per-section polish state: which sections the reviewer is actively polishing.
  // Keyed by heading_path. Prevents duplicate clicks and shows spinners.
  const [polishing, setPolishing] = useState<Set<string>>(new Set());
  const overrides: Record<string, UnifiedOverride> = view?.unified_overrides ?? {};

  // Auto-consolidate + detail mode — two independent UX states.
  const [autoConsolidating, setAutoConsolidating] = useState(false);
  const [autoProgress, setAutoProgress] = useState<{ done: number; total: number } | null>(null);
  // "Details" mode surfaces polish controls, stale badges, and unified_overrides
  // metadata. Default OFF — the Unified View is a signable document, not a
  // debug view. Reviewers can toggle on when they need to re-polish or
  // inspect AI rationale.
  const [showDetails, setShowDetails] = useState(false);

  // Staleness per section — two triggers:
  //   (a) a block still in the section has a history entry newer than the
  //       override's generated_at (reviewer edited/accepted/reclassified);
  //   (b) the set of blocks in the section no longer matches the override's
  //       `block_ids` snapshot (a block was dragged in or out of this section,
  //       or dismissed/removed, or had appendix_id set post-polish).
  // Either trigger marks the polish stale so the reviewer sees a prompt to
  // re-merge before trusting the unified prose.
  const staleSections = useMemo(() => {
    if (!view) return new Set<string>();
    const stale = new Set<string>();
    for (const s of sections) {
      const ov = overrides[s.headingPath];
      if (!ov) continue;
      const cutoff = ov.generated_at || "";
      const sectionBlocks = [...s.hpBlocks, ...s.kcadBlocks, ...s.conflictBlocks];

      // (a) history check
      let markedByHistory = false;
      for (const b of sectionBlocks) {
        const hist = b.history;
        if (hist && hist.length > 0 && hist[hist.length - 1].at > cutoff) {
          stale.add(s.headingPath);
          markedByHistory = true;
          break;
        }
      }
      if (markedByHistory) continue;

      // (b) block-set check — if override.block_ids is absent (legacy
      // override pre-dating this field), skip this check rather than flag
      // everything as stale.
      if (ov.block_ids && ov.block_ids.length >= 0) {
        const current = new Set(sectionBlocks.map((b) => b.id));
        const snapshot = new Set(ov.block_ids);
        if (current.size !== snapshot.size) {
          stale.add(s.headingPath);
          continue;
        }
        for (const id of snapshot) {
          if (!current.has(id)) {
            stale.add(s.headingPath);
            break;
          }
        }
      }
    }
    return stale;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, sections, overrides]);

  const handlePolish = useCallback(
    async (headingPath: string, userPrompt?: string) => {
      const current = queryClient.getQueryData<{ view: ConsolidatedView; etag: string }>(
        ["consolidated-view", slug],
      );
      const currentEtag = current?.etag ?? "";
      if (!currentEtag) return;
      setPolishing((p) => new Set(p).add(headingPath));
      try {
        await polishSection(slug, currentEtag, actor, headingPath, { userPrompt });
        await queryClient.invalidateQueries({ queryKey: ["consolidated-view", slug] });
      } catch (err) {
        if (err instanceof ConcurrencyError) {
          queryClient.setQueryData(["consolidated-view", slug], {
            view: err.currentView,
            etag: err.currentEtag,
          });
        } else {
          console.error("Polish failed:", err);
          window.alert(`Polish failed: ${(err as Error).message}`);
        }
      } finally {
        setPolishing((p) => {
          const next = new Set(p);
          next.delete(headingPath);
          return next;
        });
      }
    },
    [slug, actor, queryClient],
  );

  const handleClearPolish = useCallback(
    async (headingPath: string) => {
      const current = queryClient.getQueryData<{ view: ConsolidatedView; etag: string }>(
        ["consolidated-view", slug],
      );
      const currentEtag = current?.etag ?? "";
      if (!currentEtag) return;
      try {
        await clearSectionPolish(slug, currentEtag, headingPath);
        await queryClient.invalidateQueries({ queryKey: ["consolidated-view", slug] });
      } catch (err) {
        console.error("Clear polish failed:", err);
      }
    },
    [slug, queryClient],
  );

  /** Auto-consolidate: polish every section that has KCAD/conflict content
   *  AND either has no override or a stale one. Runs polishes sequentially
   *  (not parallel) because each polish changes the ETag; parallel calls
   *  would race. Progress indicator shows done/total. Respects published
   *  lock — no-ops on read-only docs. */
  const handleAutoConsolidate = useCallback(async () => {
    if (!view) return;
    if (view.review_status === "published") return;
    const targets = sections
      .filter((s) => s.kcadBlocks.length > 0 || s.conflictBlocks.length > 0)
      .filter((s) => !overrides[s.headingPath] || staleSections.has(s.headingPath))
      .map((s) => s.headingPath);
    if (targets.length === 0) return;

    setAutoConsolidating(true);
    setAutoProgress({ done: 0, total: targets.length });
    setShowDetails(false); // clean-mode after auto-consolidate

    for (let i = 0; i < targets.length; i++) {
      const path = targets[i];
      setPolishing((p) => new Set(p).add(path));
      const current = queryClient.getQueryData<{ view: ConsolidatedView; etag: string }>(
        ["consolidated-view", slug],
      );
      const currentEtag = current?.etag ?? "";
      if (!currentEtag) break;
      try {
        // Auto-consolidate includes PENDING KCAD/conflict blocks — the
        // reviewer clicked "merge everything as a starting point" without
        // pre-accepting each one. Per-section Polish (manual) still defaults
        // to accepted-only, since that's an intentional mid-review refinement.
        await polishSection(slug, currentEtag, actor, path, { includePending: true });
        await queryClient.invalidateQueries({ queryKey: ["consolidated-view", slug] });
      } catch (err) {
        if (err instanceof ConcurrencyError) {
          queryClient.setQueryData(["consolidated-view", slug], {
            view: err.currentView,
            etag: err.currentEtag,
          });
        } else {
          console.error(`Auto-consolidate failed on '${path}':`, err);
          // Continue with remaining sections — one bad section shouldn't abort.
        }
      } finally {
        setPolishing((p) => {
          const next = new Set(p);
          next.delete(path);
          return next;
        });
        setAutoProgress({ done: i + 1, total: targets.length });
      }
    }

    setAutoConsolidating(false);
    // Leave autoProgress visible for a moment so the user sees "done".
    setTimeout(() => setAutoProgress(null), 2500);
  }, [view, sections, overrides, staleSections, slug, actor, queryClient]);

  // Group appendix blocks by appendix_id. The first block's `appendix_name`
  // supplies the display title — blocks without a matching appendix still
  // render so nothing silently disappears.
  const appendixGroups = useMemo(() => {
    if (!view) return [] as Array<{ id: string; title: string; subtitle?: string; blocks: ConsolidatedBlock[] }>;
    const byId = new Map<string, ConsolidatedBlock[]>();
    for (const b of appendixBlocks) {
      const id = b.appendix_id || "_unassigned";
      if (!byId.has(id)) byId.set(id, []);
      byId.get(id)!.push(b);
    }
    const groups: Array<{ id: string; title: string; subtitle?: string; blocks: ConsolidatedBlock[] }> = [];
    for (const [id, blocks] of byId.entries()) {
      const name = blocks[0]?.appendix_name || id;
      groups.push({
        id,
        title: `Appendix — ${name}`,
        subtitle: `Regional supplement: ${blocks.length} block${blocks.length === 1 ? "" : "s"} assigned.`,
        blocks,
      });
    }
    return groups;
  }, [view, appendixBlocks]);

  if (viewLoading || ctxLoading) {
    return (
      <div className="p-12 text-center text-zinc-500">Loading consolidated view…</div>
    );
  }

  if (viewError || !view) {
    return (
      <div className="p-12 text-center text-red-600">
        Failed to load view: {viewError ? (viewError as Error).message : "unknown error"}
      </div>
    );
  }

  const reviewStatus: ReviewStatus = view.review_status ?? "ai_consolidated";

  return (
    <div className="flex h-full flex-col">
      {/* Top bar — hidden in embedded/split mode; parent owns chrome */}
      {!embedded && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-200 bg-zinc-50/80 px-6 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-900/80">
          <button
            onClick={onBackToList}
            className="text-zinc-600 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-zinc-100"
          >
            ← Documents
          </button>
          <div className="flex items-center gap-3">
            <StatusBadge status={reviewStatus} />
            <div className="inline-flex items-center rounded-md border border-zinc-300 p-0.5 dark:border-zinc-700">
              <span className="rounded bg-zinc-900 px-2 py-0.5 text-xs font-medium text-white dark:bg-zinc-100 dark:text-zinc-900">
                Unified Document
              </span>
              <button
                onClick={onSwitchMode}
                className="px-2 py-0.5 text-xs text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
              >
                Reviewer View
              </button>
            </div>
          </div>
        </div>
      )}

      {context && !embedded && <DocumentIdentityPanel context={context} />}
      {context && embedded && (
        <div className="border-b border-zinc-200 px-4 py-2 dark:border-zinc-800">
          <StatusBadge status={reviewStatus} />
          <span className="ml-3 text-xs text-zinc-500">
            live preview — reflects reviewer edits instantly
          </span>
        </div>
      )}

      {/* Auto-consolidate + detail-mode controls — lives above the body so
          the clean output below feels like a signable document. */}
      {reviewStatus !== "published" && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-200 bg-zinc-50/60 px-6 py-2 text-xs dark:border-zinc-800 dark:bg-zinc-900/40">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleAutoConsolidate}
              disabled={autoConsolidating}
              className="rounded border border-primary/60 bg-primary/10 px-3 py-1 text-xs font-medium text-primary hover:bg-primary/20 disabled:opacity-60"
              title="Run the LLM merger on every section with KCAD content — strips KCAD headers, removes redundancy, preserves HP authority."
            >
              {autoConsolidating ? "Auto-consolidating…" : "Auto-Consolidate All"}
            </button>
            {autoProgress && (
              <span className="text-zinc-600 dark:text-zinc-400">
                {autoProgress.done} of {autoProgress.total} sections
                {autoConsolidating ? " merged…" : " merged"}
              </span>
            )}
          </div>
          <label
            className="inline-flex cursor-pointer items-center gap-1.5 text-zinc-600 dark:text-zinc-400"
            title="Show per-section Polish / Clear controls, stale badges, and refinement prompt. Off by default for clean signable output."
          >
            <input
              type="checkbox"
              checked={showDetails}
              onChange={(e) => setShowDetails(e.target.checked)}
              className="h-3.5 w-3.5"
            />
            <span>Show details</span>
          </label>
        </div>
      )}

      {/* Body */}
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl px-8 py-10">
          {sections.length === 0 && (
            <div className="py-16 text-center text-zinc-500">
              No content to display for this document.
            </div>
          )}

          {sections.map((section) => (
            <SectionRenderer
              key={section.headingPath}
              section={section}
              kcadByFilename={kcadByFilename}
              override={overrides[section.headingPath]}
              isStale={staleSections.has(section.headingPath)}
              isPolishing={polishing.has(section.headingPath)}
              canPolish={reviewStatus !== "published"}
              showDetails={showDetails}
              onPolish={handlePolish}
              onClearPolish={handleClearPolish}
            />
          ))}

          {/* Appendices (reviewer-assigned). Letter A, B, C, … for numbering.
              Appendix metadata supplies the 4-variant scope header. */}
          {appendixGroups.map((g, i) => {
            const letter = String.fromCharCode("A".charCodeAt(0) + i);
            const meta = appendixById.get(g.id);
            return (
              <AppendixGroup
                key={g.id}
                title={`Appendix ${letter} — ${meta?.name ?? g.title.replace(/^Appendix — /, "")}`}
                subtitle={g.subtitle}
                blocks={g.blocks}
                kcadByFilename={kcadByFilename}
                appendixLetter={letter}
                appendix={meta}
              />
            );
          })}

          {/* Potential Additions — gap blocks with no HP anchor. Numbered "P.n". */}
          <AppendixGroup
            title="Potential Additions from Regional Operations"
            subtitle="KCAD content routed to this document but not yet matched to any H&P section. Candidates for new guidance or standalone policy."
            blocks={orphanGaps}
            kcadByFilename={kcadByFilename}
            appendixLetter="P"
          />

          <footer className="mt-16 border-t border-zinc-200 pt-6 text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-500">
            Rendered from current reviewer state · Built{" "}
            {view.built_at ? new Date(view.built_at).toLocaleString() : "recently"} ·{" "}
            {sections.length} section{sections.length === 1 ? "" : "s"} ·{" "}
            {appendixGroups.length + (orphanGaps.length ? 1 : 0)} appendi{(appendixGroups.length + (orphanGaps.length ? 1 : 0)) === 1 ? "x" : "ces"}
          </footer>
        </div>
      </div>
    </div>
  );
}
