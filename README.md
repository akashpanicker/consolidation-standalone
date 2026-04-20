# Consolidation Standalone Bundle

A self-contained copy of the **Consolidation page** from the Document Extraction project, with all data, backend code, and credentials needed to run it locally. Intended for a frontend developer to iterate on the UI without spinning up the full pipeline (extraction, chunking, clustering, embeddings, etc.).

Everything unrelated to the Consolidation page has been stripped. Three sample HP documents are included with their AI-consolidated views, merged narrative outputs, and KCAD source metadata.

## ⚠️ Credentials warning

`.env` ships with **live Azure OpenAI keys** (`OPENAI_API_KEY` and `GPT54_API_KEY`). These keys:

- Bill to the owner's Azure subscription.
- Should **not** be checked into public git, shared externally, or posted anywhere.
- Should be **rotated after the handoff** by the owner, and replaced here with the new values.

The keys power two live LLM features:
1. **Section polish** (`POST /sections/polish`) — the narrative merger that rewrites a section integrating KCAD additions.
2. **Translate / detect-language** — inline translation of non-English KCAD chunks in the review UI.

Every other consolidation feature reads static JSON from `cache/` and needs no network. If you revoke the keys or set them to garbage, the UI still fully works except for polish + translate.

## What's in the bundle

```
consolidation-standalone/
├── .env                          ← Azure OpenAI credentials
├── config.yaml                   ← backend config (paths, model names)
├── requirements.txt              ← Python deps
├── api/                          ← trimmed FastAPI backend
│   ├── main.py                       — only consolidation + translation routers
│   ├── state.py                      — minimal startup (cache init)
│   ├── cache.py, config.py, llm.py   — shared infrastructure
│   ├── translation.py                — language detect + translate
│   └── routers/
│       ├── consolidation.py          — list / view / actions / polish / undo / ...
│       └── translation.py            — POST /translate, POST /detect-language
├── consolidation/                ← narrative merger package
│   ├── narrative_merger.py
│   └── config.py
├── prompts/
│   └── narrative_merge.txt           — polish prompt
├── cache/
│   ├── consolidation/
│   │   ├── views/                    — 3 AI-consolidated HP views (source of truth)
│   │   └── merged/                   — 2 narrative-merged documents
│   ├── metadata/
│   │   ├── document_details/         — canonical title/scope/purpose per doc
│   │   └── concept_classification/   — primary/secondary concept per doc
│   ├── translations/                 — warm content-hash cache
│   └── language_detections/          — warm content-hash cache
└── frontend/                     ← React/Vite SPA, consolidation only
    ├── package.json                  — MSAL removed
    ├── vite.config.ts                — binds 127.0.0.1, proxies /api → :8000
    └── src/
        ├── main.tsx                  — no MsalProvider
        ├── auth/AuthGate.tsx         — stubbed (pass-through)
        ├── hooks/useAuth.ts          — stubbed (dev@example.com)
        ├── components/consolidation/ — the actual page
        ├── components/layout.tsx     — simplified (no multi-view nav)
        ├── components/shared/        — translation widget
        └── components/ui/            — shadcn primitives
```

### What was removed vs the full project

Backend: extraction, chunking, clustering, metadata jobs, pipeline orchestration, Azure blob sync, job tracker, token budget module.

Frontend: the Documents tab, Clustering tab, Search page, Taxonomy tab, the sidebar with document search + source filter + job panel, all MSAL auth (replaced with a dev-user stub), the metadata/extraction/chunks/clustering API clients, unused shared components (batch dialog, cost badge, run config).

### Dev user attribution

Every block-level review action (accept / dismiss / edit / comment / appendix assign / polish) sends `X-User-Email` + `X-User-Name` headers from the signed-in user. In this standalone bundle that user is hardcoded to `dev@example.com` / `Dev User` via `src/hooks/useAuth.ts`. Change the constants in that file if you want a different attribution while developing.

## Prerequisites

- **Python** 3.11+
- **Node** 20+ (tested with 20.x / 22.x)
- **npm** 10+
- Mac / Linux. Windows likely works but not verified.

## Run it

### 1) Backend

```bash
cd consolidation-standalone
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python3 -m uvicorn api.main:app --host 127.0.0.1 --port 8000 --reload
```

You should see:

```
api.cache INFO Azure blob cache disabled
api.state INFO Consolidation standalone startup complete
Uvicorn running on http://127.0.0.1:8000
```

Sanity-check:

```bash
curl http://127.0.0.1:8000/api/v1/consolidation/documents | head
# → 3 HP documents, each with an additions / conflicts / gaps summary
```

### 2) Frontend (new terminal)

