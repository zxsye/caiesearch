#!/usr/bin/env node
'use strict'

/**
 * reindex.bin.js — database reindexing utility
 *
 * Run inside Docker:
 *   docker exec -it schsrch-www node reindex.bin.js --help
 *
 * Environment:
 *   MONGODB   MongoDB URI   (default: mongodb://mw-mongo/schsrch)
 *   ES        ES host       (default: mw-es:9200)
 *   DEBUG=1   Verbose per-file logging
 */

const USAGE = `
Usage: node reindex.bin.js <mode> [path] [options]

Modes
  --full          Re-index every PDF under <path> from scratch.
                  ⚠  Destructive: replaces existing docs, wiping Gemini topic tags.
                  Use only when you need a complete reset.

  --new           Index only PDF files that don't yet exist in MongoDB.
                  Safe — existing docs and their topic tags are untouched.

  --repair-ms     Call ensureDir() on all MS docs in MongoDB whose dir is empty.
                  Safe — only populates question-location data, never touches topic tags.
                  Does not need <path>; reads from DB.

  --repair-qp     Call ensureDir() on all QP docs in MongoDB whose dir is empty.
                  Safe — same guarantee as --repair-ms.

  --repair-dirs   Run both --repair-ms and --repair-qp in one pass.

Arguments
  <path>          Root folder to scan for PDFs (default: /papers).
                  Required for --full and --new; ignored for repair modes.

Options
  --quick         Skip sspdf text extraction and Elasticsearch indexing.
                  Files whose identity is in the filename are stored as blobs
                  immediately; dir and search index can be populated later via
                  --repair-dirs and reIndexElasticSearch.bin.js.
                  Files without standard names still go through the full path.
                  Use with --full or --new to ingest large batches faster.

  --help, -h      Show this message and exit.

Examples
  # First-time ingest of all papers (inside container)
  node reindex.bin.js --full /papers

  # Fast first-time ingest — blob storage only, no text extraction
  node reindex.bin.js --full --quick /papers

  # Add papers uploaded after the initial ingest (safe)
  node reindex.bin.js --new /papers

  # Add new papers quickly, then repair dirs and search index separately
  node reindex.bin.js --new --quick /papers
  node reindex.bin.js --repair-dirs
  node reIndexElasticSearch.bin.js

  # Backfill question-location index for MS docs (safe to run any time)
  node reindex.bin.js --repair-ms

  # Backfill both QP and MS dirs in one go (safe)
  node reindex.bin.js --repair-dirs

  # Debug a single folder verbosely
  DEBUG=1 node reindex.bin.js --new /papers/9701/s24
`

// ── argument parsing ──────────────────────────────────────────────────────────

const args = process.argv.slice(2)
if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
  process.stdout.write(USAGE)
  process.exit(0)
}

const MODES = ['--full', '--new', '--repair-ms', '--repair-qp', '--repair-dirs']
const mode = args.find(a => MODES.includes(a))
if (!mode) {
  process.stderr.write(`Unknown mode. Allowed: ${MODES.join(', ')}\n\nRun with --help for usage.\n`)
  process.exit(1)
}

const pathArg = args.find(a => !a.startsWith('--'))
const scanPath = pathArg || '/papers'
const quick = args.includes('--quick')
const debug = process.env.DEBUG === '1'

// ── DB / ES setup ─────────────────────────────────────────────────────────────

const { MONGODB, ES } = process.env
const DB_URI = MONGODB || 'mongodb://mw-mongo/schsrch'
const ES_HOST = ES || 'mw-es:9200'

const mongoose = require('mongoose')
mongoose.Promise = global.Promise
const db = mongoose.createConnection(DB_URI)

const elasticsearch = require('elasticsearch')
const es = new elasticsearch.Client({ host: ES_HOST })

const fs = require('fs')
const path = require('path')
const PaperUtils = require('./view/paperutils.js')
const sspdf = require('./lib/sspdf.js')

db.on('error', err => { console.error('MongoDB error:', err); process.exit(1) })

// ── helpers ───────────────────────────────────────────────────────────────────

