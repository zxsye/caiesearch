#!/usr/bin/env node
const { MONGODB, ES } = process.env
const mongoose = require('mongoose')
const elasticsearch = require('elasticsearch')

const DB_URI = MONGODB || 'mongodb://mw-mongo/schsrch'
const ES_HOST = ES || 'mw-es:9200'

const targetSubject = process.argv[2]
const targetPaper = parseInt(process.argv[3])
const yearRange = process.argv[4] // e.g. "15-19"

if (!targetSubject || isNaN(targetPaper) || !yearRange) {
  console.error('Usage: node clearSpecificTopics.bin.js <subjectId> <paper> <yearRange>')
  console.error('Example: node clearSpecificTopics.bin.js 9709 6 15-19')
  process.exit(1)
}

let db = mongoose.createConnection(DB_URI)
let es = new elasticsearch.Client({ host: ES_HOST })

db.on('open', async () => {
  console.log(`Connected to database. Clearing topics for subject ${targetSubject}, Paper ${targetPaper}, Years ${yearRange}...`)
  const { PastPaperDoc } = await require('./lib/dbModel.js')(db, es)

  try {
    const [start, end] = yearRange.split('-').map(y => parseInt(y.trim()))
    const years = []
    for (let y = start; y <= end; y++) {
      years.push(y.toString().padStart(2, '0'))
    }
    const timeRegex = new RegExp(`(${years.join('|')})$`)

    const query = { 
      subject: targetSubject, 
      paper: targetPaper,
      time: timeRegex,
      type: 'qp' 
    }
    
    const docs = await PastPaperDoc.find(query)
    console.log(`Found ${docs.length} QP docs matching criteria. Clearing topic tags...`)
    
    let clearedCount = 0
    for (const doc of docs) {
      if (doc.dir && doc.dir.dirs) {
        let modified = false
        for (const entry of doc.dir.dirs) {
          if ((entry.topics && entry.topics.length > 0) || (entry.subparts && entry.subparts.length > 0)) {
            entry.topics = []
            entry.subparts = []
            modified = true
          }
        }
        if (modified) {
          doc.markModified('dir')
          await doc.save()
          clearedCount++
        }
      }
    }
    console.log(`✓ Cleared topics in ${clearedCount} QP docs.`)
    console.log('\nReset complete.')
  } catch (err) {
    console.error('Reset error:', err)
  } finally {
    process.exit(0)
  }
})
