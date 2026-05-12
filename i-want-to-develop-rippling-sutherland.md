# Topic-filtered question browser & test generator

## Context

Topic tagging now exists end-to-end: `doLinkTopics.bin.js` writes per-question (and per-subpart) topic strings into `doc.dir.dirs[i].topics` / `doc.dir.dirs[i].subparts[].topics` ([dbModel.js:8-22](lib/dbModel.js:8), [doLinkTopics.bin.js:239-247](doLinkTopics.bin.js:239)), and the existing per-paper "ques" tab in the paper viewer already shows topics inline ([paperviewer.jsx:374-393](view/paperviewer.jsx:374)).

What's missing is a **cross-paper** view: pick one or more topics from a subject's syllabus and see every matching question across years/papers/variants, with filters/ordering, and (eventually) export the selection as a question PDF + a matching markscheme PDF.

The list view itself is the small half. The bigger payoff is the **backend filter + sample + sort API** that powers both the list view today and the export tomorrow. The plan below ships the API + a list UI in v1, scaffolds (but does not build) the export pipeline, and leaves clear extension points for inline question previews and subpart-level highlighting.

---

## Decisions (confirmed with user)

| Question | Decision |
|---|---|
| Tag granularity | Topic OR subtopic (hierarchical picker; topic-level expands to all its subtopics) |
| Subpart match | Show whole question; mark which subparts match (chip in list UI) |
| Subpart highlighting in PDF | **Deferred** — no subpart rects in current data; would need re-tagging pass |
| Export | Two separate downloadable PDFs: questions PDF + markscheme PDF for the same selection |
| MS chopping | Feasible — uses same `qN` / `qNRect` / `page` data on MS docs ([recognizer.js:129](lib/recognizer.js:129)) |
| v1 UI | List rows (qN, paper, year, topics) → click opens existing paperviewer at that question. Architected so inline previews can be added later. |
| Query scope | One subject + one level (AS or A2) per query |
| Proportions | Percentages with a total count |
| Paper filter | Paper number (1/2/3) + optional variant restriction (11/12/13) |

---

## Architecture overview

```
                              ┌─────────────────────────────────────┐
                              │  GET /topics/syllabus/?subject&level │
                              │   → topic→subtopics tree (from        │
                              │     lib/tagging/{subj}/{level}.json)  │
                              └─────────────────────────────────────┘
                                            │
   ┌──────────────────────┐                 │
   │  Topic browser UI    │ ◄───────────────┘
   │  (new React route)   │
   │                      │       ┌──────────────────────────────────┐
   │  - syllabus tree     │       │  POST /topics/questions/           │
   │  - filter sidebar    │ ────► │   body: QueryRequest               │
   │  - results list      │       │   → resolveTopics → mongoQuery     │
   │  - export buttons    │ ◄──── │   → sort/sample → QuestionRow[]    │
   └──────────────────────┘       └──────────────────────────────────┘
            │                                      │
            ▼                                      ▼
   click row → /doc/:id?p=N         (later) POST /topics/export/qp.pdf
   (existing paperviewer)                   POST /topics/export/ms.pdf
```

All filtering/sorting/sampling happens in **one shared service module** so the same logic powers the list view, the question PDF export, and the markscheme PDF export.

---

## Backend

### New file: `lib/topicQuery.js`
Pure module (no Express dep). Single shared resolver used by all topic routes.

Public surface:
```js
module.exports = {
  // Loads taxonomy from lib/tagging/{subject}/{level}.json
  // Returns {topics: [{topic_id, topic_name, subtopics: [{name, ...}]}]}
  loadSyllabus(subject, level),

  // Given a request {subject, level, selections: [{kind: 'topic'|'subtopic', name}], ...},
  // expand topic-level selections into their subtopic strings (using syllabus),
  // then return the flat Set<string> of subtopic strings to match against doc.dir.dirs[i].topics.
  resolveSelectedTags(req),

  // Main query. Returns {rows: QuestionRow[], meta: {total, perTopicCounts}}
  // QuestionRow = {
  //   docId, subject, time, paper, variant, type: 'qp'|'mcq',
  //   qN, page, qNRect, topics, subparts, matchedSubparts: ['b','c'],
  //   matchedTopics: ['Bonding']
  // }
  queryQuestions(req),
}
```

