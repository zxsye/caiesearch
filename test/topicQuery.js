const should = require('should')
const { loadSyllabus, resolveSelectedTags, resolveSelectionTagSets, queryQuestions } = require('../lib/topicQuery')

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
  const dirObj = { dirs }
  return {
    _id: { toString: () => `${subject}_${time}_${paper}_${variant}` },
    subject, time, paper, variant, type,
    dir: dirObj,
    ensureDir: async () => dirObj
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

    describe('queryQuestions – sampling proportions (perSelection)', function () {
      // Three topic pools, all from a single doc to simplify
      function buildDocs (counts) {
        const dirs = []
        let qN = 1
        for (const [topic, n] of counts) {
          for (let i = 0; i < n; i++) dirs.push(makeDir(qN++, [topic]))
        }
        return [makeDoc('9701', 's22', 1, 1, 'qp', dirs)]
      }

      const selectionsThree = [
        { kind: 'subtopic', name: 'Chemical Bonding' },
        { kind: 'subtopic', name: 'Chemical Energetics' },
        { kind: 'subtopic', name: 'Isotopes' }
      ]
      const baseThree = {
        subject: '9701', level: 'AS',
        selections: selectionsThree,
        ordering: { mode: 'deterministic' }
      }

      it('1:2:1 of 100 yields 25/50/25 buckets and total=100', async function () {
        const DB = mockFind(buildDocs([
          ['Chemical Bonding', 40],
          ['Chemical Energetics', 60],
          ['Isotopes', 30]
        ]))
        const { rows, meta } = await queryQuestions(Object.assign({}, baseThree, {
          sampling: {
            mode: 'proportions', total: 100,
            perSelection: [
              { kind: 'subtopic', name: 'Chemical Bonding', weight: 1 },
              { kind: 'subtopic', name: 'Chemical Energetics', weight: 2 },
              { kind: 'subtopic', name: 'Isotopes', weight: 1 }
            ]
          }
        }), DB)
        rows.length.should.equal(100)
        meta.total.should.equal(100)
        const bonding = rows.filter(r => r.matchedTopics.includes('Chemical Bonding')).length
        const energetics = rows.filter(r => r.matchedTopics.includes('Chemical Energetics')).length
        const isotopes = rows.filter(r => r.matchedTopics.includes('Isotopes')).length
        bonding.should.equal(25)
        energetics.should.equal(50)
        isotopes.should.equal(25)
        meta.perSelectionCounts['subtopic:Chemical Bonding'].picked.should.equal(25)
        meta.perSelectionCounts['subtopic:Chemical Energetics'].picked.should.equal(50)
        meta.perSelectionCounts['subtopic:Isotopes'].picked.should.equal(25)
        should(meta.warning).be.undefined()
      })

      it('underfilled bucket: take what is available and surface warning', async function () {
        const DB = mockFind(buildDocs([
          ['Chemical Bonding', 100],
          ['Chemical Energetics', 5],   // quota 25 but only 5 available
          ['Isotopes', 100]
        ]))
        const { rows, meta } = await queryQuestions(Object.assign({}, baseThree, {
          sampling: {
            mode: 'proportions', total: 100,
            perSelection: [
              { kind: 'subtopic', name: 'Chemical Bonding', weight: 1 },
              { kind: 'subtopic', name: 'Chemical Energetics', weight: 1 },
              { kind: 'subtopic', name: 'Isotopes', weight: 2 }
            ]
          }
        }), DB)
        // 25 + 5 + 50 = 80
        rows.length.should.equal(80)
        meta.perSelectionCounts['subtopic:Chemical Energetics']
          .should.deepEqual({ picked: 5, available: 5, quota: 25 })
        meta.perSelectionCounts['subtopic:Chemical Bonding'].picked.should.equal(25)
        meta.perSelectionCounts['subtopic:Isotopes'].picked.should.equal(50)
        meta.warning.should.be.a.String()
        meta.warning.should.containEql('subtopic:Chemical Energetics (5/25)')
      })

      it('weight 0 excludes that selection entirely', async function () {
        const DB = mockFind(buildDocs([
          ['Chemical Bonding', 50],
          ['Chemical Energetics', 50],
          ['Isotopes', 50]
        ]))
        const { rows, meta } = await queryQuestions(Object.assign({}, baseThree, {
          sampling: {
            mode: 'proportions', total: 20,
            perSelection: [
              { kind: 'subtopic', name: 'Chemical Bonding', weight: 1 },
              { kind: 'subtopic', name: 'Chemical Energetics', weight: 0 },
              { kind: 'subtopic', name: 'Isotopes', weight: 1 }
            ]
          }
        }), DB)
        rows.length.should.equal(20)
        rows.filter(r => r.matchedTopics.includes('Chemical Energetics')).length.should.equal(0)
        should(meta.perSelectionCounts['subtopic:Chemical Energetics']).be.undefined()
      })

      it('selection-order priority: row matching A and B lands in A bucket when A is first', async function () {
        // Single question matches both selections via two distinct topic tags.
        const docs = [makeDoc('9701', 's22', 1, 1, 'qp', [
          makeDir(1, ['Chemical Bonding', 'Isotopes'])
        ])]
        const DB = mockFind(docs)
        const { rows, meta } = await queryQuestions({
          subject: '9701', level: 'AS',
          selections: [
            { kind: 'subtopic', name: 'Chemical Bonding' },
            { kind: 'subtopic', name: 'Isotopes' }
          ],
          ordering: { mode: 'deterministic' },
          sampling: {
            mode: 'proportions', total: 1,
            perSelection: [
              { kind: 'subtopic', name: 'Chemical Bonding', weight: 1 },
              { kind: 'subtopic', name: 'Isotopes', weight: 1 }
            ]
          }
        }, DB)
        rows.length.should.equal(1)
        // Only 1 question, 2 buckets, weight 1:1, total 1 → quota 1+0 (rounded up to higher-weight, both equal so first).
        // Either way the row should be assigned to Bonding bucket (first-match wins).
        meta.perSelectionCounts['subtopic:Chemical Bonding'].available.should.equal(1)
        meta.perSelectionCounts['subtopic:Isotopes'].available.should.equal(0)
      })

      it('random ordering with same seed produces same sample', async function () {
        const DB = mockFind(buildDocs([
          ['Chemical Bonding', 30],
          ['Chemical Energetics', 30],
          ['Isotopes', 30]
        ]))
        const sampling = {
          mode: 'proportions', total: 12,
          perSelection: [
            { kind: 'subtopic', name: 'Chemical Bonding', weight: 1 },
            { kind: 'subtopic', name: 'Chemical Energetics', weight: 2 },
            { kind: 'subtopic', name: 'Isotopes', weight: 1 }
          ]
        }
        const req1 = Object.assign({}, baseThree, { ordering: { mode: 'random', seed: 123 }, sampling })
        const r1 = (await queryQuestions(req1, DB)).rows
        const r2 = (await queryQuestions(req1, DB)).rows
        r1.map(r => r.qN).should.deepEqual(r2.map(r => r.qN))
      })

      it('falls back to cap when no perSelection has positive weight', async function () {
        const DB = mockFind(buildDocs([
          ['Chemical Bonding', 20]
        ]))
        const { rows } = await queryQuestions(Object.assign({}, baseThree, {
          selections: [{ kind: 'subtopic', name: 'Chemical Bonding' }],
          sampling: {
            mode: 'proportions', total: 5,
            perSelection: [
              { kind: 'subtopic', name: 'Chemical Bonding', weight: 0 }
            ]
          }
        }), DB)
        rows.length.should.equal(5)
      })
    })

    describe('resolveSelectionTagSets', function () {
      const syllabus = loadSyllabus('9701', 'AS')
      it('returns one tag set per selection keyed by kind:name', function () {
        const map = resolveSelectionTagSets([
          { kind: 'subtopic', name: 'Isotopes' },
          { kind: 'topic', name: syllabus.topics[0].topic_name }
        ], syllabus)
        map.size.should.equal(2)
        map.get('subtopic:Isotopes').has('Isotopes').should.be.true()
        map.get(`topic:${syllabus.topics[0].topic_name}`).size.should.be.above(1)
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