function log (msg) { process.stdout.write(msg + '\n') }
function progress (msg) { process.stderr.write(msg + '\r') }
function warn (msg) { process.stderr.write('\n⚠  ' + msg + '\n') }

function storeData (data, doc, PastPaperPaperBlob) {
  const chunkLength = 10 * 1024 * 1024
  const chunks = []
  for (let offset = 0; offset < data.length; offset += chunkLength) {
    chunks.push(new PastPaperPaperBlob({
      docId: doc._id,
      offset,
      data: data.slice(offset, Math.min(data.length, offset + chunkLength))
    }))
  }
  return Promise.all(chunks.map(c => c.save()))
}

function removeDoc (doc, PastPaperIndex) {
  return PastPaperIndex.remove({ docId: doc._id }).exec().then(() => doc.remove())
}

// Extract (subject, time, type, paper, variant) from a filename or cover-page text.
// Returns null if the file can't be identified.
function metaFromFilename (fname) {
  const nameMat = fname.match(/^(\d+)_([a-z]\d\d)_([a-zA-Z0-9]+)_(\d{1,2})\.(pdf)$/i)
  const nameErMat = fname.match(/^(\d+)_([a-z]\d\d)_([a-zA-Z0-9]+)\.(pdf)$/i)
  if (nameMat) {
    const pv = nameMat[4]
    let paper, variant
    if (pv.length === 1) { paper = parseInt(pv[0]); variant = 0 }
    else if (pv[0] === '0') { paper = parseInt(pv[1]); variant = 0 }
    else { paper = parseInt(pv[0]); variant = parseInt(pv[1]) }
    return { subject: nameMat[1], time: nameMat[2], type: nameMat[3], paper, variant }
  }
  if (nameErMat) {
    return { subject: nameErMat[1], time: nameErMat[2], type: nameErMat[3], paper: 0, variant: 0 }
  }
  return null
}

function metaFromCoverPage (coverLines) {
  const idtStr = coverLines.filter(l => /^\d{4}\/\d{2}$/.test(l))
  if (idtStr.length !== 1) return null
  const [subj, pv] = idtStr[0].split('/')
  let paper = parseInt(pv[0] === '0' ? pv[1] : pv[0])
  let variant = pv.length === 2 && pv[0] !== '0' ? parseInt(pv[1]) : 0

  const timeStr = coverLines
    .map(l => { const m = l.match(/(\S+ \S+) series/); return m ? m[1] : l })
    .filter(l => /^[A-Z][a-z]+\/ ?[A-Z][a-z]+ 20\d\d$/.test(l))
  const uniq = [...new Set(timeStr)]
  if (uniq.length !== 1) {
    const spTime = coverLines.map(l => l.match(/^For Examination from 20(\d\d)/)).filter(Boolean)
    if (spTime.length === 1) return { subject: subj, time: 'y' + spTime[0][1], type: 'sp', paper, variant }
    return null
  }
  const [season, year] = uniq[0].split(' ')
  const seasonMap = { 'May/June': 's', 'October/November': 'w', 'February/March': 'm', 'May/ June': 's', 'October/ November': 'w', 'February/ March': 'm' }
  const pTime = seasonMap[season]
  if (!pTime) return null
  const time = pTime + year.substr(2)

  let type
  if (coverLines.some(l => /READ THESE INSTRUCTIONS FIRST/i.test(l))) type = 'qp'
  else if (coverLines.some(l => /MARK SCHEME/i.test(l))) type = 'ms'
  else if (coverLines.some(l => /CONFIDENTIAL INSTRUCTIONS/i.test(l))) type = 'ir'
  else return null

  return { subject: subj, time, type, paper, variant }
}

// Walk a directory tree, calling onFile(filePath) for every file found.
function walk (root, onFile) {
  return new Promise((resolve, reject) => {
    const queue = [root]
    let pending = 1

    function next () {
      if (pending === 0) return resolve()
      const task = queue.pop()
      fs.stat(task, (err, stats) => {
        if (err) { warn(`stat failed: ${task} — ${err.message}`); pending--; next(); return }
        if (stats.isDirectory()) {
          fs.readdir(task, (err, files) => {
            if (err) { warn(`readdir failed: ${task} — ${err.message}`); pending--; next(); return }
            pending += files.length - 1
            for (const f of files) queue.push(path.join(task, f))
            next()
          })
        } else {
          onFile(task).then(() => { pending--; next() }, err => {
            warn(`${task}: ${err.message}`)
            pending--; next()
          })
        }
      })
    }
    next()
  })
}

