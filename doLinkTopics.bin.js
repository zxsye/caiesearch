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
const fs = require('fs')
const path = require('path')

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
const targetYear = process.argv[4] // e.g. '23' or '20-23'
const targetPaper = process.argv[5] // e.g. '1', '13', or '1,2,11'
const force = process.argv.includes('--force')

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

async function tagQuestionWithGemini(qN, questionText, subjectId, syllabusData) {
  if (!questionText || questionText.length < 10) return []

  const syllabusStr = JSON.stringify(syllabusData, null, 2)
  const prompt =
    `You are a CIE (Cambridge International) examiner for subject ${subjectId}. ` +
    `Below is the exact text of Question ${qN} extracted from a past exam paper.\n\n` +
    `Your task: identify which syllabus topics each part of this question covers.\n\n` +
    `Syllabus Structure:\n${syllabusStr}\n\n` +
    `Question Text:\n${questionText}\n\n` +
    `Return a JSON array of objects for each main part of the question (e.g. (a), (b), (c)). ` +
    `Focus only on the primary sub-question levels (a, b, c); do not create separate entries for sub-sub-parts like (i), (ii) or (1), (2). ` +
    `Each object should have:\n` +
    `- "part": The label of the part (e.g. "(a)", "(b)", or null if it's the main question body).\n` +
    `- "topics": A JSON array of matching TOPIC NAMES from the syllabus.\n\n` +
    `Return ONLY the JSON array. Do not include markdown or explanations.`

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
      const uniqueTopics = new Set()
      const subparts = []

      for (const item of detected) {
        if (!item.topics || item.topics.length === 0) continue
        subparts.push({
          part: item.part,
          topics: item.topics
        })
        for (const t of item.topics) {
          uniqueTopics.add(t)
        }
      }
      
      const topicsArr = Array.from(uniqueTopics)
      console.log(`  [Q${qN}] Detected ${subparts.length} parts, ${topicsArr.length} unique topics.`)
      return { topics: topicsArr, subparts }
    } else {
      console.warn(`  [Q${qN}] No JSON array found in Gemini response: ${text.substring(0, 100)}`)
      return { topics: [], subparts: [] }
    }
  } catch (e) {
    console.error(`  [Q${qN}] Gemini error: ${e.message}`)
    return []
  }
}

async function tagQuestionsBulkWithGemini(questionsBatch, subjectId, syllabusData, maxTopics) {
  if (!questionsBatch || questionsBatch.length === 0) return []

  const syllabusStr = JSON.stringify(syllabusData, null, 2)
  let questionsPrompt = questionsBatch.map(q => `Question ${q.qN}:\n${q.text}\n`).join('\n---\n')

  const prompt =
    `You are a CIE (Cambridge International) examiner for subject ${subjectId}. ` +
    `Below are the exact texts of ${questionsBatch.length} multiple-choice questions extracted from a past exam paper.\n\n` +
    `Your task: identify which syllabus topics each question covers. ` +
    `Since these are multiple-choice questions, they do not have sub-parts. ` +
    `You MUST identify at most ${maxTopics} topic(s) per question.\n\n` +
    `Syllabus Structure:\n${syllabusStr}\n\n` +
    `Questions:\n${questionsPrompt}\n\n` +
    `Return ONLY a JSON array of objects, one for each question. ` +
    `Each object should have:\n` +
    `- "qN": The integer question number.\n` +
    `- "topics": A JSON array of matching TOPIC NAMES from the syllabus (maximum ${maxTopics}).\n\n` +
    `Return ONLY the JSON array. Do not include markdown or explanations.`

  try {
    const response = await ai.models.generateContentStream({
      model: MODEL_NAME,
      config: {
        thinkingConfig: {
          thinkingLevel: 'MINIMAL'
        }
      },
      contents: [{ role: 'user', parts: [{ text: prompt }] }]
    })

    let fullText = ''
    for await (const chunk of response) {
      if (chunk.text) fullText += chunk.text
    }

    let text = fullText.trim()
    text = text.replace(/^```(?:json)?/m, '').replace(/```$/m, '').trim()

    const match = text.match(/\[.*\]/s)
    if (match) {
      const detected = JSON.parse(match[0])
      console.log(`  [Bulk] Processed ${detected.length} questions.`)
      // Convert to expected format {qN, result: {topics, subparts}}
      return detected.map(item => ({
        qN: item.qN,
        result: { topics: item.topics || [], subparts: [] } // No subparts for MCQ
      }))
    } else {
      console.warn(`  [Bulk] No JSON array found in Gemini response: ${text.substring(0, 100)}`)
      return []
    }
  } catch (e) {
    console.error(`  [Bulk] Gemini error: ${e.message}`)
    return []
  }
}

// ─── Phase 3: MongoDB write ───────────────────────────────────────────────────

async function saveTopicsToDoc(doc, qN, result) {
  const dirs = doc.dir && doc.dir.dirs
  if (!Array.isArray(dirs)) return
  const entry = dirs.find(d => d.qN === qN)
  if (!entry) return
  entry.topics = result.topics
  entry.subparts = result.subparts
  doc.markModified('dir')
  await doc.save()
}

// ─── Main orchestration ───────────────────────────────────────────────────────

