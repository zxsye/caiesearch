# Project Orientation: caiesearch (SchSrch)

## 🎯 Overview
**caiesearch** (internal name: **SchSrch**) is a full-stack search engine for Cambridge (CIE) A-Level and IGCSE past papers. It allows students and tutors to search through thousands of PDFs using full-text search (searching inside the pages) or via paper codes.

## 🛠️ Technology Stack
- **Backend**: Node.js + Express
- **Database**: MongoDB (stores metadata and PDF binary chunks via `PastPaperPaperBlob`)
- **Search Engine**: Elasticsearch 6.x (indexes text content of PDF pages)
- **Frontend**: React + Redux (Server-Side Rendered)
- **Containerization**: Docker + Docker Compose

## 🏗️ Architecture & Core Logic
1. **The Indexer (`doIndex.bin.js`)**: 
   - Scans PDF files.
   - Extracts text/layout using a custom C++ addon (`lib/sspdf.js`).
   - Identifies paper identity (Subject, Year, Paper, Variant) via filename regex or cover page OCR.
   - Saves binary data to Mongo and searchable text to Elasticsearch.
2. **The Database Model (`lib/dbModel.js`)**: 
   - Defines Mongoose schemas and Elasticsearch mappings.
   - Handles the "Version 6" Elasticsearch syntax.
3. **The Router (`index.js`)**: 
   - Handles all web routes, search API, and PDF blob serving.

## 🚀 Local Hosting & Operations

### 1. Starting the Environment
The site is hosted via Docker Compose. All databases (Mongo, ES) are persistent via Docker volumes.
```bash
# Start all containers
docker-compose up -d

# Verify status
docker-compose ps
```
The site will be accessible at [http://localhost:8080](http://localhost:8080).

### 2. Compiling Native Addons
The project uses a custom C++ PDF parser (`sspdf`). This **must** be compiled inside the Linux container environment after any major changes or initial setup:
```bash
docker exec -it schsrch-www npm install
```

### 3. Compiling Frontend Assets (Webpack)
After modifying SASS or React components, you must rebuild the frontend bundles:
```bash
# One-time production build
docker exec -it schsrch-www npm run webpack

# Continuous watch (for development)
docker exec -it schsrch-www npm run webpack-dev
```

### 4. Restarting vs. Rebuilding Frontend

These two commands do different things and are not interchangeable:

| Command | What it does | When to use it |
|---------|--------------|----------------|
| `docker-compose restart www` | Stops and restarts the Node.js/Express server process | After changing **server-side** files: `index.js`, anything in `lib/`, `view/*.js` (non-SASS), `doSearch.js`, etc. |
| `docker exec -it schsrch-www npm run webpack` | Recompiles React JSX + SASS into `dist/` bundles (server keeps running) | After changing **frontend** files: `view/*.jsx`, `view/*.sass`, anything Webpack bundles |
| `docker exec -it schsrch-www npm run rebuild` | Runs webpack **then** restarts the server in one step | After changing **both** frontend and backend files, or when unsure which layer changed |

After `webpack` finishes, just refresh the browser — no server restart needed. After `restart www`, the new server code is live immediately.

**`npm run rebuild`** is the safe default when you've touched multiple files across layers — it runs webpack first, and only restarts the server if webpack succeeds (so a broken build won't leave the server in a bad state).

### 5. Database Persistence
- **MongoDB**: Stores file metadata and binary blobs via `PastPaperPaperBlob` chunks.
- **Elasticsearch**: Stores searchable text content via `PastPaperIndex`.
- Volumes: `mw-mongo-data` and `mw-es-data` survive container restarts and rebuilds.

---

## 📋 Indexing Pipeline

Papers go through three stages: **ingest → dir population → topic tagging**. Each is independent; you can pause/resume at any point.

### Understanding the Index Types

1. **`dir` (MongoDB doc field)** — per-question location map
   - Built by `Recognizer.dir()` when `ensureDir()` is called.
   - Stores page numbers, text, and position rects for each question (QP) or answer (MS).
   - Without it: Topic Browser doesn't work; MS export fails; question metadata is empty.

2. **`PastPaperIndex` (Elasticsearch)** — page-by-page full-text search
   - Built during `doIndex` when it extracts text via sspdf and indexes to ES.
   - Enables keyword search ("photosynthesis", "enzyme", etc.).
   - Quick-mode (`--quick`) skips this; rebuild later with `reIndexElasticSearch.bin.js`.

3. **Gemini topics (in `dir.dirs[i].topics`)** — curriculum tags per question
   - Built by `doLinkTopics` after `dir` exists.
   - Powers the Topic Browser sidebar filtering by syllabus topics.
   - Without it: users can't filter by "Chemical Bonding", etc.

### Features that Depend on Each Index

| Feature | Needs | Why |
|---------|-------|-----|
| Topic Browser (subtopic filtering) | QP `dir` | Maps selected topics to question numbers. Without it, can't find which questions match. |
| MS Export PDF | QP `dir` + MS `dir` | Needs QP dir to know which questions were selected, needs MS dir to locate answers in the MS. |
| Question display in browser | QP `dir` | Shows page number, question text, metadata. Without it, no question data appears. |
| Full-text search | `PastPaperIndex` | Enables keyword search. Quick-mode skips this; rebuild with `reIndexElasticSearch.bin.js`. |
| Gemini topic tagging | QP `dir` (prerequisite) | Reads `dir.dirs` to extract text per question for AI classification. |