// ── indexing core (for --full and --new) ─────────────────────────────────────

async function indexOnePdf (filePath, { PastPaperDoc, PastPaperIndex, PastPaperPaperBlob }, { skipIfExists, existingKeys }) {
  const fname = path.basename(filePath)
  if (!fname.toLowerCase().endsWith('.pdf')) return

  const data = await fs.promises.readFile(filePath)

  // Quick mode: if filename encodes full identity, skip sspdf and ES indexing.
  // Files without standard names fall through to the full path below.
  if (quick) {
    const mt = metaFromFilename(fname)
    if (mt) {
      if (!Number.isSafeInteger(mt.paper) || !Number.isSafeInteger(mt.variant)) {
        throw new Error(`Invalid paper/variant in ${fname}`)
      }
      const key = `${mt.subject}|${mt.time}|${mt.type}|${mt.paper}|${mt.variant}`
      if (skipIfExists && existingKeys.has(key)) {
        if (debug) log(`  skip (exists): ${filePath}`)
        return 'skipped'
      }
      const doc = new PastPaperDoc({ ...mt, fileBlob: null, fileType: 'pdf' })
      await storeData(data, doc, PastPaperPaperBlob)
      const existing = await PastPaperDoc.find(mt, { _id: true }).exec()
      await Promise.all(existing.map(d => removeDoc(d, PastPaperIndex)))
      await doc.save()
      if (debug) log(`  quick-indexed: ${filePath}`)
      return 'indexed'
    }
    // No filename match — fall through to full path (cover-page detection needed).
    if (debug) log(`  no filename match, falling back to full path: ${filePath}`)
  }

  let pdfContents
  try {
    pdfContents = await sspdf.getPDFContentAll(data)
  } catch (e) {
    throw new Error(`sspdf failed: ${e.message}`)
  }

  const coverLines = (pdfContents.pageTexts[0] || '').split(/\n+/).map(l => l.replace(/\s+/g, ' ').trim())
  const mt = metaFromFilename(fname) || metaFromCoverPage(coverLines)
  if (!mt) throw new Error(`Cannot identify paper metadata`)
  if (!Number.isSafeInteger(mt.paper) || !Number.isSafeInteger(mt.variant)) {
    throw new Error(`Invalid paper/variant in ${fname}`)
  }

  const key = `${mt.subject}|${mt.time}|${mt.type}|${mt.paper}|${mt.variant}`

  if (skipIfExists && existingKeys.has(key)) {
    if (debug) log(`  skip (exists): ${filePath}`)
    return 'skipped'
  }

  const doc = new PastPaperDoc({
    ...mt,
    fileBlob: null,
    fileType: 'pdf',
    numPages: pdfContents.numPages
  })

  const idxes = []
  for (let pn = 0; pn < pdfContents.numPages; pn++) {
    idxes.push(new PastPaperIndex({
      docId: doc._id,
      page: pn,
      content: pdfContents.pageTexts[pn],
      sspdfCache: null
    }))
  }

  await storeData(data, doc, PastPaperPaperBlob)

  const existing = await PastPaperDoc.find(mt, { _id: true }).exec()
  await Promise.all(existing.map(d => removeDoc(d, PastPaperIndex)))

  await Promise.all(idxes.map(idx => idx.save().then(() => idx.indexToElastic(doc))))
  await doc.save()

  if (debug) log(`  indexed: ${filePath}`)
  return 'indexed'
}

// ── modes ─────────────────────────────────────────────────────────────────────

