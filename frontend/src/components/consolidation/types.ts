// ── Consolidation data types ────────────────────────────────────────────

/** Document review status. */
export type ReviewStatus = "ai_consolidated" | "in_review" | "approved" | "published";

/** A single entry in a block's version history. */
export interface HistoryEntry {
  version: number;
  action: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  user_name: string | null;
  user_email: string | null;
  at: string;
}

/** One KCAD source doc's natural-language identity for the Consolidation
 *  Review list. Title comes from `document_details.canonical.title`; region
 *  from block-level source metadata; filename as fallback/ID. */
export interface KcadSourceInfo {
  filename: string;
  title: string;
  region: string;
}

/** Summary stats for an HP document's consolidated view (from list endpoint). */
export interface ConsolidationDocSummary {
  slug: string;
  hp_filename: string;
  /** HP doc's natural-language title from document_details (falls back to filename). */
  hp_title?: string;
  review_status: ReviewStatus;
  total_additions: number;
  total_conflicts: number;
  total_gaps: number;
  total_hp_blocks: number;
  low_confidence_count: number;
  kcad_source_count: number;
  kcad_sources: string[];
  /** Per-source natural-language titles + regions. */
  kcad_source_titles?: KcadSourceInfo[];
  regions: string[];
  built_at: string | null;
  reviewed: number;
  total_reviewable: number;
}

/** A chunk's full data for the detail panel comparison. */
export interface ChunkDetail {
  heading_path: string;
  context_preamble: string;
  text: string;
  section_function: string;
  normative_mode: string;
  format: string;
  document: string;
  source_pages?: number[];
  language?: string;
}

/** Conflict information on a block. */
export interface ConflictInfo {
  detected: boolean;
  description: string;
  severity: "critical" | "material" | "minor";
}

/** A comment left on a block by a reviewer. */
export interface BlockComment {
  id: string;
  text: string;
  mentions: string[];
  user_name: string | null;
  user_email: string | null;
  at: string;
}

/** Appendix scope — which content belongs in this appendix. None means wildcard. */
export interface AppendixScope {
  region: string | null;
  rig: string | null;
  customer: string | null;
  environment: string | null;
}

/** An appendix (document-level) with a scope and live block count. */
export interface Appendix {
  id: string;
  name: string;
  scope: AppendixScope;
  created_by: string | null;
  created_at: string;
  block_count: number;
}

/** A single block in the consolidated document view. */
export interface ConsolidatedBlock {
  id: string;
  type: "hp_original" | "kcad_addition" | "conflict" | "gap" | "gap_header" | "user_added";
  text: string;
  format: "prose" | "form" | "table" | "image";
  section_function: string;
  normative_mode: string;
  heading_path: string;
  context_preamble?: string;
  /** ISO 639-1 code of the block's original language. Present for KCAD-sourced blocks. */
  language?: string;
  /** For KCAD-sourced blocks: the heading path from the KCAD source document
   *  (e.g., "Gasschutz in Europa > 2.0 Unterweisungen"). The main `heading_path`
   *  is always the HP section the block attaches to; this preserves the source
   *  document's own structural location for provenance display. */
  source_heading_path?: string;
  source: {
    document: string;
    origin: string;
    region: string | null;
    rig: string | null;
    chunk_id: string | null;
  };
  relationship: string | null;
  tier: number | null;
  additive_detail: string | null;
  conflict: ConflictInfo | null;
  ai_confidence: string | null;
  ai_reasoning: string | null;
  dimension_matches: Record<string, boolean> | null;
  hp_original_text: string | null;
  hp_chunk: ChunkDetail | null;
  kcad_chunk: ChunkDetail | null;
  status: BlockStatus;
  // User-set fields
  reviewer_note?: string;
  edited_text?: string;
  resolution?: string;
  // Appendix assignment (set when a block is routed to an appendix)
  appendix_id?: string;
  appendix_name?: string;
  // Conversation (lives outside block version history)
  comments?: BlockComment[];
  // Version history
  history?: HistoryEntry[];
}

