const should = require('should')
const { PDFDocument } = require('pdf-lib')
const { exportPdf, computePageIndices, TopicExportError, MAX_OUTPUT_PAGES } = require('../lib/topicExport')

// Build a small PDF buffer with `numPages` blank pages (US-Letter sized).
async function makeFixturePdf (numPages) {
  const pdf = await PDFDocument.create()
  for (let i = 0; i < numPages; i++) pdf.addPage([612, 792])
  return Buffer.from(await pdf.save())
}

function makeDoc ({ id, subject, time, paper, variant, type, dirs, numPages, fileType, dirType }) {
  let blobCalls = 0
  const doc = {
    _id: { toString: () => id },
    subject, time, paper, variant, type,
    fileType: fileType || 'pdf',
    numPages: numPages || dirs.length + 1,
    dir: { dirs, type: dirType || 'questions' },
    _blobCalls: () => blobCalls
  }
  doc.getFileBlob = async function () {
    blobCalls++
    if (this._fixtureBlob) return this._fixtureBlob
    this._fixtureBlob = await makeFixturePdf(doc.numPages)
    return this._fixtureBlob
  }
  return doc
}

function mockDb (docs) {
  return {
    find: async function (selector) {
      return docs.filter(d => {
        if (selector.subject && d.subject !== selector.subject) return false
        if (selector.type && selector.type.$in && !selector.type.$in.includes(d.type)) return false
        if (selector.type && typeof selector.type === 'string' && d.type !== selector.type) return false
        if (selector.paper && selector.paper.$in && !selector.paper.$in.includes(d.paper)) return false
        return true
      })
    },
    findOne: async function (selector) {
      const all = await this.find(selector)
      return all.find(d =>
        (!selector.time || d.time === selector.time) &&
        (!selector.paper || d.paper === selector.paper) &&
        (!selector.variant || d.variant === selector.variant) &&
        (!selector.type || d.type === selector.type)
      ) || null
    },
    findById: async function (id) {
      return docs.find(d => d._id.toString() === id) || null
    }
  }
}

const baseReq = {
  subject: '9701', level: 'AS',
  selections: [{ kind: 'subtopic', name: 'Chemical Bonding' }],
  ordering: { mode: 'deterministic' }
}