db.on('open', async () => {
  console.log(`Connected to database. Processing subject ${targetSubject}${targetYear ? ` (Year: ${targetYear})` : ''}${targetPaper ? ` (Paper: ${targetPaper})` : ''} (limit: ${limit} papers)...`)
  const { PastPaperDoc } = await require('./lib/dbModel.js')(db, es)

  // Load tagging config
  let taggingConfig = {}
  try {
    const configPath = path.join(__dirname, 'lib', 'tagging', 'config.json')
    if (fs.existsSync(configPath)) {
      taggingConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    }
  } catch (e) {
    console.warn(`Failed to load tagging config: ${e.message}`)
  }

  try {
    const query = { subject: targetSubject, type: 'qp' }
    if (targetYear) {
      if (targetYear.includes('-')) {
        const [start, end] = targetYear.split('-').map(y => parseInt(y.trim()))
        const years = []
        for (let y = start; y <= end; y++) {
          years.push(y.toString().slice(-2).padStart(2, '0'))
        }
        query.time = new RegExp(`(${years.join('|')})$`)
      } else {
        query.time = new RegExp(`${targetYear}$`)
      }
    }

    if (targetPaper) {
      const parts = targetPaper.split(',').map(p => p.trim())
      const paperFilters = []
      for (const part of parts) {
        if (part.length === 1) {
          paperFilters.push({ paper: parseInt(part) })
        } else if (part.length === 2) {
          paperFilters.push({ paper: parseInt(part[0]), variant: parseInt(part[1]) })
        }
      }
      if (paperFilters.length > 0) {
        query.$or = paperFilters
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
      if (untagged.length === 0 && !force) {
        console.log('  All questions already tagged. Skipping (use --force to overwrite).')
        continue
      }
      console.log(`  ${force ? dirs.length : untagged.length}/${dirs.length} question(s) need tagging.`)

      console.log('  Loading PDF layout data...')
      const blob = await doc.getFileBlob()
      const pageDatas = await sspdf.getPDFContentAll(blob)
      const questionSlices = sliceQuestionTexts(pageDatas, dirs)

      // Determine syllabus level (AS vs A2)
      let level = 'AS'
      const subjectConfig = taggingConfig[doc.subject]
      if (subjectConfig) {
        if (subjectConfig.A2 && subjectConfig.A2.includes(doc.paper)) {
          level = 'A2'
        } else if (subjectConfig.AS && subjectConfig.AS.includes(doc.paper)) {
          level = 'AS'
        }
      } else {
        // Fallback default logic for A-Level
        if (doc.subject.startsWith('9') && doc.paper >= 4) {
          level = 'A2'
        }
      }
      const taggingDir = path.join(__dirname, 'lib', 'tagging', doc.subject)
      const taggingFile = path.join(taggingDir, `${level}.json`)
      
      let syllabusData = []
      if (fs.existsSync(taggingFile)) {
        try {
          syllabusData = JSON.parse(fs.readFileSync(taggingFile, 'utf8'))
        } catch (e) {
          console.warn(`  Failed to parse syllabus file ${taggingFile}: ${e.message}`)
        }
      }

      // Fallback to legacy syllabus_topics.js if tagging file is empty/missing
      if (syllabusData.length === 0 && syllabusTopics[doc.subject]) {
        console.log(`  Using legacy syllabus topics for ${doc.subject} (Level: ${level})`)
        syllabusData = syllabusTopics[doc.subject].map(t => ({ topic_name: t, subtopics: [] }))
      }

      if (syllabusData.length === 0) {
        console.warn(`  No syllabus data available for ${doc.subject} ${level}. Skipping tagging.`)
        continue
      }

      const isMcq = subjectConfig && subjectConfig.mcq_papers && subjectConfig.mcq_papers.includes(doc.paper)
      const mcqBulkSize = (subjectConfig && subjectConfig.mcq_bulk_size) || 5
      const mcqMaxTopics = (subjectConfig && subjectConfig.mcq_max_topics) || 2

      if (isMcq) {
        let questionsToProcess = []
        for (const qs of questionSlices) {
          const dirEntry = dirs.find(d => d.qN === qs.qN)
          if (dirEntry && dirEntry.topics && dirEntry.topics.length > 0 && !force) continue
          questionsToProcess.push(qs)
        }

        for (let i = 0; i < questionsToProcess.length; i += mcqBulkSize) {
          const batch = questionsToProcess.slice(i, i + mcqBulkSize)
          const bulkResults = await tagQuestionsBulkWithGemini(batch, targetSubject, syllabusData, mcqMaxTopics)
          for (const res of bulkResults) {
            await saveTopicsToDoc(doc, res.qN, res.result)
          }
          await new Promise(resolve => setTimeout(resolve, 2000))
        }
      } else {
        for (const { qN, text } of questionSlices) {
          const dirEntry = dirs.find(d => d.qN === qN)
          if (dirEntry && dirEntry.topics && dirEntry.topics.length > 0 && !force) continue

          const result = await tagQuestionWithGemini(qN, text, targetSubject, syllabusData)
          await saveTopicsToDoc(doc, qN, result)

          // Respect rate limits (Thinking mode might be slower/stricter)
          await new Promise(resolve => setTimeout(resolve, 2000))
        }
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