async function runFull (models) {
  log(`\n── Full re-index from ${scanPath}${quick ? ' (quick mode — skipping sspdf + ES)' : ''}`)
  log(`   ⚠  This replaces all existing docs and wipes Gemini topic tags.`)
  if (quick) log(`   After this, run --repair-dirs and reIndexElasticSearch.bin.js to complete indexing.`)
  log(`   Starting in 3 seconds — Ctrl-C to abort.\n`)
  await new Promise(r => setTimeout(r, 3000))

  let total = 0, indexed = 0, failed = 0
  await walk(scanPath, async filePath => {
    if (!filePath.toLowerCase().endsWith('.pdf')) return
    total++
    progress(`   ${indexed} indexed, ${failed} failed, scanning...`)
    try {
      await indexOnePdf(filePath, models, { skipIfExists: false, existingKeys: null })
      indexed++
    } catch (e) {
      failed++
      warn(`${filePath}: ${e.message}`)
    }
  })

  log(`\n✓  Full re-index complete. ${indexed} indexed, ${failed} failed (${total} total files).`)
}

async function runNew (models) {
  log(`\n── New-only index from ${scanPath}${quick ? ' (quick mode — skipping sspdf + ES)' : ''}`)
  log(`   Safe: existing docs are not modified.`)
  if (quick) log(`   After this, run --repair-dirs and reIndexElasticSearch.bin.js to complete indexing.`)
  log(``)

  log(`   Loading existing paper keys from MongoDB...`)
  const allDocs = await models.PastPaperDoc.find({}, { subject: 1, time: 1, type: 1, paper: 1, variant: 1 })
  const existingKeys = new Set(allDocs.map(d => `${d.subject}|${d.time}|${d.type}|${d.paper}|${d.variant}`))
  log(`   Found ${existingKeys.size} existing docs in DB.\n`)

  let total = 0, indexed = 0, skipped = 0, failed = 0
  await walk(scanPath, async filePath => {
    if (!filePath.toLowerCase().endsWith('.pdf')) return
    total++
    progress(`   ${indexed} new, ${skipped} skipped, ${failed} failed...`)
    try {
      const result = await indexOnePdf(filePath, models, { skipIfExists: true, existingKeys })
      if (result === 'skipped') skipped++
      else indexed++
    } catch (e) {
      failed++
      warn(`${filePath}: ${e.message}`)
    }
  })

  log(`\n✓  New-only index complete. ${indexed} new, ${skipped} already existed, ${failed} failed (${total} total files).`)
}

async function repairDirs (models, types) {
  const typeLabel = types.join('+')
  log(`\n── Repair dirs for ${typeLabel} docs`)
  log(`   Safe: only populates empty dir fields, never touches topic tags.\n`)

  const docs = await models.PastPaperDoc.find({ type: { $in: types } })
  const toRepair = docs.filter(d => !d.dir || !d.dir.type)
  log(`   ${docs.length} ${typeLabel} docs total, ${toRepair.length} with empty dir.\n`)

  if (toRepair.length === 0) {
    log(`✓  Nothing to do.`)
    return
  }

  let done = 0, failed = 0
  for (const doc of toRepair) {
    progress(`   ${done}/${toRepair.length} done, ${failed} failed...`)
    try {
      await doc.ensureDir()
      done++
      if (debug) log(`  ensured: ${doc.subject}/${doc.time}/${doc.type} p${doc.paper}v${doc.variant}`)
    } catch (e) {
      failed++
      warn(`${doc.subject}/${doc.time}/${doc.type} p${doc.paper}v${doc.variant}: ${e.message}`)
    }
  }

  log(`\n✓  Dir repair complete. ${done} populated, ${failed} failed.`)
}

// ── main ──────────────────────────────────────────────────────────────────────

db.on('open', async () => {
  let models
  try {
    models = await require('./lib/dbModel.js')(db, es)
  } catch (e) {
    console.error('Failed to initialize DB models:', e)
    process.exit(1)
  }

  try {
    switch (mode) {
      case '--full':        await runFull(models); break
      case '--new':         await runNew(models); break
      case '--repair-ms':   await repairDirs(models, ['ms']); break
      case '--repair-qp':   await repairDirs(models, ['qp']); break
      case '--repair-dirs': await repairDirs(models, ['qp', 'ms']); break
    }
    process.exit(0)
  } catch (e) {
    console.error('\nFatal error:', e)
    process.exit(1)
  }
})
