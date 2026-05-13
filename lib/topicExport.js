'use strict'

const { PDFDocument } = require('pdf-lib')
const topicQuery = require('./topicQuery')

const MAX_OUTPUT_PAGES = 200

// Renderer registry — add 'crop' here in Phase 2.
const RENDERERS = {
  highlight: require('./topicExportRenderers/highlight')
}

class TopicExportError extends Error {
  constructor (code, message, status) {
    super(message)
    this.code = code
    this.status = status || 500
  }
}

// Returns the 0-based page indices covered by question qN in a sorted dir.
// qN spans from its own start page up to (but not including) the next
// question's start page, or totalPages if it is the last question.
function computePageIndices (dirs, qN, totalPages) {
  if (!Array.isArray(dirs) || dirs.length === 0) return null
  const sorted = dirs.slice().sort((a, b) => {
    const pa = (a.page | 0) - (b.page | 0)
    if (pa !== 0) return pa
    return (parseInt(a.qN) || 0) - (parseInt(b.qN) || 0)
  })
  const idx = sorted.findIndex(d => String(d.qN) === String(qN))
  if (idx < 0) return null
  const startPage = sorted[idx].page
  let endExclusive = totalPages
  const nextEntry = sorted[idx + 1]
  if (nextEntry) {
    // If the next question starts on the same page, cap to just this page.
    // If it starts on a later page, the range ends where that question begins.
    endExclusive = nextEntry.page > startPage ? nextEntry.page : startPage + 1
  }
  const indices = []
  for (let p = startPage; p < endExclusive; p++) indices.push(p)
  return indices
}

async function loadSourcePdf (doc) {
  const blob = await doc.getFileBlob()
  if (!blob || blob.length === 0) {
    throw new TopicExportError('EMPTY_BLOB', `Empty file blob for doc ${doc._id}`)
  }
  return PDFDocument.load(blob, { ignoreEncryption: true })
}

async function findMsDoc (PastPaperDoc, row, cache) {
  const key = `${row.subject}_${row.time}_${row.paper}_${row.variant}`
  if (cache.has(key)) return cache.get(key)
  const ms = await PastPaperDoc.findOne({
    subject: row.subject,
    time: row.time,
    paper: row.paper,
    variant: row.variant,
    type: 'ms'
  })
  cache.set(key, ms || null)
  return ms || null
}

function buildFilename (req, kind, questionCount) {
  const subj = req.subject || 'subject'
  const lvl = req.level || ''
  const selCount = Array.isArray(req.selections) ? req.selections.length : 0
  const topicPart = selCount === 1 ? '1topic' : `${selCount}topics`
  return `${subj}_${lvl}_${kind}_${topicPart}_${questionCount}q.pdf`
}

