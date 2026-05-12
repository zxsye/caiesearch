#!/usr/bin/env node
/**
 * Script to link past paper QUESTIONS to curriculum topics using Google Gemini.
 *
 * Phase 1: Coordinate-based text extraction — slices each question's text from
 *           the raw PDF layout data using the qNRect.y1 boundary coordinates.
 * Phase 2: Gemini prompt — sends the sliced question text to Gemini for topic tagging.
 * Phase 3: MongoDB write — persists topics into doc.dir.dirs[i].topics in PastPaperDoc.
 *
 * Usage:
 *   docker exec -e GEMINI_API_KEY=xxx -e MONGODB=... -e ES=... schsrch-www \
 *     node doLinkTopics.bin.js [subjectId] [limit]
 *
 * Environment:
 *   GEMINI_API_KEY  — required
 *   MONGODB         — MongoDB connection string
 *   ES              — Elasticsearch host
 *   DEBUG=1         — verbose per-rect logging
 */

const { MONGODB: DB, ES, GEMINI_API_KEY, DEBUG } = process.env
const mongoose = require('mongoose')
const { GoogleGenerativeAI } = require('@google/generative-ai')
const syllabusTopics = require('./lib/syllabus_topics.js')
const elasticsearch = require('elasticsearch')
const sspdf = require('./lib/sspdf.js')

const debug = DEBUG === '1'

if (!GEMINI_API_KEY) {
  console.error('GEMINI_API_KEY environment variable is required.')
  process.exit(1)
}

const targetSubject = process.argv[2] || '9709'
const limit = parseInt(process.argv[3]) || 5

if (!syllabusTopics[targetSubject]) {
  console.error(`No syllabus topics defined for subject ${targetSubject}`)
  process.exit(1)
}

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY)
const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' })

mongoose.Promise = global.Promise
let db = mongoose.createConnection(DB)
let es = new elasticsearch.Client({ host: ES })

db.on('error', err => {
  console.error(err)
  process.exit(1)
})

// ─── Phase 1: Coordinate-based text slicer ────────────────────────────────────

/**
 * Given the full PDF layout data and the parsed dir.dirs array, slice out the
 * text that belongs to each question using the "greedy" boundary logic described
 * in the implementation plan.
 *
 * @param {object}   pageDatas  - Result of sspdf.getPDFContentAll: { numPages, pageRects, pageTexts }
 * @param {Array}    dirs       - doc.dir.dirs array (each entry: { qN, page, qNRect })
 * @returns {Array}             - Array of { qN, text } objects, one per question
 */
function sliceQuestionTexts(pageDatas, dirs) {
  if (!dirs || dirs.length === 0) return []

  const { pageRects, pageTexts } = pageDatas
  const numPages = pageDatas.numPages

  // pageRects[p] is an array of rect objects { x1, x2, y1, y2 }
  // pageTexts[p] is a plain string — one character per rect entry.
  // We need to reconstruct per-page word arrays from those parallel arrays.

  const results = []

  for (let qi = 0; qi < dirs.length; qi++) {
    const q = dirs[qi]
    const nextQ = dirs[qi + 1] || null

    const startPage = q.page
    const endPage = nextQ ? nextQ.page : numPages - 1
    const startY = q.qNRect.y1          // top of question N's number glyph
    const endY = nextQ ? nextQ.qNRect.y1 : Infinity  // top of question N+1

    let questionText = ''

    for (let p = startPage; p <= endPage; p++) {
      const rects = pageRects[p]
      const text = pageTexts[p]
      if (!rects || !text) continue

      for (let ci = 0; ci < rects.length; ci++) {
        const r = rects[ci]
        const ch = text[ci]
        if (ch === undefined) continue

        const charY = r.y1  // top of this character's bounding rect

        if (p === startPage && p === endPage) {
          // Single-page question: keep chars between startY and endY
          if (charY >= startY && charY < endY) {
            questionText += ch
          }
        } else if (p === startPage) {
          // First page: keep chars from startY onwards
          if (charY >= startY) {
            questionText += ch
          }
        } else if (p === endPage) {
          // Last page: keep chars before endY (exclusive)
          if (charY < endY) {
            questionText += ch
          }
        } else {
          // Middle page: keep everything
          questionText += ch
        }
      }

      // Add a newline between pages for readability
      if (p < endPage) questionText += '\n'
    }

    questionText = questionText.trim()

    if (debug) {
      console.log(`  [Q${q.qN}] page ${startPage}→${endPage}, startY=${startY}, endY=${endY === Infinity ? '∞' : endY}`)
      console.log(`  [Q${q.qN}] extracted text (first 200 chars): ${questionText.substring(0, 200)}`)
    }

    results.push({ qN: q.qN, text: questionText })
  }

  return results
}

// ─── Phase 2: Gemini tagging ──────────────────────────────────────────────────

/**
 * Sends sliced question text to Gemini and returns an array of topic strings.
 *
 * @param {number} qN         - Question number (for logging)
 * @param {string} questionText
 * @param {string} subjectId
 * @returns {Promise<string[]>}
 */
