const mongoose = require('mongoose')
const elasticsearch = require('elasticsearch')
const sspdf = require('./lib/sspdf.js')

const DB_URI = process.env.MONGODB || 'mongodb://mw-mongo/schsrch'
const ES_HOST = process.env.ES || 'mw-es:9200'

mongoose.Promise = global.Promise
let db = mongoose.createConnection(DB_URI)
let es = new elasticsearch.Client({ host: ES_HOST })

db.on('error', err => {
  console.error(err)
  process.exit(1)
})

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

db.on('open', async () => {
  const { PastPaperDoc } = await require('./lib/dbModel.js')(db, es)
  const doc = await PastPaperDoc.findOne({ subject: '9701', time: 'w13', paper: 5, variant: 2, type: 'qp' })
  if (!doc) {
    console.log('Doc not found')
    process.exit(0)
  }
  
  if (!doc.dir || !doc.dir.dirs) {
    console.log('No dir')
    process.exit(0)
  }
  
  console.log('Found doc:', doc._id)
  const blob = await doc.getFileBlob()
  const pageDatas = await sspdf.getPDFContentAll(blob)
  const slices = sliceQuestionTexts(pageDatas, doc.dir.dirs)
  for (let s of slices) {
    if (s.qN > 1) {
      console.log(`--- Q${s.qN} ---`)
      console.log(s.text.substring(0, 100))
    }
  }
  process.exit(0)
})
