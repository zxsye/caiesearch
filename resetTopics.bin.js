#!/usr/bin/env node
const { MONGODB, ES } = process.env
const mongoose = require('mongoose')
const elasticsearch = require('elasticsearch')

const DB_URI = MONGODB || 'mongodb://mw-mongo/schsrch'
const ES_HOST = ES || 'mw-es:9200'

const targetSubject = process.argv[2]
if (!targetSubject) {
  console.error('Usage: node resetTopics.bin.js <subjectId>')
  process.exit(1)
}

let db = mongoose.createConnection(DB_URI)
let es = new elasticsearch.Client({ host: ES_HOST })

db.on('open', async () => {
  console.log(`Connected to database. Resetting topics for subject ${targetSubject}...`)
  const { PastPaperDoc } = await require('./lib/dbModel.js')(db, es)

  try {
    const query = { subject: targetSubject, type: 'qp' }
    const docs = await PastPaperDoc.find(query)
    console.log(`Found ${docs.length} QP docs. Clearing topic tags...`)
    
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