`queryQuestions` flow:
1. Build Mongo selector: `{subject, type: {$in: ['qp']}, time: {$regex}, paper: {$in}, variant: {$in?}}`. Year filter compiled into a regex on the `time` field (`time` = season+yy, e.g. `s23`).
2. `PastPaperDoc.find(selector, {fileBlob: 0})` (don't pull blobs).
3. In-memory walk `doc.dir.dirs`, keep questions where `dir.topics` ∩ selectedTags ≠ ∅ **OR** any `subparts[i].topics` ∩ selectedTags ≠ ∅. Record which subparts matched.
4. Apply ordering (see below).
5. Apply sampling: `maxQuestions` cap, or per-topic percentages (described below).

### Filter / request shape (`QueryRequest`)
```js
{
  subject: '9701',
  level: 'AS',                              // or 'A2'
  selections: [                             // OR'd; topic kind expands to all its subtopics
    {kind: 'topic',    name: 'Atoms, molecules and stoichiometry'},
    {kind: 'subtopic', name: 'Chemical Bonding'},
  ],
  years: {from: 2018, to: 2024},            // optional; both inclusive
  seasons: ['m', 's', 'w'],                 // optional; default = all
  papers: [1, 2],                           // paper numbers; required (default = all known)
  variants: [11, 12, 13],                   // optional; if absent, all variants of selected papers
  includeMcq: true,                         // include type:'mcqMs'? Default true if paper is MCQ.
  ordering: {
    mode: 'deterministic' | 'random',
    seed: 12345,                            // optional; only for random
    // deterministic uses paperutils.funcSortSet (year asc → m/s/w → paper → variant) then qN asc
  },
  sampling: {
    mode: 'all' | 'cap' | 'proportions',
    total: 20,                              // for cap & proportions
    perTopic: [                             // for proportions; percentages must sum ≤ 100
      {topic: 'Chemical Bonding',   pct: 50},
      {topic: 'Chemical Energetics', pct: 30},
      {topic: 'Chemical Equilibria', pct: 20},
    ],
  },
}
```

### Ordering
- **Deterministic**: reuse `PaperUtils.funcSortSet` from [view/paperutils.js:73](view/paperutils.js:73) (already does subject → year asc → m/s/w → paper → variant). Tie-break on `qN` asc. **Note**: `paperutils.js` lives under `view/` but is plain JS — require it directly from `lib/topicQuery.js` (no React imports).
- **Random**: Mulberry32 PRNG seeded from `ordering.seed` (or `Date.now()` if absent); Fisher–Yates shuffle. Persisting the seed in the response lets users get a reproducible test.

### Sampling
- `cap`: take first `total` after ordering.
- `proportions`: bucket matched questions by their *primary matched topic* (first topic in `matchedTopics` that the user selected); independently sort/shuffle each bucket per `ordering`; take `round(total * pct/100)` from each bucket; remaining slots → highest-pct bucket. Return them in the global ordering too.

### Routes (added to `index.js`)
- `GET /topics/syllabus/?subject=9701&level=AS` → JSON tree from `lib/tagging/{subject}/{level}.json`. Returns `{topics: [...]}` or 404 if file missing.
- `POST /topics/questions/` → JSON body = `QueryRequest`; returns `{rows, meta}`.
- `POST /topics/export/qp.pdf` → **stub for now** (returns 501 with a TODO body). The route file structure is in place so the export work is just filling in the handler.
- `POST /topics/export/ms.pdf` → same stub.

These mount alongside the other `/dirs/...` routes around [index.js:290](index.js:290).

### Markscheme chopping (design only — implementation deferred to v2)
For each `QuestionRow`, look up the matching MS doc:
```js
PastPaperDoc.findOne({subject, time, paper, variant, type: 'ms'})
```
Walk its `dir.dirs`, find the entry with same `qN`, then crop pages from `(msEntry.page, msEntry.qNRect.y1)` through the next msEntry's `(page, qNRect.y1)` (or end of doc). Render via `sspdf` and append to a PDF being assembled (likely with `pdf-lib`). Multi-page MS spans handled by cropping bottom of start page + full middle pages + top of end page. **Add this as a separate ticket once v1 ships.**

---

## Frontend

### New React component: `view/topicbrowser.jsx`
Top-level view with three panes (mirroring sidebar/main layout already present in `schsrch.jsx`):
1. **Left**: subject/level selector + syllabus tree (collapsible topic nodes; checkbox at topic level expands to all its subtopics; checkbox at subtopic level for fine-grained).
2. **Right (filters)**: year range slider, season checkboxes, paper-number multi-select, variant multi-select (revealed via "Advanced"), MCQ toggle, ordering radio (deterministic / random + seed), sampling mode (all / cap / proportions) + a per-topic percentage editor when `proportions` is chosen.
3. **Center (results)**: list of `QuestionRow`s. Each row: `Q{qN}` · `9701/s23/12 p1v2` · matched-topic chips · subpart chip ("matches (b)") if applicable. Click → routes to existing paper viewer at the question (uses the existing centering machinery in [paperviewer.jsx:819-831](view/paperviewer.jsx:819) — link as `/doc/{docId}?p={page}#q{qN}` and add a small handler in `paperviewer.jsx` to honour the `#q{qN}` hash by calling its existing `centerOn(dd)` with the matching dir entry).

**Reuse, don't recreate**:
- Topic chip rendering: copy class names from [paperviewer.jsx:374-393](view/paperviewer.jsx:374) (`question-topics`, `subparts-list`).
- Sort: `PaperUtils.funcSortSet`.
- Subject metadata: `view/CIESubjects.js`.
- Time → human label: `PaperUtils.myTimeToHumanTime`.

### Component structure (extension points)
```
<TopicBrowser>
  <SyllabusTree />        // can be reused outside browser later
  <FilterPanel />
  <ResultList rows={rows} renderRow={DefaultRow} />   // ← prop allows swapping in image-preview row in v2
  <ExportBar />           // currently disabled buttons w/ tooltip "coming soon"
</TopicBrowser>
```
`ResultList`'s `renderRow` prop is the seam for the future inline-preview enhancement; `DefaultRow` is the v1 text row.

### Routing entry
- New route: `/topics/` → renders `TopicBrowser`. Wire into the existing client router (Redux/appstate; see `view/appstate.js` and `view/clientrender.jsx`).
- Sidebar entry in `view/sidebar.jsx`: "Browse by topic" link.
- SSR entry in `view/serverrender.jsx` for parity.

### Sass
Add a new section `topic-browser` to `view/layout.sass` re-using existing chip + list styles.

---

## Files to create / modify

**Create**
- `lib/topicQuery.js` — shared filter/sort/sample logic.
- `view/topicbrowser.jsx` — top-level view.
- `view/syllabustree.jsx` — collapsible topic/subtopic tree.
- `test/topicQuery.js` — unit tests for `resolveSelectedTags`, ordering, sampling proportions.

**Modify**
- `index.js` — mount `/topics/syllabus/`, `/topics/questions/`, and the two stub export routes near line 290.
- `view/paperviewer.jsx` — honour `#q{qN}` hash on mount: look up matching `dir.dirs` entry and call existing `centerOn`.
- `view/sidebar.jsx` — add "Browse by topic" entry.
- `view/appstate.js`, `view/clientrender.jsx`, `view/serverrender.jsx`, `view/schsrch.jsx` — register `/topics/` route.
- `view/layout.sass` — `topic-browser` styles.

**Untouched (intentionally)**
- `doLinkTopics.bin.js`, `lib/tagging/*` — no changes; we read what's already produced.
- Markscheme chopping pipeline — design noted above; implementation deferred to a follow-up.

---

## Defaults applied without asking (call out if wrong)

- **Year filter**: range (default = "all years present in DB"), not multi-select. Easier UI; covers test-generation cases.
- **Random seed**: optional; if absent, server picks one and returns it in `meta.seed` so the client can reproduce.
- **Per-topic count for `proportions`**: rounding leftovers go to the topic with the highest `pct`.
- **Subpart marker in v1**: text chip, not a coloured box (no rect data). PDF-export grey box is a v2 concern.
- **MCQ**: included by default when the picked paper is an MCQ paper; `includeMcq` flag lets users exclude.

---

## Verification

1. **Unit (no Docker needed)** — `npm test` after wiring `test/topicQuery.js`. Cover:
   - `resolveSelectedTags`: topic kind expands to its subtopics; subtopic kind passes through.
   - `queryQuestions` ordering: deterministic order matches `funcSortSet` + qN asc; random with same seed is reproducible.
   - `sampling.proportions`: counts add up to `total`; rounding leftovers go to highest-pct bucket.
   - Subpart matching: question with only one matching subpart is still returned, and `matchedSubparts` is correct.

2. **Backend (Docker)** — bring up `docker-compose up -d`, then:
   ```bash
   curl 'http://localhost:8080/topics/syllabus/?subject=9701&level=AS'
   curl -X POST -H 'Content-Type: application/json' \
     -d '{"subject":"9701","level":"AS","selections":[{"kind":"subtopic","name":"Chemical Bonding"}],"papers":[1],"ordering":{"mode":"deterministic"},"sampling":{"mode":"all"}}' \
     'http://localhost:8080/topics/questions/'
   ```
   Expect JSON with `rows[]` referencing real 9701 papers from the indexed corpus; spot-check that one of those papers, opened in the paper viewer, has `Chemical Bonding` listed on the matching question.

3. **Frontend** — rebuild assets:
   ```bash
   docker exec -it schsrch-www npm run webpack
   ```
   Open http://localhost:8080/topics/, pick 9701 / AS, expand "Atoms, molecules and stoichiometry", check a subtopic, set Years 2020–2024, set Papers = [1], hit Apply. Confirm:
   - Result rows appear, ordered year asc / m→s→w / variant 1→2→3 / qN asc.
   - Clicking a row opens the existing paper viewer scrolled to the right question.
   - Switching to "random" with a seed gives the same order on refresh.
   - "proportions" sampling with two topics summing to 100% returns the right counts.

4. **Edge cases to manually probe**
   - Subject with no `lib/tagging/{subject}/{level}.json` file → friendly 404 + UI empty-state.
   - A question whose `topics` array is empty but a `subparts[].topics` matches → still in results, with subpart chip.
   - Total count larger than matched pool → return all matches; `meta.warning = 'requested 50, only 23 matched'`.
