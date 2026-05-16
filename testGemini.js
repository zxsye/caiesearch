const mongoose = require('mongoose')
const { GoogleGenAI } = require('@google/genai')
const fs = require('fs')
const path = require('path')
const elasticsearch = require('elasticsearch')
const sspdf = require('./lib/sspdf.js')

const DB_URI = 'mongodb://mw-mongo/schsrch'
const ES_HOST = 'mw-es:9200'

mongoose.Promise = global.Promise
let db = mongoose.createConnection(DB_URI)
let es = new elasticsearch.Client({ host: ES_HOST })

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
const MODEL_NAME = 'gemini-3.1-flash-lite'

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

async function tagQuestionWithGemini(qN, questionText, subjectId, syllabusData) {
  const syllabusStr = JSON.stringify(syllabusData, null, 2)
  const prompt =
    `You are a CIE (Cambridge International) examiner for subject ${subjectId}. ` +
    `Below is the exact text of Question ${qN} extracted from a past exam paper.\n\n` +
    `Your task: for each main part of the question, list which SYLLABUS SUBTOPICS it assesses.\n\n` +
    `Syllabus Structure:\n${syllabusStr}\n\n` +
    `Question Text:\n${questionText}\n\n` +
    `Return a JSON array with one object per top-level part of the question. ` +
    `Top-level parts are typically labeled (a), (b), etc., but in many questions they are labeled (i), (ii), etc., without any (a) or (b). ` +
    `Identify the highest level of structure used in THIS question and create one object per top-level part. ` +
    `Do not split nested sub-parts (e.g. an (i) inside an (a)) into separate rows; combine them under their parent part.\n` +
    `CRITICAL: If the question has no numbered or lettered parts at all, you MUST return exactly ONE object with "part": null.\n\n` +
    `Labelling rules:\n` +
    `- Prefer the finest level: use each subtopic's exact string value from the field "name" inside "subtopics" (copy character-for-character).\n` +
    `- If a syllabus topic has an empty "subtopics" array, you may use that topic's "topic_name" instead.\n` +
    `- Do not return parent topic_name when that topic lists subtopics — choose the relevant subtopic name(s) only.\n` +
    `- Do not return learning_outcomes text; only subtopic "name" or bare topic_name as above.\n\n` +
    `Each object must have:\n` +
    `- "part": The label of the top-level part (e.g. "(a)", "(b)", or "(i)", "(ii)" if those are the top-level, or null if there are no parts).\n` +
    `- "topics": A JSON array of those allowed labels (one or more per part).\n\n` +
    `Return ONLY the JSON array. Do not include markdown or explanations.`

  try {
    const response = await ai.models.generateContentStream({
      model: MODEL_NAME,
      config: { thinkingConfig: { thinkingLevel: 'MINIMAL' } },
      contents: [{ role: 'user', parts: [{ text: prompt }] }]
    })

    let fullText = ''
    for await (const chunk of response) {
      if (chunk.text) fullText += chunk.text
    }
    console.log(`--- RAW RESPONSE FOR Q${qN} ---\n${fullText}\n-------------------------\n`)
  } catch (e) {
    console.error(`Error: ${e.message}`)
  }
}

db.on('open', async () => {
  const { PastPaperDoc } = await require('./lib/dbModel.js')(db, es)
  const doc = await PastPaperDoc.findOne({ _id: '6a01c8ca25e41f001bc997a9' })
  
  const blob = await doc.getFileBlob()
  const pageDatas = await sspdf.getPDFContentAll(blob)
  const slices = sliceQuestionTexts(pageDatas, doc.dir.dirs)
  
  const syllabusData = JSON.parse(fs.readFileSync(path.join(__dirname, 'lib', 'tagging', '9709', 'A2.json'), 'utf8'))

  for (let qs of slices) {
    if (qs.qN === 6) {
      console.log(`Running Gemini for Q${qs.qN}...`)
      await tagQuestionWithGemini(qs.qN, qs.text, '9709', syllabusData)
    }
  }
  process.exit(0)
})