```bash
cd consolidation-standalone/frontend
npm install
npm run dev
```

Open **http://127.0.0.1:5173/** — the Consolidation document list loads directly (no login screen).

Pick one of the three sample documents. The three view modes are:

- **Review** — full reviewer panel, accept/dismiss/edit/comment on each block.
- **Unified** — preview of the signable output.
- **Split ⇄** — reviewer on the left, unified preview on the right; edits propagate instantly.

Mutations write back to `cache/consolidation/views/<slug>.json` atomically, so your dev state persists across restarts.

## API endpoints available

Base prefix: `/api/v1`

| Method | Path | Purpose |
| --- | --- | --- |
| GET    | `/consolidation/documents` | List consolidated HP docs with summary stats. |
| GET    | `/consolidation/documents/{slug}/consolidated` | Full view JSON. Sets ETag. |
| GET    | `/consolidation/documents/{slug}/merged` | Narrative-merged render. 404 if not generated. |
| GET    | `/consolidation/documents/{slug}/context` | HP + KCAD document identity + concept coverage. |
| POST   | `/consolidation/documents/{slug}/status` | Status transition (ai_consolidated → in_review → ...). |
| POST   | `/consolidation/documents/{slug}/blocks/{id}/action` | Accept / dismiss / edit / resolve / remove. |
| GET    | `/consolidation/documents/{slug}/blocks/{id}/history` | Version timeline. |
| POST   | `/consolidation/documents/{slug}/blocks/{id}/revert` | Revert to a specific version. |
| POST   | `/consolidation/documents/{slug}/blocks/{id}/restore` | Restore a removed block to pending. |
| POST   | `/consolidation/documents/{slug}/blocks/{id}/reclassify` | Override AI relationship label. |
| POST   | `/consolidation/documents/{slug}/blocks/{id}/comments` | Add comment (parses @mentions). |
| DELETE | `/consolidation/documents/{slug}/blocks/{id}/comments/{cid}` | Delete own comment. |
| POST   | `/consolidation/documents/{slug}/appendices` | Create scoped appendix (region/rig/customer/environment). |
| GET    | `/consolidation/documents/{slug}/appendices` | List appendices with live block counts. |
| POST   | `/consolidation/documents/{slug}/appendices/match` | Find best-matching appendix for a scope. |
| POST   | `/consolidation/documents/{slug}/appendices/assign` | Assign blocks to an appendix. |
| DELETE | `/consolidation/documents/{slug}/appendices/{id}` | Delete appendix, unassign blocks. |
| POST   | `/consolidation/documents/{slug}/blocks/add` | Insert a user-authored block. |
| POST   | `/consolidation/documents/{slug}/blocks/{id}/move` | Move one position up / down. |
| POST   | `/consolidation/documents/{slug}/blocks/{id}/move_to` | Drag-and-drop to arbitrary position. |
| POST   | `/consolidation/documents/{slug}/sections/polish` | Run narrative merger on one section. **LLM call.** |
| DELETE | `/consolidation/documents/{slug}/sections/polish` | Clear polished override. |
| POST   | `/consolidation/documents/{slug}/undo/last` | Document-level undo across blocks + polish. |
| POST   | `/consolidation/documents/{slug}/detect-languages` | Batch detect languages for KCAD blocks. **LLM call.** |
| POST   | `/translate` | Translate a single text to English. **LLM call.** |
| POST   | `/detect-language` | Detect dominant language. **LLM call.** |

All mutations require `If-Match` (ETag) for optimistic concurrency and `X-User-Email` / `X-User-Name` for audit attribution. The frontend sets these automatically; if you test with curl, copy them from the example scripts in `curl-examples.md` (or read `src/api/consolidation.ts`).

## Swagger UI

The FastAPI app exposes live OpenAPI docs at <http://127.0.0.1:8000/docs> — useful for exploring endpoints and trying them out.

## Resetting the sample views

If your edits dirty the sample views and you want a clean slate, re-copy the originals from the parent project, or re-pull this bundle.

## Troubleshooting

**Frontend loads but every API request 404s** — backend isn't running, or it's on the wrong port. The proxy is hardcoded to `127.0.0.1:8000`.

**Polish / translate returns 502** — the Azure OpenAI key is rejected or the endpoint URL in `.env` has expired. The rest of the UI still works.

**428 Precondition Required on a mutation** — the client didn't send `If-Match`. This should never happen with the bundled frontend; if you see it, check that your API client layer isn't stripping the header.

**412 Precondition Failed** — the ETag you sent doesn't match the current view state (someone else edited, or your cached copy is stale). Refetch the view and retry.