// Groups resolved tasks into Map<docId, Map<pageIndex, MatchInfo[]>>.
//
// MatchInfo = { qN, qNRect, matchedTopics, isQNStartPage }
//
// For "questions"-type dirs:
//   - Each task's qN is mapped to all pages it spans via computePageIndices.
//   - The start page carries the qNRect from the source dir.
//   - Continuation pages carry qNRect: null, isQNStartPage: false.
//   - Multiple tasks landing on the same (docId, pageIndex) are merged into
//     the same MatchInfo array (deduplication is natural via Map structure).
//
// For mcqMs-type dirs:
//   - The docId is added to mcqMsDocs so the emitter knows to emit ALL
//     non-cover pages (not just pages with matches).
//   - Each matched qN adds a MatchInfo to whichever page it lives on.
//
// This function is also exported so a future crop renderer can consume
// the same grouping without duplicating the resolution logic.
function groupMatchesBySourcePage (tasks, docCache) {
  const groups = new Map()    // docId -> Map<pageIndex, MatchInfo[]>
  const mcqMsDocs = new Set() // docIds whose full answer-table must be emitted
  const warnings = []

  for (const task of tasks) {
    const docId = task.sourceDoc._id.toString()
    const cacheEntry = docCache.get(docId)
    const doc = cacheEntry.doc
    const src = cacheEntry.pdf
    const dir = doc.dir
    const totalPages = src.getPageCount()
    const dirs = (dir && Array.isArray(dir.dirs)) ? dir.dirs : []

    if (!groups.has(docId)) groups.set(docId, new Map())
    const pageMap = groups.get(docId)

    if (dir && dir.type === 'mcqMs') {
      mcqMsDocs.add(docId)
      const entry = dirs.find(d => String(d.qN) === String(task.row.qN))
      const page = entry ? (entry.page || 1) : 1
      const qNRect = entry ? (entry.qNRect || null) : null
      if (!pageMap.has(page)) pageMap.set(page, [])
      pageMap.get(page).push({
        qN: task.row.qN,
        qNRect,
        matchedTopics: task.row.matchedTopics,
        matchedSubparts: task.row.matchedSubparts || [],
        isQNStartPage: true
      })
    } else {
      const indices = computePageIndices(dirs, task.row.qN, totalPages)
      if (!indices || indices.length === 0) {
        warnings.push(
          `Could not locate q${task.row.qN} in ${task.sourceDoc.subject}/${task.sourceDoc.time}` +
          `/p${task.sourceDoc.paper}v${task.sourceDoc.variant} (${doc.type})`
        )
        continue
      }
      const cleanIndices = indices.filter(p => p >= 0 && p < totalPages)
      if (cleanIndices.length === 0) continue

      const startPage = cleanIndices[0]
      const entry = dirs.find(d => String(d.qN) === String(task.row.qN))
      const qNRect = entry ? (entry.qNRect || null) : null

      for (const pageIndex of cleanIndices) {
        if (!pageMap.has(pageIndex)) pageMap.set(pageIndex, [])
        pageMap.get(pageIndex).push({
          qN: task.row.qN,
          qNRect: pageIndex === startPage ? qNRect : null,
          matchedTopics: task.row.matchedTopics,
          matchedSubparts: task.row.matchedSubparts || [],
          isQNStartPage: pageIndex === startPage
        })
      }
    }
  }

  return { groups, mcqMsDocs, warnings }
}