async function tagQuestionWithGemini(qN, questionText, subjectId) {
  const topics = syllabusTopics[subjectId]

  if (!questionText || questionText.length < 10) {
    console.warn(`  [Q${qN}] Text too short to classify, skipping.`)
    return []
  }

  const prompt =
    `You are a CIE (Cambridge International) examiner for subject ${subjectId}. ` +
    `Below is the exact text of Question ${qN} extracted from a past exam paper.\n\n` +
    `Your task: identify which of the following syllabus topics this question covers.\n\n` +
    `Syllabus Topics:\n${topics.join(', ')}\n\n` +
    `Question Text:\n${questionText}\n\n` +
    `Return ONLY a JSON array of matching topic name strings. ` +
    `If no topics match, return []. Do not include explanations or markdown.`

  try {
    const result = await model.generateContent(prompt)
    const response = await result.response
    let text = response.text().trim()

    // Strip potential markdown code fences
    text = text.replace(/^```(?:json)?/m, '').replace(/```$/m, '').trim()

    const match = text.match(/\[.*\]/s)
    if (match) {
      const detected = JSON.parse(match[0])
      console.log(`  [Q${qN}] Topics: ${detected.length > 0 ? detected.join(', ') : 'None'}`)
      return detected
    } else {
      console.warn(`  [Q${qN}] No JSON array found in Gemini response: ${text.substring(0, 100)}`)
      return []
    }
  } catch (e) {
    console.error(`  [Q${qN}] Gemini error: ${e.message}`)
    return []
  }
}

// ─── Phase 3: MongoDB write ───────────────────────────────────────────────────

/**
 * Saves the detected topics back into the question entry in doc.dir.dirs,
 * then persists the doc. Mutates doc.dir.dirs[i].topics in place.
 *
 * @param {object}   doc     - Mongoose PastPaperDoc instance
 * @param {number}   qN      - Question number to update
 * @param {string[]} topics  - Detected topic strings
 */
async function saveTopicsToDoc(doc, qN, topics) {
  const dirs = doc.dir && doc.dir.dirs
  if (!Array.isArray(dirs)) {
    console.warn(`  [Q${qN}] doc.dir.dirs is not an array, skipping save.`)
    return
  }

  const entry = dirs.find(d => d.qN === qN)
  if (!entry) {
    console.warn(`  [Q${qN}] Could not find dirs entry for qN=${qN}`)
    return
  }

  entry.topics = topics

  // Mongoose doesn't track nested object mutation; mark the field modified.
  doc.markModified('dir')
  await doc.save()
}

// ─── Main orchestration ───────────────────────────────────────────────────────

db.on('open', async () => {
  console.log(`Connected to database. Processing subject ${targetSubject} (limit: ${limit} papers)...`)
  const { PastPaperDoc } = await require('./lib/dbModel.js')(db, es)

  try {
    const docs = await PastPaperDoc.find({ subject: targetSubject, type: 'qp' })
      .sort({ time: -1 })
      .limit(limit)

    console.log(`Found ${docs.length} question paper(s) to process.\n`)

    for (const doc of docs) {
      const paperName = `${doc.subject}_${doc.time}_qp_${doc.paper}${doc.variant}`
      console.log(`\n═══ Processing ${paperName} (${doc._id}) ═══`)

      // Validate that we have a meaningful dir with question entries
      if (!doc.dir || doc.dir.type !== 'questions' || !Array.isArray(doc.dir.dirs) || doc.dir.dirs.length === 0) {
        console.log('  No question directory found. Skipping (run doIndex.bin.js first).')
        continue
      }

      const dirs = doc.dir.dirs
      console.log(`  ${dirs.length} question(s) detected in dir.`)

      // Check if all questions already have topics
      const untagged = dirs.filter(d => !d.topics || d.topics.length === 0)
      if (untagged.length === 0) {
        console.log('  All questions already tagged. Skipping.')
        continue
      }
      console.log(`  ${untagged.length} question(s) need tagging.`)

      // Phase 1: Load PDF binary and extract per-page layout data
      console.log('  Loading PDF binary...')
      let blob
      try {
        blob = await doc.getFileBlob()
      } catch (e) {
        console.error(`  Failed to load PDF blob: ${e.message}`)
        continue
      }

      console.log('  Running sspdf.getPDFContentAll...')
      let pageDatas
      try {
        pageDatas = await sspdf.getPDFContentAll(blob)
      } catch (e) {
        console.error(`  sspdf error: ${e.message}`)
        continue
      }
      console.log(`  PDF has ${pageDatas.numPages} pages.`)

      // Phase 1 (continued): Slice question texts from layout data
      const questionSlices = sliceQuestionTexts(pageDatas, dirs)

      // Phase 2 + 3: Tag each untagged question and save
      for (const { qN, text } of questionSlices) {
        const dirEntry = dirs.find(d => d.qN === qN)
        if (dirEntry && dirEntry.topics && dirEntry.topics.length > 0) {
          console.log(`  [Q${qN}] Already tagged: ${dirEntry.topics.join(', ')}`)
          continue
        }

        const detectedTopics = await tagQuestionWithGemini(qN, text, targetSubject)
        await saveTopicsToDoc(doc, qN, detectedTopics)

        // Respect Gemini rate limits
        await new Promise(resolve => setTimeout(resolve, 1000))
      }

      console.log(`  ✓ Finished ${paperName}.`)
    }

    console.log('\nBatch processing complete.')
  } catch (err) {
    console.error('Batch error:', err)
  } finally {
    process.exit(0)
  }
})