### Stage 1: Ingest Papers (`reindex.bin.js`)

```bash
# Show all options
docker exec -it schsrch-www node reindex.bin.js --help

# Full re-index from scratch (⚠ destructive — wipes topic tags)
docker exec -it schsrch-www node reindex.bin.js --full /papers

# Full re-index in quick mode (blob storage only, no sspdf/ES — much faster)
docker exec -it schsrch-www node reindex.bin.js --full --quick /papers

# Add papers uploaded after the initial ingest (safe — doesn't modify existing docs)
docker exec -it schsrch-www node reindex.bin.js --new /papers

# Add new papers in quick mode, then repair dirs and rebuild search
docker exec -it schsrch-www node reindex.bin.js --new --quick /papers
docker exec -it schsrch-www node reindex.bin.js --repair-dirs
docker exec -it schsrch-www node reIndexElasticSearch.bin.js
```

**Quick mode (`--quick`):** Skips sspdf text extraction and Elasticsearch indexing for files whose identity (subject/time/type/paper/variant) is encoded in the filename (e.g. `9701_s20_qp_1.pdf`). Files without standard names still go through the full path (sspdf for cover-page detection). After a quick ingest, `dir` fields and search index are empty — run `--repair-dirs` then `reIndexElasticSearch.bin.js` to complete. Recommended for bulk ingests of hundreds of papers.

**Ingest checklist:**
```
┌─ After --full or --new
│
├─ Normal mode:    ✓ blobs stored  ✓ dir populated   ✓ ES indexed   → ready for Stage 2
├─ Quick mode:     ✓ blobs stored  ✗ dir empty       ✗ ES empty     → run --repair-dirs + reIndexElasticSearch
│
└─ Use --repair-dirs to backfill empty dirs (safe — skips docs already processed)
   Use reIndexElasticSearch.bin.js to rebuild search index
```

### Stage 2: Populate `dir` (question locations)

For any docs with empty `dir` (common after quick-mode ingest or when MS docs haven't been opened):

```bash
# Backfill dir for MS docs only
docker exec -it schsrch-www node reindex.bin.js --repair-ms

# Backfill dir for QP docs only
docker exec -it schsrch-www node reindex.bin.js --repair-qp

# Backfill both QP and MS dirs in one pass (safe, run after any ingest)
docker exec -it schsrch-www node reindex.bin.js --repair-dirs
```

These call `ensureDir()` on docs with empty `dir`, which runs the recognizer and saves the result. Safe to run anytime — skips docs that already have `dir`. MS export also calls `ensureDir()` on demand, so never-viewed MS docs get indexed on first export.

### Stage 3: Link Topics to Syllabus (`doLinkTopics.bin.js`)

After `dir` is populated, tag questions with curriculum topics:

```bash
GEMINI_API_KEY=$GEMINI_API_KEY docker exec -it schsrch-www node doLinkTopics.bin.js
```

- Reads **QP docs only** (MS docs are never touched).
- For each QP, sends question text to Gemini and writes `topics: [...]` to each `dir.dirs[i]`.
- Syllabus definitions live in [`lib/tagging/`](lib/tagging/) (JSON per subject/level).
- Safe to re-run: only updates `topics` fields, does not remove or recreate docs.

> [!NOTE]
> Requires `GEMINI_API_KEY` environment variable.

---

## Common Commands

```bash
# Start the stack
docker-compose up -d

# Rebuild frontend JS after JSX/SASS changes
docker exec -it schsrch-www npm run webpack

# Run tests (requires native sspdf.node — use inside Docker)
docker exec -it schsrch-www npm test

# Full workflow: ingest new papers, populate dirs, rebuild search
docker exec -it schsrch-www node reindex.bin.js --new /papers
docker exec -it schsrch-www node reindex.bin.js --repair-dirs
docker exec -it schsrch-www node reIndexElasticSearch.bin.js
GEMINI_API_KEY=$GEMINI_API_KEY docker exec -it schsrch-www node doLinkTopics.bin.js
```

> [!IMPORTANT]
> **Dropbox Sync Warning**: If you encounter `Unknown system error -35` during indexing, it is likely because macOS is offloading the PDF files to the cloud. **Ensure the Dropbox folder is set to "Make available offline"** before indexing.

## 📁 Key Directories
- `src/`: React frontend source code.
- `lib/`: Core backend logic (PDF processing, search logic, database models).
- `view/`: Legacy templates and utility functions (e.g., `CIESubjects.js`).
- `dist/`: Compiled frontend assets (generated by Webpack).

## 🎨 Current Status: Redesign
As of May 2026, a redesign is planned to modernize the UI (inspired by RevisionDojo).
- **Plan Reference**: [redesign_plan.md](file:///Users/zilin/.gemini/antigravity/brain/0f57d969-e535-4da8-a578-5298f4e34afb/redesign_plan.md)

---
*Note for future agents: Always verify that the Docker daemon is running and that the Elasticsearch version remains 6.8.x for compatibility with the current mapping logic.*
