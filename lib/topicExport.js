'use strict'

const { PDFDocument } = require('pdf-lib')
const topicQuery = require('./topicQuery')

const MAX_OUTPUT_PAGES = 200

class TopicExportError extends Error {
  constructor (code, message, status) {
    super(message)
    this.code = code
    this.status = status || 500
  }
}

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
  for (let i = idx + 1; i < sorted.length; i++) {
    if (sorted[i].page > startPage) { endExclusive = sorted[i].page; break }
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

async function exportPdf (queryRequest, kind, PastPaperDoc) {
  if (kind !== 'qp' && kind !== 'ms') {
    throw new TopicExportError('BAD_KIND', `Unknown export kind: ${kind}`, 400)
  }

  const { rows, meta: queryMeta } = await topicQuery.queryQuestions(queryRequest, PastPaperDoc)
  if (!rows || rows.length === 0) {
    throw new TopicExportError('NO_ROWS', 'No questions matched the current selection.', 400)
  }

  const warnings = []
  const docCache = new Map()   // docId → { doc, pdf }
  const msLookupCache = new Map()  // sub_time_p_v → ms doc or null

  // Resolve each row into a { sourceDocId, sourceDoc, qN } source target.
  const tasks = []
  for (const row of rows) {
    let sourceDoc
    if (kind === 'qp') {
      if (row.type === 'qp') {
        // Need fileBlob, so fetch full doc by id (queryQuestions projected blob out).
        if (!docCache.has(row.docId)) {
          const d = await PastPaperDoc.findById(row.docId)
          if (!d) { warnings.push(`QP doc ${row.docId} missing`); continue }
          if (d.fileType !== 'pdf') { warnings.push(`Doc ${row.docId} is not a PDF`); continue }
          docCache.set(row.docId, { doc: d, pdf: null })
        }
        sourceDoc = docCache.get(row.docId).doc
      } else {
        // Row is from an MCQ MS doc; find the paired QP.
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
        // Row already from an MS-like doc; reuse it.
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

  const out = await PDFDocument.create()
  let totalPagesEmitted = 0
  const emittedMcqMsDocs = new Set()

  for (const task of tasks) {
    const cacheEntry = docCache.get(task.sourceDoc._id.toString())
    if (!cacheEntry.pdf) cacheEntry.pdf = await loadSourcePdf(cacheEntry.doc)
    const src = cacheEntry.pdf
    const dir = cacheEntry.doc.dir
    const totalPages = src.getPageCount()

    let cleanIndices
    if (dir && dir.type === 'mcqMs') {
      const docId = cacheEntry.doc._id.toString()
      if (emittedMcqMsDocs.has(docId)) continue
      emittedMcqMsDocs.add(docId)
      cleanIndices = []
      for (let p = 1; p < totalPages; p++) cleanIndices.push(p)
      if (cleanIndices.length === 0) continue
    } else {
      const dirs = (dir && Array.isArray(dir.dirs)) ? dir.dirs : []
      const indices = computePageIndices(dirs, task.row.qN, totalPages)
      if (!indices || indices.length === 0) {
        warnings.push(`Could not locate q${task.row.qN} in ${task.sourceDoc.subject}/${task.sourceDoc.time}/p${task.sourceDoc.paper}v${task.sourceDoc.variant} (${cacheEntry.doc.type})`)
        continue
      }
      cleanIndices = indices.filter(p => p >= 0 && p < totalPages)
      if (cleanIndices.length === 0) continue
    }

    if (totalPagesEmitted + cleanIndices.length > MAX_OUTPUT_PAGES) {
      throw new TopicExportError('TOO_LARGE',
        `Export would exceed ${MAX_OUTPUT_PAGES} pages. Narrow your selection or use sampling.`, 413)
    }

    const copied = await out.copyPages(src, cleanIndices)
    copied.forEach(p => out.addPage(p))
    totalPagesEmitted += cleanIndices.length
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
      warnings: warnings.length > 0 ? warnings : undefined,
      queryMeta
    }
  }
}

module.exports = {
  exportPdf,
  computePageIndices,
  TopicExportError,
  MAX_OUTPUT_PAGES
}
