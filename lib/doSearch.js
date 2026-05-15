const PaperUtils = require('../view/paperutils.js')
const ParseQuery = require('./parseQuery.js')
const {
  collectLabelsFromDirEntry,
  resolveLabelsToTopicTitles,
  countParentTopicCoverage,
  loadSyllabusForSubjectPaper
} = require('./tagging/syllabusTagLabels.js')

module.exports = function ({PastPaperDoc, PastPaperIndex, PastPaperFeedback}) {
  function doSearch (query) {
    function findRelated (doc) {
      return PastPaperDoc.find({$or: [
        PaperUtils.extractSet(doc),
        {
          subject: doc.subject,
          time: doc.time,
          paper: 0,
          variant: 0
        }
      ]}, {_id: true, type: true, fileType: true, numPages: true})
        .then(rst => Promise.resolve(rst.filter(x => x._id.toString() !== doc._id.toString())))
    }
    if (query.trim().length === 0) {
      return Promise.resolve({
        response: 'overflow'
      })
    }
    return new Promise((resolve, reject) => {
      let lQuery = query.toLowerCase()
      let match
      let parsedQuery
      if ((match = lQuery.match(/^!!index!([0-9a-f]+)$/))) {
        let id = match[1]
        PastPaperIndex.findOne({_id: id}).then(rstIndex => {
          if (!rstIndex) {
            resolve({
              response: 'text',
              list: []
            })
          } else {
            PastPaperDoc.findOne({_id: rstIndex.docId}, {fileBlob: false, dir: false}).then(rstDoc => {
              if (!rstDoc) {
                resolve({
                  response: 'text',
                  list: []
                })
              } else {
                findRelated(rstDoc).then(rstRelated => {
                  resolve({
                    response: 'text',
                    list: [{doc: rstDoc, index: rstIndex, related: rstRelated}]
                  })
                }, err => resolve(({ response: 'text', list: [{doc: rstDoc, index: rstIndex, related: []}] })))
              }
            }, err => reject({response: 'error', err: err.toString()}))
          }
        }, err => reject({response: 'error', err: err.toString()}))
      } else if ((parsedQuery = ParseQuery(query))) {
        let {subject, time, paper, variant, type} = parsedQuery.queryParsed
        PastPaperDoc.find(parsedQuery.finder, {fileBlob: false, dir: false}).limit(71).then(rst => {
          if (rst.length >= 71) {
            if (subject && time === null && paper === null && variant === null && type === null) {
              responseSubjectOverflow(subject)
            } else {
              resolve({
                response: 'overflow'
              })
            }
            return
          }
          // Enrich each doc with aggregated topic *titles* for UI (parent topics), derived from
          // dir.dirs[i].topics plus subparts[].topics via syllabus mapping.
          const syllabusCache = new Map()
          Promise.all(rst.map(doc => {
            if (doc.fileType !== 'pdf') {
              let enriched = doc.toObject ? doc.toObject() : Object.assign({}, doc)
              enriched.topics = []
              enriched.topicCoverage = null
              return Promise.resolve(enriched)
            }
            return PastPaperDoc.findOne({_id: doc._id}, {dir: true}).then(fullDoc => {
              const enriched = doc.toObject ? doc.toObject() : Object.assign({}, doc)
              if (!fullDoc) {
                enriched.topics = []
                enriched.topicCoverage = null
                return enriched
              }
              const labels = []
              if (fullDoc.dir && Array.isArray(fullDoc.dir.dirs)) {
                for (const q of fullDoc.dir.dirs) {
                  labels.push(...collectLabelsFromDirEntry(q))
                }
              }
              const cacheKey = `${doc.subject}:${Number(doc.paper)}`
              if (!syllabusCache.has(cacheKey)) {
                const loaded = loadSyllabusForSubjectPaper(doc.subject, doc.paper)
                syllabusCache.set(cacheKey, loaded ? loaded.syllabusData : null)
              }
              const syllabusData = syllabusCache.get(cacheKey)
              if (syllabusData && syllabusData.length > 0) {
                enriched.topics = resolveLabelsToTopicTitles(syllabusData, labels)
                if (doc.type === 'qp' && fullDoc.dir && Array.isArray(fullDoc.dir.dirs)) {
                  const dt = fullDoc.dir.type
                  if (!dt || dt === 'questions') {
                    enriched.topicCoverage = countParentTopicCoverage(syllabusData, fullDoc.dir.dirs)
                  } else {
                    enriched.topicCoverage = null
                  }
                } else {
                  enriched.topicCoverage = null
                }
              } else {
                const topicsSet = new Set()
                for (const t of labels) topicsSet.add(t)
                enriched.topics = [...topicsSet].sort()
                enriched.topicCoverage = null
              }
              return enriched
            })
          })).then(enrichedList => {
            resolve({
              response: 'pp',
              list: enrichedList,
              typeFilter: type
            })
          }, err => {
            // Fallback: resolve without topics if enrichment fails
            resolve({response: 'pp', list: rst, typeFilter: type})
          })
        }, err => {
          reject({response: 'error', err: err.toString()})
        })
      } else {
        PastPaperIndex.search(query).then(results => {
          const syllabusCache = new Map()
          function parentTopicsForDoc (doc, rawTopics) {
            if (!doc || !Array.isArray(rawTopics) || rawTopics.length === 0) return rawTopics
            const cacheKey = `${doc.subject}:${doc.paper}`
            if (!syllabusCache.has(cacheKey)) {
              const loaded = loadSyllabusForSubjectPaper(doc.subject, doc.paper)
              syllabusCache.set(cacheKey, loaded && loaded.syllabusData ? loaded.syllabusData : null)
            }
            const syllabusData = syllabusCache.get(cacheKey)
            if (syllabusData && syllabusData.length > 0) {
              return resolveLabelsToTopicTitles(syllabusData, rawTopics)
            }
            return rawTopics
          }
          Promise.all(results.map(rst => new Promise((resolve, reject) => {
            findRelated(rst.doc).then(related => {
              const index = Object.assign({}, rst.index)
              index.topics = parentTopicsForDoc(rst.doc, index.topics || [])
              resolve({doc: rst.doc, index, related: related})
            }, err => {
              const index = Object.assign({}, rst.index)
              index.topics = parentTopicsForDoc(rst.doc, index.topics || [])
              resolve({doc: rst.doc, index, related: []})
            })
          }))).then(rst => resolve({
            response: 'text',
            list: rst
          }), err => reject({response: 'error', err: err.toString()}))
        }).catch(err => {
          reject({response: 'error', err: err.toString()})
        })
      }

      function responseSubjectOverflow (subject) {
        Promise.all([
            PastPaperDoc.aggregate([{$match: {subject}}, {$sort: {time: 1}}, {$group: {_id: '$time', count: {$sum: 1}}}]),
            PastPaperDoc.find({subject, type: {$in: PaperUtils.subjectMetaTypes}}, {fileBlob: false, dir: false})
          ]).then(([agg, metaDocs]) => {
            resolve({
              response: 'overflow',
              subject: true,
              times: agg.map(timedoc => ({time: timedoc._id, count: timedoc.count})).sort((a, b) => {
                return PaperUtils.funcSortSet({subject, time: a.time, paper: 0, variant: 0}, {subject, time: b.time, paper: 0, variant: 0})
              }),
              metaDocs: metaDocs.sort(PaperUtils.funcSortSet)
            })
          }, err => {
            reject({response: 'error', err: err.toString()})
          })
      }
    })
  }

  return doSearch
}