// ── Merged (unified-narrative) document types ────────────────────────────

/** One KCAD fact that the narrative merger explicitly preserved in merged_text. */
export interface PreservedFact {
  fact: string;
  source: string;
  evidence_in_merged: string;
}

/** KCAD content deliberately not integrated (with reason). */
export interface OmittedKcadContent {
  source: string;
  summary: string;
  reason: "duplicate_of_hp" | "governance_boilerplate" | "out_of_scope" | "t2_redundant" | "other";
}

/** A HP↔KCAD operational disagreement flagged by the merger. */
export interface ConflictFlag {
  description: string;
  severity: "critical" | "material" | "minor";
  sources: string[];
}

/** Per-section merge result from the narrative merger. */
export interface MergeSectionResult {
  merged_text: string;
  preserved_kcad_facts: PreservedFact[];
  omitted_kcad_content: OmittedKcadContent[];
  conflicts_flagged: ConflictFlag[];
  merge_confidence: "high" | "medium" | "low";
  merge_notes: string;
  fallback_to_block_level: boolean;
  validation_ok?: boolean | null;
  attempts?: number | null;
  error?: string | null;
}

/** One KCAD contribution included in a section, with source traceability. */
export interface KcadContribution {
  block_id: string;
  source_document: string;
  region: string;
  heading_path: string;
  language: string;
}

/** One section of the merged document (HP section + integrated KCAD content). */
export interface MergedSection {
  heading_path: string;
  hp_block_ids: string[];
  kcad_block_ids: string[];
  hp_original_text: string;
  kcad_addition_count: number;
  kcad_sources: string[];
  /** Per-contribution provenance (region + KCAD heading path + language). */
  kcad_contributions?: KcadContribution[];
  merge_result: MergeSectionResult;
}

/** Gap block that didn't fit any HP section (shown as "Potential Additions"). */
export interface MergedGapBlock {
  block_id: string;
  heading_path: string;
  text: string;
  source: {
    document: string;
    origin: string;
    region: string | null;
    rig: string | null;
    chunk_id: string | null;
  };
  language: string;
}

/** Full merged (unified-narrative) document output. */
export interface MergedDocument {
  hp_filename: string;
  generated_at: string;
  model: string;
  prompt_hash: string;
  sections: MergedSection[];
  gap_blocks: MergedGapBlock[];
  summary: {
    total_sections: number;
    sections_with_kcad: number;
    sections_fallback: number;
    total_kcad_additions: number;
    total_preserved_facts: number;
    total_omitted: number;
    total_conflicts_flagged: number;
    total_gap_blocks: number;
    confidence_counts: { high: number; medium: number; low: number };
    overall_confidence: "high" | "medium" | "low";
  };
}

/** One section's LLM-polished unified prose.  Stored on the view keyed by
 *  heading_path. Present only for sections the reviewer has explicitly
 *  asked to polish — the deterministic block-level render is used everywhere
 *  else. The `block_ids` snapshot lets us detect "stale since last polish"
 *  (a block appeared/disappeared or was edited after `generated_at`). */
export interface UnifiedOverride {
  text: string;
  preserved_facts?: Array<{ fact: string; source: string; evidence_in_merged: string }>;
  conflicts_flagged?: Array<{ description: string; severity: "critical" | "material" | "minor"; sources: string[] }>;
  merge_confidence?: "high" | "medium" | "low" | null;
  merge_notes?: string;
  omitted_kcad_content?: Array<{ source: string; summary: string; reason: string }>;
  generated_at: string;
  generated_by?: string;
  validation_ok?: boolean;
  fallback_to_block_level?: boolean;
  block_ids?: string[];
  /** Reviewer's free-text refinement prompt (if provided) that produced this polish. */
  user_prompt?: string | null;
}

