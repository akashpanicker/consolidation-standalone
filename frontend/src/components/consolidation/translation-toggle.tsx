/** Back-compat shim. The translation hook + components now live in
 *  `@/components/shared/translation` and are consumed by all four tabs
 *  (Extraction, Metadata, Chunks, Consolidation). Existing consolidation
 *  imports keep working via these re-exports. */
export {
  type TranslationMode,
  type UseTextTranslationResult as UseChunkTranslationResult,
  useTextTranslation as useChunkTranslation,
  LanguageBadge,
  TranslateToggle,
  TranslationError,
} from "@/components/shared/translation";
