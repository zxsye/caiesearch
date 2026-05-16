const mongoose = require('mongoose')
const elasticsearch = require('elasticsearch')
const sspdf = require('./lib/sspdf.js')
const Recognizer = require('./lib/recognizer.js')

const DB_URI = process.env.MONGODB || 'mongodb://mw-mongo/schsrch'
const ES_HOST = process.env.ES || 'mw-es:9200'

mongoose.Promise = global.Promise
let db = mongoose.createConnection(DB_URI)
let es = new elasticsearch.Client({ host: ES_HOST })

db.on('error', err => {
  console.error(err)
  process.exit(1)
})

db.on('open', async () => {
  const { PastPaperDoc } = await require('./lib/dbModel.js')(db, es)
  const doc = await PastPaperDoc.findOne({ subject: '9701', time: 'w13', paper: 4, variant: 3, type: 'qp' })
  if (!doc) {
    console.log('Doc not found')
    process.exit(0)
  }
  
  const blob = await doc.getFileBlob()
  const pageDatas = await sspdf.getPDFContentAll(blob)
  
  // Transform pageDatas into idxes for Recognizer
  let idxes = pageDatas.pageRects.map((rects, i) => {
    return {
      rects,
      content: pageDatas.pageTexts[i],
      page: i
    }
  })
  
  const result = Recognizer.dir(idxes)
  console.log('Detected questions:', result.dirs.map(d => d.qN))
  for (let d of result.dirs) {
    console.log(`Q${d.qN} at page ${d.page}, x1: ${d.qNRect.x1}`)
  }
  process.exit(0)
})
