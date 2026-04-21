import { useState } from "react";
import { DocumentList } from "./document-list";
import { DocumentReview } from "./document-review";

/** View modes per document.
 *  - "review":  full Reviewer View, own chrome
 *  - "unified": Unified Document preview, own chrome
 *  - "split":   Reviewer on the left, Unified on the right — reviewer edits
 *               propagate to the Unified preview instantly because both panes
 *               share the ["consolidated-view", slug] React Query cache key.
 *               Parent owns chrome; inner components render embedded.
 *  URL-backed so a page reload preserves the selected mode and so demo links
 *  are shareable. */
export function ConsolidationPage() {
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);

  if (!selectedSlug) {
    return <DocumentList onSelect={setSelectedSlug} />;
  }

  const backToList = () => setSelectedSlug(null);

  return (
    <DocumentReview
      slug={selectedSlug}
      onBack={backToList}
    />
  );
}
