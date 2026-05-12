#!/usr/bin/env node
/**
 * Script to link past paper QUESTIONS to curriculum topics using Gemini 3.
 *
 * This version uses the new @google/genai SDK with gemini-3-flash-preview
 * and thinking mode enabled for higher precision.
 *
 * Phase 1: Coordinate-based text extraction.
 * Phase 2: Gemini 3 (Thinking) prompt.
 * Phase 3: MongoDB write (doc.dir.dirs[i].topics).
 */

const { MONGODB, ES, GEMINI_API_KEY, DEBUG } = process.env
const mongoose = require('mongoose')
const { GoogleGenAI } = require('@google/genai')
const syllabusTopics = require('./lib/syllabus_topics.js')
const elasticsearch = require('elasticsearch')
const sspdf = require('./lib/sspdf.js')

// Default to container environment variables if not provided
const DB_URI = MONGODB || 'mongodb://mw-mongo/schsrch'
const ES_HOST = ES || 'mw-es:9200'

const debug = DEBUG === '1'

if (!GEMINI_API_KEY) {
  console.error('GEMINI_API_KEY environment variable is required.')
  process.exit(1)
}

const targetSubject = process.argv[2] || '9709'
const limit = parseInt(process.argv[3]) || 5
const targetYear = process.argv[4] // e.g. '23'
const targetPaper = process.argv[5] // e.g. '1' or '13'

if (!syllabusTopics[targetSubject]) {
  console.error(`No syllabus topics defined for subject ${targetSubject}`)
  process.exit(1)
}

// Initialize Gemini 3 SDK
const ai = new GoogleGenAI({
  apiKey: GEMINI_API_KEY
})

const MODEL_NAME = 'gemini-3.1-flash-lite'

mongoose.Promise = global.Promise
let db = mongoose.createConnection(DB_URI)
let es = new elasticsearch.Client({ host: ES_HOST })

db.on('error', err => {
  console.error(err)
  process.exit(1)
})

// ─── Phase 1: Coordinate-based text slicer ────────────────────────────────────

function sliceQuestionTexts(pageDatas, dirs) {
  if (!dirs || dirs.length === 0) return []
  const { pageRects, pageTexts } = pageDatas
  const numPages = pageDatas.numPages
  const results = []

  for (let qi = 0; qi < dirs.length; qi++) {
    const q = dirs[qi]
    const nextQ = dirs[qi + 1] || null
    const startPage = q.page
    const endPage = nextQ ? nextQ.page : numPages - 1
    const startY = q.qNRect.y1
    const endY = nextQ ? nextQ.qNRect.y1 : Infinity

    let questionText = ''
    for (let p = startPage; p <= endPage; p++) {
      const rects = pageRects[p]
      const text = pageTexts[p]
      if (!rects || !text) continue
      for (let ci = 0; ci < rects.length; ci++) {
        const r = rects[ci]
        const ch = text[ci]
        if (ch === undefined) continue
        const charY = r.y1
        if (p === startPage && p === endPage) {
          if (charY >= startY && charY < endY) questionText += ch
        } else if (p === startPage) {
          if (charY >= startY) questionText += ch
        } else if (p === endPage) {
          if (charY < endY) questionText += ch
        } else {
          questionText += ch
        }
      }
      if (p < endPage) questionText += '\n'
    }
    results.push({ qN: q.qN, text: questionText.trim() })
  }
  return results
}

// ─── Phase 2: Gemini 3 (Thinking) tagging ─────────────────────────────────────

async function tagQuestionWithGemini(qN, questionText, subjectId) {
  const topics = syllabusTopics[subjectId]
  if (!questionText || questionText.length < 10) return []

  const prompt =
    `You are a CIE (Cambridge International) examiner for subject ${subjectId}. ` +
    `Below is the exact text of Question ${qN} extracted from a past exam paper.\n\n` +
    `Your task: identify which of the following syllabus topics this question covers.\n\n` +
    `Syllabus Topics:\n${topics.join(', ')}\n\n` +
    `Question Text:\n${questionText}\n\n` +
    `Return ONLY a JSON array of matching topic name strings. ` +
    `If no topics match, return []. Do not include explanations or markdown.`

  try {
    const response = await ai.models.generateContentStream({
      model: MODEL_NAME,
      config: {
        thinkingConfig: {
          thinkingLevel: 'MINIMAL'
        }
      },
      contents: [
        {
          role: 'user',
          parts: [{ text: prompt }]
        }
      ]
    })

    let fullText = ''
    for await (const chunk of response) {
      if (chunk.text) {
        fullText += chunk.text
      }
    }

    let text = fullText.trim()
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

async function saveTopicsToDoc(doc, qN, topics) {
  const dirs = doc.dir && doc.dir.dirs
  if (!Array.isArray(dirs)) return
  const entry = dirs.find(d => d.qN === qN)
  if (!entry) return
  entry.topics = topics
  doc.markModified('dir')
  await doc.save()
}

// ─── Main orchestration ───────────────────────────────────────────────────────

db.on('open', async () => {
  console.log(`Connected to database. Processing subject ${targetSubject}${targetYear ? ` (Year: ${targetYear})` : ''}${targetPaper ? ` (Paper: ${targetPaper})` : ''} (limit: ${limit} papers)...`)
  const { PastPaperDoc } = await require('./lib/dbModel.js')(db, es)

  try {
    const query = { subject: targetSubject, type: 'qp' }
    if (targetYear) {
      query.time = new RegExp(`${targetYear}$`)
    }

    if (targetPaper) {
      if (targetPaper.length === 1) {
        query.paper = parseInt(targetPaper)
      } else if (targetPaper.length === 2) {
        query.paper = parseInt(targetPaper[0])
        query.variant = parseInt(targetPaper[1])
      }
    }

    const docs = await PastPaperDoc.find(query)
      .sort({ time: -1 })
      .limit(limit)

    console.log(`Found ${docs.length} question paper(s) to process.\n`)

    for (const doc of docs) {
      const paperName = `${doc.subject}_${doc.time}_qp_${doc.paper}${doc.variant}`
      console.log(`\n═══ Processing ${paperName} (${doc._id}) ═══`)

      if (!doc.dir || !doc.dir.dirs || doc.dir.dirs.length === 0) {
        console.log('  Question directory missing. Generating via ensureDir()...')
        try {
          await doc.ensureDir()
        } catch (e) {
          console.error(`  Failed to generate directory: ${e.message}`)
          continue
        }
      }

      const dirs = doc.dir.dirs
      const untagged = dirs.filter(d => !d.topics || d.topics.length === 0)
      if (untagged.length === 0) {
        console.log('  All questions already tagged. Skipping.')
        continue
      }
      console.log(`  ${untagged.length}/${dirs.length} question(s) need tagging.`)

      console.log('  Loading PDF layout data...')
      const blob = await doc.getFileBlob()
      const pageDatas = await sspdf.getPDFContentAll(blob)
      const questionSlices = sliceQuestionTexts(pageDatas, dirs)

      for (const { qN, text } of questionSlices) {
        const dirEntry = dirs.find(d => d.qN === qN)
        if (dirEntry && dirEntry.topics && dirEntry.topics.length > 0) continue

        const detectedTopics = await tagQuestionWithGemini(qN, text, targetSubject)
        await saveTopicsToDoc(doc, qN, detectedTopics)

        // Respect rate limits (Thinking mode might be slower/stricter)
        await new Promise(resolve => setTimeout(resolve, 2000))
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