async function exportPdf (queryRequest, kind, PastPaperDoc, options) {
  if (kind !== 'qp' && kind !== 'ms') {
    throw new TopicExportError('BAD_KIND', `Unknown export kind: ${kind}`, 400)
  }

  const rendererName = (options && options.renderer) || 'highlight'
  if (!RENDERERS[rendererName]) {
    throw new TopicExportError('BAD_RENDERER', `Unknown renderer: ${rendererName}`, 400)
  }
  const renderer = RENDERERS[rendererName]

  const { rows, meta: queryMeta } = await topicQuery.queryQuestions(queryRequest, PastPaperDoc)
  if (!rows || rows.length === 0) {
    throw new TopicExportError('NO_ROWS', 'No questions matched the current selection.', 400)
  }

  const warnings = []
  const docCache = new Map()    // docId → { doc, pdf }
  const msLookupCache = new Map()

  // ── Phase 1: Resolve source docs ──────────────────────────────────────────
  const tasks = []
  for (const row of rows) {
    let sourceDoc
    if (kind === 'qp') {
      if (row.type === 'qp') {
        if (!docCache.has(row.docId)) {
          const d = await PastPaperDoc.findById(row.docId)
          if (!d) { warnings.push(`QP doc ${row.docId} missing`); continue }
          if (d.fileType !== 'pdf') { warnings.push(`Doc ${row.docId} is not a PDF`); continue }
          docCache.set(row.docId, { doc: d, pdf: null })
        }
        sourceDoc = docCache.get(row.docId).doc
      } else {
        const qp = await PastPaperDoc.findOne({
          subject: row.subject, time: row.time,
          paper: row.paper, variant: row.variant, type: 'qp'
        })
        if (!qp) { warnings.push(`No QP paired with ${row.subject}/${row.time}/p${row.paper}v${row.variant}`); continue }
        if (qp.fileType !== 'pdf') { warnings.push(`Paired QP for ${row.subject}/${row.time} is not a PDF`); continue }
        const id = qp._id.toString()
        if (!docCache.has(id)) docCache.set(id, { doc: qp, pdf: null })
        sourceDoc = docCache.get(id).doc
      }
    } else { // kind === 'ms'
      let ms
      if (row.type === 'qp') {
        ms = await findMsDoc(PastPaperDoc, row, msLookupCache)
        if (!ms) { warnings.push(`No MS for ${row.subject}/${row.time}/p${row.paper}v${row.variant}`); continue }
      } else {
        ms = await PastPaperDoc.findById(row.docId)
        if (!ms) { warnings.push(`MS doc ${row.docId} missing`); continue }
      }
      if (ms.fileType !== 'pdf') { warnings.push(`MS for ${row.subject}/${row.time} is not a PDF`); continue }
      const id = ms._id.toString()
      if (!docCache.has(id)) docCache.set(id, { doc: ms, pdf: null })
      sourceDoc = docCache.get(id).doc
    }
    tasks.push({ row, sourceDoc })
  }

  if (tasks.length === 0) {
    throw new TopicExportError('NO_RESOLVABLE', 'No source documents could be resolved for the selected questions.', 404)
  }

  // ── Phase 2: Load PDFs and populate dirs ──────────────────────────────────
  for (const [, entry] of docCache) {
    if (!entry.pdf) entry.pdf = await loadSourcePdf(entry.doc)
    if (typeof entry.doc.ensureDir === 'function') {
      await entry.doc.ensureDir()
    }
  }

  // ── Phase 3: Group matches by (sourceDocId, pageIndex) ────────────────────
  const { groups, mcqMsDocs, warnings: groupWarnings } = groupMatchesBySourcePage(tasks, docCache)
  warnings.push(...groupWarnings)

  // Pre-count unique pages for the limit check (avoids partial output on error).
  let uniquePageCount = 0
  for (const [docId, pageMap] of groups) {
    const src = docCache.get(docId).pdf
    const totalPages = src.getPageCount()
    if (mcqMsDocs.has(docId)) {
      uniquePageCount += Math.max(0, totalPages - 1) // pages 1..totalPages-1
    } else {
      uniquePageCount += pageMap.size
    }
  }
  if (uniquePageCount > MAX_OUTPUT_PAGES) {
    throw new TopicExportError('TOO_LARGE',
      `Export would exceed ${MAX_OUTPUT_PAGES} pages. Narrow your selection or use sampling.`, 413)
  }

  // ── Phase 4: Emit pages, apply renderer ───────────────────────────────────
  const out = await PDFDocument.create()
  const fontCache = {}
  const sourceMeta = { fontCache, out }

  let totalPagesEmitted = 0
  const markings = []

  for (const [docId, pageMap] of groups) {
    const cacheEntry = docCache.get(docId)
    const src = cacheEntry.pdf
    const totalPages = src.getPageCount()

    // For mcqMs, emit all non-cover pages regardless of which ones have matches.
    const pagesToEmit = mcqMsDocs.has(docId)
      ? Array.from({ length: Math.max(0, totalPages - 1) }, (_, i) => i + 1)
      : Array.from(pageMap.keys()).sort((a, b) => a - b)

    for (const pageIndex of pagesToEmit) {
      const [copied] = await out.copyPages(src, [pageIndex])
      const pageHeight = copied.getHeight()
      const matches = pageMap.get(pageIndex) || []

      await renderer.render({ pdfPage: copied, matches, pageHeight, sourceMeta })
      out.addPage(copied)
      totalPagesEmitted++

      for (const m of matches) {
        if (m.isQNStartPage) {
          markings.push({ docId, page: pageIndex, qN: m.qN, matchedTopics: m.matchedTopics })
        }
      }
    }
  }

  if (totalPagesEmitted === 0) {
    throw new TopicExportError('NO_PAGES', 'No pages could be assembled for the selection.', 404)
  }

  const bytes = await out.save()
  return {
    buffer: Buffer.from(bytes),
    filename: buildFilename(queryRequest, kind, tasks.length),
    meta: {
      questionCount: tasks.length,
      pageCount: totalPagesEmitted,
      markings,
      warnings: warnings.length > 0 ? warnings : undefined,
      queryMeta
    }
  }
}

module.exports = {
  exportPdf,
  computePageIndices,
  groupMatchesBySourcePage,
  TopicExportError,
  MAX_OUTPUT_PAGES
}