module.exports = () =>
  describe('topicExport.js', function () {
    describe('computePageIndices', function () {
      it('single-page question (next entry on next page)', function () {
        const dirs = [
          { qN: 1, page: 1 },
          { qN: 2, page: 2 },
          { qN: 3, page: 3 }
        ]
        computePageIndices(dirs, 2, 5).should.deepEqual([2])
      })

      it('multi-page question (next entry two pages later)', function () {
        const dirs = [
          { qN: 1, page: 1 },
          { qN: 2, page: 2 },
          { qN: 3, page: 5 }
        ]
        computePageIndices(dirs, 2, 6).should.deepEqual([2, 3, 4])
      })

      it('last question runs to end of PDF', function () {
        const dirs = [
          { qN: 1, page: 1 },
          { qN: 2, page: 3 }
        ]
        computePageIndices(dirs, 2, 6).should.deepEqual([3, 4, 5])
      })

      it('two questions on same page yields single-page range', function () {
        const dirs = [
          { qN: 1, page: 2 },
          { qN: 2, page: 2 },
          { qN: 3, page: 4 }
        ]
        computePageIndices(dirs, 1, 5).should.deepEqual([2])
        computePageIndices(dirs, 2, 5).should.deepEqual([2, 3])
      })

      it('returns null if qN not found', function () {
        const dirs = [{ qN: 1, page: 1 }]
        should(computePageIndices(dirs, 99, 5)).be.null()
      })

      it('returns null for empty dirs', function () {
        should(computePageIndices([], 1, 5)).be.null()
        should(computePageIndices(null, 1, 5)).be.null()
      })

      it('matches qN given as string or number', function () {
        const dirs = [{ qN: 1, page: 1 }, { qN: 2, page: 3 }]
        computePageIndices(dirs, '1', 5).should.deepEqual([1, 2])
      })
    })

    describe('exportPdf – QP', function () {
      it('produces a merged PDF with one page per matched question', async function () {
        const docs = [
          makeDoc({
            id: 'a', subject: '9701', time: 's22', paper: 1, variant: 1, type: 'qp',
            numPages: 6,
            dirs: [
              { qN: 1, page: 1, topics: ['Chemical Bonding'] },
              { qN: 2, page: 2, topics: ['Chemical Bonding'] },
              { qN: 3, page: 3, topics: ['Chemical Bonding'] }
            ]
          })
        ]
        const { buffer, meta } = await exportPdf(baseReq, 'qp', mockDb(docs))
        const merged = await PDFDocument.load(buffer)
        merged.getPageCount().should.equal(3)
        meta.questionCount.should.equal(3)
        meta.pageCount.should.equal(3)
      })

      it('caches source-blob load (one getFileBlob per doc)', async function () {
        const doc = makeDoc({
          id: 'a', subject: '9701', time: 's22', paper: 1, variant: 1, type: 'qp',
          numPages: 6,
          dirs: [
            { qN: 1, page: 1, topics: ['Chemical Bonding'] },
            { qN: 2, page: 2, topics: ['Chemical Bonding'] },
            { qN: 3, page: 3, topics: ['Chemical Bonding'] },
            { qN: 4, page: 4, topics: ['Chemical Bonding'] }
          ]
        })
        const { buffer } = await exportPdf(baseReq, 'qp', mockDb([doc]))
        should(buffer).be.an.instanceOf(Buffer)
        doc._blobCalls().should.equal(1)
      })

      it('empty result throws NO_ROWS', async function () {
        const docs = [
          makeDoc({
            id: 'a', subject: '9701', time: 's22', paper: 1, variant: 1, type: 'qp',
            numPages: 3,
            dirs: [{ qN: 1, page: 1, topics: ['Unrelated'] }]
          })
        ]
        try {
          await exportPdf(baseReq, 'qp', mockDb(docs))
          should.fail('expected throw')
        } catch (e) {
          e.should.be.an.instanceOf(TopicExportError)
          e.code.should.equal('NO_ROWS')
          e.status.should.equal(400)
        }
      })

      it('rejects unknown kind', async function () {
        try {
          await exportPdf(baseReq, 'xx', mockDb([]))
          should.fail('expected throw')
        } catch (e) {
          e.code.should.equal('BAD_KIND')
        }
      })
    })

    describe('exportPdf – MS', function () {
      it('pairs each QP row with its MS doc and pulls MS pages', async function () {
        const qp = makeDoc({
          id: 'qp1', subject: '9701', time: 's22', paper: 1, variant: 1, type: 'qp',
          numPages: 5,
          dirs: [
            { qN: 1, page: 1, topics: ['Chemical Bonding'] },
            { qN: 2, page: 2, topics: ['Chemical Bonding'] }
          ]
        })
        const ms = makeDoc({
          id: 'ms1', subject: '9701', time: 's22', paper: 1, variant: 1, type: 'ms',
          numPages: 4,
          dirs: [
            { qN: 1, page: 1 },
            { qN: 2, page: 2 }
          ]
        })
        const { buffer, meta } = await exportPdf(baseReq, 'ms', mockDb([qp, ms]))
        const merged = await PDFDocument.load(buffer)
        merged.getPageCount().should.equal(2)
        should(meta.warnings).be.undefined()
      })

      it('mcqMs source: emits non-cover pages once even when some qNs missing from dir.dirs', async function () {
        const qp = makeDoc({
          id: 'qp1', subject: '9701', time: 's20', paper: 1, variant: 2, type: 'qp',
          numPages: 6,
          dirs: [
            { qN: 1, page: 1, topics: ['Chemical Bonding'] },
            { qN: 2, page: 2, topics: ['Chemical Bonding'] },
            { qN: 3, page: 3, topics: ['Chemical Bonding'] }
          ]
        })
        // MS has dir.type 'mcqMs' and is missing qN 2 (mimics the recognizer drop).
        const ms = makeDoc({
          id: 'ms1', subject: '9701', time: 's20', paper: 1, variant: 2, type: 'ms',
          numPages: 2,
          dirType: 'mcqMs',
          dirs: [
            { qN: 1, page: 1 },
            { qN: 3, page: 1 }
          ]
        })
        const { buffer, meta } = await exportPdf(baseReq, 'ms', mockDb([qp, ms]))
        const merged = await PDFDocument.load(buffer)
        merged.getPageCount().should.equal(1)
        meta.pageCount.should.equal(1)
        meta.questionCount.should.equal(3)
        if (meta.warnings) {
          meta.warnings.join(' ').should.not.match(/Could not locate/)
        }
      })

      it('mcqMs source: dedupes — answer table emitted once across multiple rows', async function () {
        const qp = makeDoc({
          id: 'qp1', subject: '9701', time: 's20', paper: 1, variant: 2, type: 'qp',
          numPages: 6,
          dirs: [
            { qN: 1, page: 1, topics: ['Chemical Bonding'] },
            { qN: 2, page: 2, topics: ['Chemical Bonding'] },
            { qN: 3, page: 3, topics: ['Chemical Bonding'] }
          ]
        })
        const ms = makeDoc({
          id: 'ms1', subject: '9701', time: 's20', paper: 1, variant: 2, type: 'ms',
          numPages: 2,
          dirType: 'mcqMs',
          dirs: [
            { qN: 1, page: 1 },
            { qN: 2, page: 1 },
            { qN: 3, page: 1 }
          ]
        })
        const { buffer, meta } = await exportPdf(baseReq, 'ms', mockDb([qp, ms]))
        const merged = await PDFDocument.load(buffer)
        merged.getPageCount().should.equal(1)
        meta.pageCount.should.equal(1)
        meta.questionCount.should.equal(3)
      })

      it('missing MS for a row records a warning and skips it', async function () {
        const qp1 = makeDoc({
          id: 'qp1', subject: '9701', time: 's22', paper: 1, variant: 1, type: 'qp',
          numPages: 5,
          dirs: [{ qN: 1, page: 1, topics: ['Chemical Bonding'] }]
        })
        const qp2 = makeDoc({
          id: 'qp2', subject: '9701', time: 's23', paper: 1, variant: 1, type: 'qp',
          numPages: 5,
          dirs: [{ qN: 1, page: 1, topics: ['Chemical Bonding'] }]
        })
        const ms1 = makeDoc({
          id: 'ms1', subject: '9701', time: 's22', paper: 1, variant: 1, type: 'ms',
          numPages: 4,
          dirs: [{ qN: 1, page: 1 }]
        })
        const { buffer, meta } = await exportPdf(baseReq, 'ms', mockDb([qp1, qp2, ms1]))
        const merged = await PDFDocument.load(buffer)
        merged.getPageCount().should.equal(1)
        meta.warnings.should.be.an.Array()
        meta.warnings.join(' ').should.match(/No MS for 9701\/s23/)
      })
    })

    describe('exportPdf – limits', function () {
      it('throws TOO_LARGE when output would exceed MAX_OUTPUT_PAGES', async function () {
        const bigDirs = []
        for (let i = 1; i <= 5; i++) bigDirs.push({ qN: i, page: i, topics: ['Chemical Bonding'] })
        const huge = makeDoc({
          id: 'huge', subject: '9701', time: 's22', paper: 1, variant: 1, type: 'qp',
          // Last question spans many pages, so its range will blow past the cap.
          numPages: MAX_OUTPUT_PAGES + 50,
          dirs: bigDirs
        })
        try {
          await exportPdf(baseReq, 'qp', mockDb([huge]))
          should.fail('expected throw')
        } catch (e) {
          e.code.should.equal('TOO_LARGE')
          e.status.should.equal(413)
        }
      })
    })
  })
