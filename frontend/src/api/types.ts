// ── Documents ──
export interface Document {
  filename: string;
  extension: string;
  size_kb: number;
  source: "hp" | "kcad";
  path: string;
}

// ── Extraction ──
export interface ExtractionMetadata {
  page_count: number;
  chunks: number;
  chunks_succeeded: number;
  chunks_failed: number;
  mode: string;
  model: string;
  reasoning_effort: string;
  chunk_pages: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  method?: string;
}

export interface ValidationIssue {
  category: string;
  severity: "critical" | "high" | "medium" | "low";
  page: number;
  description: string;
}

export interface ValidationResult {
  overall_quality: "good" | "acceptable" | "poor";
  auto?: { quality: string; findings: ValidationIssue[] };
  llm?: { overall_quality: string; issues: ValidationIssue[] };
  elapsed_seconds?: number;
}

/** P3.1 hard-gate decision attached by the Docling extractor. */
export interface QuarantineDecision {
  decision: "cache" | "quarantine";
  reasons: string[];
}

export interface ExtractionResult {
  file_name: string;
  success: boolean;
  error: string | null;
  markdown: string;
  /** Absolute path to the source PDF. Persisted from Docling runs. */
  pdf_path?: string | null;
  metadata: ExtractionMetadata & {
    skip_manifest?: Record<string, string>;
    page_coverage?: number;
    unaccounted_pages?: number[];
  };
  elapsed_seconds: number;
  warnings: string[];
  params_applied: Record<string, unknown>;
  extracted_at?: string;
  validation?: ValidationResult | null;
  /** P3.1 hard-gate decision (Docling path). Absent on pre-P3.1 cache entries. */
  quarantine?: QuarantineDecision | null;
  /**
   * True when the pickle lives in cache/extractions_quarantine/ rather than
   * cache/extractions/. Set by the backend endpoint — reflects which bucket
   * the payload was served from, independent of the embedded quarantine
   * decision (which is populated whether or not the doc got routed).
   */
  is_quarantined?: boolean;
}

export interface SearchResult {
  query: string;
  matches: Record<string, number>;
  total_searched: number;
}

// ── Metadata ──
export interface MetadataCapability {
  id: string;
  label: string;
  description: string;
  default_enabled: boolean;
  requires_llm: boolean;
  cache_version: string;
  runnable: boolean;
}

export interface SummaryResult {
  file_name: string;
  success: boolean;
  error: string | null;
  summary: { short_summary: string; detailed_summary: string };
  metadata: Record<string, unknown>;
  elapsed_seconds: number;
  extracted_at?: string;
}

export interface ActivityMatch {
  name: string;
  relevance: "primary" | "secondary" | "mentioned";
  evidence: string;
}

export interface ActivityDiscovered {
  name: string;
  relevance: "primary" | "secondary" | "mentioned";
  evidence: string;
  category: string;
  parent_activity: string | null;
}

export interface ActivitiesResult {
  file_name: string;
  success: boolean;
  error: string | null;
  activities: {
    matched: ActivityMatch[];
    discovered: ActivityDiscovered[];
  };
  metadata: Record<string, unknown>;
  elapsed_seconds: number;
  warnings: string[];
  extracted_at?: string;
}

export type MetadataResult = SummaryResult | ActivitiesResult;

// ── Jobs ──
export type JobStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export type FileStatus = "pending" | "succeeded" | "failed";

export interface Job {
  id: string;
  type: string;
  status: JobStatus;
  total: number;
  completed: number;
  succeeded: number;
  failed: number;
  current_file: string | null;
  filenames: string[];
  file_statuses: Record<string, FileStatus>;
  created_at: number;
  updated_at: number;
}

export interface JobProgressEvent {
  type: "init" | "progress" | "complete" | "error" | "cancelled" | "heartbeat";
  job_id?: string;
  filename?: string;
  success?: boolean;
  completed?: number;
  total?: number;
  succeeded?: number;
  failed?: number;
  error?: string;
  status?: string;
}

export interface StartJobRequest {
  filenames: string[];
  overwrite?: boolean;
  max_concurrent?: number;
  source?: "llm" | "docling" | "auto";
  llm_options?: {
    model?: string;
    reasoning_effort?: string;
    validate?: boolean;
    method?: "llm" | "docling";
  };
}

export interface StartMetadataJobRequest extends StartJobRequest {
  task_type: string;
}

// ── V2 Extraction ──
export interface V2Chunk {
  heading_path: string;
  context_preamble: string;
  text: string;
  section_function: string;
  normative_mode: string;
  format: "prose" | "form" | "table" | "image";
  source_pages: number[];
  source_bbox: Record<string, { l: number; t: number; r: number; b: number }> | null;
  source_image: string | null;
  language?: string;
}

export interface V2FrontMatter {
  title: string;
  company: string;
  scope: string;
  document_type: string;
  front_matter_summary: string;
}

export interface V2ExtractionResult {
  file_name: string;
  success: boolean;
  error: string | null;
  chunks: V2Chunk[];
  chunk_count: number;
  frontmatter: V2FrontMatter;
  metadata: {
    total_pages: number;
    windows: number;
    window_size: number;
    overlap_pages: number;
    model: string;
    reasoning_effort: string;
    input_tokens: number;
    output_tokens: number;
    cost_usd: number;
  };
  elapsed_seconds: number;
}
