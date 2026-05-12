const should = require('should')
const { loadSyllabus, resolveSelectedTags, queryQuestions } = require('../lib/topicQuery')

// Minimal mock PastPaperDoc.find that returns docs with pre-built dirs
function mockFind (docs) {
  return {
    find: async function (selector, proj) {
      return docs.filter(doc => {
        if (selector.subject && doc.subject !== selector.subject) return false
        if (selector.type && selector.type.$in && !selector.type.$in.includes(doc.type)) return false
        if (selector.paper && selector.paper.$in && !selector.paper.$in.includes(doc.paper)) return false
        return true
      })
    }
  }
}

function makeDoc (subject, time, paper, variant, type, dirs) {
  return {
    _id: { toString: () => `${subject}_${time}_${paper}_${variant}` },
    subject, time, paper, variant, type,
    ensureDir: async () => ({ dirs })
  }
}

function makeDir (qN, topics, subparts) {
  return { qN, page: 1, qNRect: null, topics: topics || [], subparts: subparts || [] }
}

module.exports = () =>
  describe('topicQuery.js', function () {
    // ── loadSyllabus ──────────────────────────────────────────────────────────
    describe('loadSyllabus', function () {
      it('returns topics array for a known subject+level', function () {
        const s = loadSyllabus('9701', 'AS')
        should(s).not.be.null()
        s.should.have.property('topics').which.is.an.Array()
        s.topics.length.should.be.above(0)
        s.topics[0].should.have.property('topic_name')
        s.topics[0].should.have.property('subtopics').which.is.an.Array()
      })
      it('returns null for unknown subject', function () {
        should(loadSyllabus('9999', 'AS')).be.null()
      })
    })

    // ── resolveSelectedTags ──────────────────────────────────────────────────
    describe('resolveSelectedTags', function () {
      const syllabus = loadSyllabus('9701', 'AS')

      it('subtopic kind passes through directly', function () {
        const tags = resolveSelectedTags(
          { selections: [{ kind: 'subtopic', name: 'Isotopes' }] },
          syllabus
        )
        tags.has('Isotopes').should.be.true()
        tags.size.should.equal(1)
      })

      it('topic kind expands to all its subtopics', function () {
        const topicName = syllabus.topics[0].topic_name
        const expectedSubs = syllabus.topics[0].subtopics.map(s => s.name)
        const tags = resolveSelectedTags(
          { selections: [{ kind: 'topic', name: topicName }] },
          syllabus
        )
        expectedSubs.forEach(n => tags.has(n).should.be.true())
        tags.size.should.equal(expectedSubs.length)
      })

      it('returns empty set for empty selections', function () {
        resolveSelectedTags({ selections: [] }, syllabus).size.should.equal(0)
      })

      it('returns empty set when syllabus is null', function () {
        resolveSelectedTags({ selections: [{ kind: 'subtopic', name: 'x' }] }, null).size.should.equal(0)
      })

      it('unknown topic kind produces no tags', function () {
        const tags = resolveSelectedTags(
          { selections: [{ kind: 'topic', name: 'NonExistentTopicXYZ' }] },
          syllabus
        )
        tags.size.should.equal(0)
      })
    })

    // ── queryQuestions – ordering ─────────────────────────────────────────────
    describe('queryQuestions – ordering', function () {
      const docs = [
        makeDoc('9701', 's23', 1, 2, 'qp', [
          makeDir(3, ['Chemical Bonding']),
          makeDir(1, ['Chemical Bonding'])
        ]),
        makeDoc('9701', 'm23', 1, 1, 'qp', [
          makeDir(2, ['Chemical Bonding'])
        ]),
        makeDoc('9701', 's22', 1, 1, 'qp', [
          makeDir(1, ['Chemical Bonding'])
        ])
      ]
      const DB = mockFind(docs)
      const req = {
        subject: '9701', level: 'AS',
        selections: [{ kind: 'subtopic', name: 'Chemical Bonding' }],
        ordering: { mode: 'deterministic' }
      }

      it('deterministic: sorted by year asc then season then paper then variant then qN', async function () {
        const { rows } = await queryQuestions(req, DB)
        rows.length.should.equal(4)
        // s22/1/1 q1 < m23/1/1 q2 < s23/1/2 q1 < s23/1/2 q3
        rows[0].time.should.equal('s22')
        rows[0].qN.should.equal(1)
        rows[1].time.should.equal('m23')
        rows[1].qN.should.equal(2)
        rows[2].time.should.equal('s23')
        rows[2].qN.should.equal(1)
        rows[3].time.should.equal('s23')
        rows[3].qN.should.equal(3)
      })

      it('random: same seed gives same order', async function () {
        const reqRand = Object.assign({}, req, { ordering: { mode: 'random', seed: 42 } })
        const { rows: r1 } = await queryQuestions(reqRand, DB)
        const { rows: r2 } = await queryQuestions(reqRand, DB)
        r1.map(r => r.qN + r.time).should.deepEqual(r2.map(r => r.qN + r.time))
      })

      it('random: different seed gives different order (with high probability)', async function () {
        const r1 = (await queryQuestions(Object.assign({}, req, { ordering: { mode: 'random', seed: 1 } }), DB)).rows
        const r2 = (await queryQuestions(Object.assign({}, req, { ordering: { mode: 'random', seed: 999999 } }), DB)).rows
        const same = r1.every((r, i) => r.qN === r2[i].qN && r.time === r2[i].time)
        same.should.be.false()
      })

      it('meta.seed is returned for random mode', async function () {
        const { meta } = await queryQuestions(
          Object.assign({}, req, { ordering: { mode: 'random', seed: 7 } }), DB
        )
        meta.seed.should.equal(7)
      })

      it('meta.seed absent for deterministic mode', async function () {
        const { meta } = await queryQuestions(req, DB)
        should(meta.seed).be.undefined()
      })
    })

    // ── queryQuestions – sampling ─────────────────────────────────────────────
    describe('queryQuestions – sampling cap', function () {
      const manyDocs = Array.from({ length: 3 }, (_, i) =>
        makeDoc('9701', `s2${i}`, 1, 1, 'qp',
          Array.from({ length: 5 }, (__, j) => makeDir(j + 1, ['Chemical Bonding']))
        )
      )
      const DB = mockFind(manyDocs)
      const base = {
        subject: '9701', level: 'AS',
        selections: [{ kind: 'subtopic', name: 'Chemical Bonding' }],
        ordering: { mode: 'deterministic' }
      }

      it('cap returns exactly total rows', async function () {
        const { rows, meta } = await queryQuestions(
          Object.assign({}, base, { sampling: { mode: 'cap', total: 7 } }), DB
        )
        rows.length.should.equal(7)
        meta.total.should.equal(7)
      })

      it('cap with total > matched returns all and sets warning', async function () {
        const { rows, meta } = await queryQuestions(
          Object.assign({}, base, { sampling: { mode: 'cap', total: 1000 } }), DB
        )
        rows.length.should.equal(15) // 3 docs × 5 questions
        meta.warning.should.be.a.String()
        meta.warning.should.containEql('only 15')
      })
    })

    describe('queryQuestions – sampling proportions', function () {
      // Two topic pools: 6 Bonding + 4 Energetics
      const docs = [
        makeDoc('9701', 's22', 1, 1, 'qp', [
          makeDir(1, ['Chemical Bonding']),
          makeDir(2, ['Chemical Bonding']),
          makeDir(3, ['Chemical Bonding']),
          makeDir(4, ['Chemical Bonding']),
          makeDir(5, ['Chemical Bonding']),
          makeDir(6, ['Chemical Bonding'])
        ]),
        makeDoc('9701', 's22', 2, 1, 'qp', [
          makeDir(1, ['Chemical Energetics']),
          makeDir(2, ['Chemical Energetics']),
          makeDir(3, ['Chemical Energetics']),
          makeDir(4, ['Chemical Energetics'])
        ])
      ]
      const DB = mockFind(docs)
      const base = {
        subject: '9701', level: 'AS',
        selections: [
          { kind: 'subtopic', name: 'Chemical Bonding' },
          { kind: 'subtopic', name: 'Chemical Energetics' }
        ],
        ordering: { mode: 'deterministic' },
        sampling: {
          mode: 'proportions',
          total: 10,
          perTopic: [
            { topic: 'Chemical Bonding', pct: 60 },
            { topic: 'Chemical Energetics', pct: 40 }
          ]
        }
      }

      it('total adds up to requested total', async function () {
        const { rows } = await queryQuestions(base, DB)
        rows.length.should.equal(10)
      })

      it('proportions roughly match: 6 Bonding and 4 Energetics', async function () {
        const { rows } = await queryQuestions(base, DB)
        const bonding = rows.filter(r => r.matchedTopics.includes('Chemical Bonding')).length
        const energetics = rows.filter(r => r.matchedTopics.includes('Chemical Energetics')).length
        bonding.should.equal(6)
        energetics.should.equal(4)
      })

      it('rounding remainder goes to highest-pct bucket', async function () {
        // total=10, 70/30 split → 7+3=10 exactly (no remainder)
        // total=10, 60/41 split → 6+4=10, but 60+41=101 (unusual)
        // Test: total=3, 50/50 → round(1.5) + round(1.5) → 2+2=4 ≠ 3; remainder corrects higher-pct
        const req3 = Object.assign({}, base, {
          sampling: {
            mode: 'proportions',
            total: 3,
            perTopic: [
              { topic: 'Chemical Bonding', pct: 50 },
              { topic: 'Chemical Energetics', pct: 50 }
            ]
          }
        })
        const { rows } = await queryQuestions(req3, DB)
        rows.length.should.equal(3)
      })
    })

    // ── queryQuestions – subpart matching ─────────────────────────────────────
    describe('queryQuestions – subpart matching', function () {
      const docs = [
        makeDoc('9701', 's22', 1, 1, 'qp', [
          // Question with no top-level topic but matching subpart
          makeDir(1, [], [
            { part: 'a', topics: ['Isotopes'] },
            { part: 'b', topics: ['Atomic Radius'] }
          ]),
          // Question with top-level topic and a matching subpart
          makeDir(2, ['Isotopes'], [
            { part: 'a', topics: ['Isotopes'] },
            { part: 'b', topics: ['Chemical Bonding'] }
          ])
        ])
      ]
      const DB = mockFind(docs)
      const base = {
        subject: '9701', level: 'AS',
        selections: [{ kind: 'subtopic', name: 'Isotopes' }],
        ordering: { mode: 'deterministic' }
      }

      it('question with only subpart match is included', async function () {
        const { rows } = await queryQuestions(base, DB)
        rows.some(r => r.qN === 1).should.be.true()
      })

      it('matchedSubparts correctly identifies which subparts matched', async function () {
        const { rows } = await queryQuestions(base, DB)
        const q1 = rows.find(r => r.qN === 1)
        q1.matchedSubparts.should.deepEqual(['a'])
        q1.matchedTopics.should.deepEqual(['Isotopes'])
      })

      it('question without matching topics or subparts is excluded', async function () {
        const req2 = Object.assign({}, base, {
          selections: [{ kind: 'subtopic', name: 'SomethingThatDoesNotMatch' }]
        })
        const { rows } = await queryQuestions(req2, DB)
        rows.length.should.equal(0)
      })

      it('only matching subparts are listed in matchedSubparts', async function () {
        const { rows } = await queryQuestions(base, DB)
        const q2 = rows.find(r => r.qN === 2)
        q2.matchedSubparts.should.deepEqual(['a'])
        q2.matchedTopics.should.containEql('Isotopes')
      })
    })

    // ── queryQuestions – year / season filter ────────────────────────────────
    describe('queryQuestions – year and season filter', function () {
      const docs = [
        makeDoc('9701', 's21', 1, 1, 'qp', [makeDir(1, ['Chemical Bonding'])]),
        makeDoc('9701', 's22', 1, 1, 'qp', [makeDir(1, ['Chemical Bonding'])]),
        makeDoc('9701', 'm22', 1, 1, 'qp', [makeDir(1, ['Chemical Bonding'])]),
        makeDoc('9701', 'w23', 1, 1, 'qp', [makeDir(1, ['Chemical Bonding'])])
      ]
      const DB = mockFind(docs)
      const base = {
        subject: '9701', level: 'AS',
        selections: [{ kind: 'subtopic', name: 'Chemical Bonding' }],
        ordering: { mode: 'deterministic' }
      }

      it('year from filter works', async function () {
        const { rows } = await queryQuestions(Object.assign({}, base, { years: { from: 2022 } }), DB)
        rows.every(r => {
          const yr = parseInt(r.time.substr(1))
          return (yr < 100 ? 2000 + yr : yr) >= 2022
        }).should.be.true()
        rows.length.should.equal(3)
      })

      it('year to filter works', async function () {
        const { rows } = await queryQuestions(Object.assign({}, base, { years: { to: 2022 } }), DB)
        rows.length.should.equal(3) // s21, s22, m22
      })

      it('season filter works', async function () {
        const { rows } = await queryQuestions(Object.assign({}, base, { seasons: ['s'] }), DB)
        rows.every(r => r.time[0] === 's').should.be.true()
        rows.length.should.equal(2)
      })
    })
  })