/** Full consolidated view for an HP document. */
export interface ConsolidatedView {
  hp_filename: string;
  review_status: ReviewStatus;
  blocks: ConsolidatedBlock[];
  summary: {
    total_hp_blocks: number;
    total_additions: number;
    total_conflicts: number;
    total_gaps: number;
    low_confidence_count: number;
    kcad_source_count: number;
    kcad_sources: string[];
    regions: string[];
  };
  built_at: string;
  status_history?: Array<{
    from: string;
    to: string;
    user_name: string | null;
    user_email: string | null;
    at: string;
  }>;
  /** Per-section LLM polish overrides, keyed by heading_path. Missing key =
   *  no polish yet (render deterministically). */
  unified_overrides?: Record<string, UnifiedOverride>;
}

/** Status values for blocks. */
export type BlockStatus = "unchanged" | "has_additions" | "pending" | "accepted" | "dismissed" | "edited" | "resolved" | "removed";

// ── Document context (document_details + concept_classification) ─────────

/** Canonical document identity fields from `cache/metadata/document_details`. */
export interface DocumentDetails {
  filename: string;
  available: boolean;
  canonical?: {
    document_number?: string;
    title?: string;
    revision?: string;
    effective_date?: string;
    revision_notes?: string;
  };
  /** KCAD docs often state Scope / Objective / Purpose as named fields. */
  scope?: string | null;
  objective?: string | null;
  purpose?: string | null;
  affected_entities?: string | null;
  department?: string | null;
  /** All named fields (lowercase key), in case the UI needs to surface extras. */
  named_fields?: Record<string, string>;
}

/** One concept label from the G-taxonomy. */
export interface ConceptLabel {
  code: string | null;
  name: string | null;
  tier_name?: string | null;
  confidence?: string | null;
}

/** Concept classification for a document. */
export interface ConceptClassification {
  filename: string;
  primary: ConceptLabel | null;
  secondary: Array<{ code: string | null; name: string | null }>;
}

/** Metadata context for the Unified View: HP identity + KCAD sources. */
export interface DocumentContext {
  hp: {
    filename: string;
    details: DocumentDetails;
    concepts: ConceptClassification | null;
  };
  kcad: Array<{
    filename: string;
    details: DocumentDetails;
    concepts: ConceptClassification | null;
  }>;
}

/** Whether a block requires review action. */
export function isActionable(block: ConsolidatedBlock): boolean {
  return block.type === "kcad_addition" || block.type === "conflict" || block.type === "gap";
}

/** Whether a block has been reviewed. */
export function isReviewed(block: ConsolidatedBlock): boolean {
  return ["accepted", "dismissed", "edited", "resolved"].includes(block.status);
}

// ── Language helpers ────────────────────────────────────────────────────
// Live in @/components/shared/translation and are re-exported here so
// existing consolidation call sites don't need to change.
export {
  isForeignLanguage,
  isRTL,
  languageLabel,
  languageBadge,
} from "@/components/shared/translation";

/** Plain-English label for a relationship + tier. */
export function relationshipLabel(block: ConsolidatedBlock): string {
  if (block.type === "conflict") {
    const desc = block.conflict?.description;
    return desc ? `Conflict — ${desc}` : "Conflict";
  }
  if (block.type === "gap") {
    return "New content";
  }
  const rel = block.relationship;
  const tier = block.tier;
  if (rel === "Variant" && tier === 1) {
    return block.additive_detail
      ? `Regional variant — ${block.additive_detail.slice(0, 80)}${block.additive_detail.length > 80 ? "..." : ""}`
      : "Regional variant — adds operational detail";
  }
  if (rel === "Variant" && tier === 2) {
    return "Regional adaptation — no new detail";
  }
  if (rel === "Complementary") {
    return "Supporting content";
  }
  if (rel === "Equivalent") {
    return "Already covered — no action needed";
  }
  return rel ?? "Suggested change";
}
