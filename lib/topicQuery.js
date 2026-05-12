'use strict'

const fs = require('fs')
const path = require('path')
const PaperUtils = require('../view/paperutils')

const TAGGING_DIR = path.join(__dirname, 'tagging')

function loadSyllabus (subject, level) {
  const filePath = path.join(TAGGING_DIR, subject, `${level}.json`)
  try {
    const raw = fs.readFileSync(filePath, 'utf8')
    const topics = JSON.parse(raw)
    return { topics }
  } catch (e) {
    return null
  }
}

// Returns Set<string> of subtopic name strings to match against doc topics arrays.
function resolveSelectedTags (req, syllabus) {
  const { selections } = req
  const tagSet = new Set()
  if (!Array.isArray(selections) || !syllabus) return tagSet

  for (const sel of selections) {
    if (sel.kind === 'subtopic') {
      tagSet.add(sel.name)
    } else if (sel.kind === 'topic') {
      const topic = syllabus.topics.find(t => t.topic_name === sel.name)
      if (topic) {
        for (const sub of (topic.subtopics || [])) {
          tagSet.add(sub.name)
        }
      }
    }
  }
  return tagSet
}

// Mulberry32 PRNG — deterministic, fast, good distribution
function mulberry32 (seed) {
  let s = seed >>> 0
  return function () {
    s = (s + 0x6D2B79F5) >>> 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function fisherYates (arr, rng) {
  const a = arr.slice()
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

function sortDeterministic (rows) {
  return rows.slice().sort((a, b) => {
    const cmp = PaperUtils.funcSortSet(
      { subject: a.subject, time: a.time, paper: a.paper, variant: a.variant },
      { subject: b.subject, time: b.time, paper: b.paper, variant: b.variant }
    )
    if (cmp !== 0) return cmp
    return (parseInt(a.qN) || 0) - (parseInt(b.qN) || 0)
  })
}

// Main query. Returns {rows: QuestionRow[], meta}.
async function queryQuestions (req, PastPaperDoc) {
  const {
    subject, level, selections,
    years, seasons, papers, variants, includeMcq,
    ordering, sampling
  } = req

  const syllabus = loadSyllabus(subject, level)
  const selectedTags = resolveSelectedTags(req, syllabus)

  if (selectedTags.size === 0) {
    return { rows: [], meta: { total: 0, matched: 0, perTopicCounts: {} } }
  }

  const typeFilter = ['qp']
  if (includeMcq !== false) typeFilter.push('mcqMs')

  const selector = { subject, type: { $in: typeFilter } }
  if (papers && papers.length > 0) selector.paper = { $in: papers }
  if (variants && variants.length > 0) selector.variant = { $in: variants }

  const docs = await PastPaperDoc.find(selector, { fileBlob: 0 })

  const rows = []
  for (const doc of docs) {
    // Year filter (time = e.g. 's23')
    if (years && (years.from || years.to)) {
      const m = doc.time.match(/\d+/)
      if (m) {
        const yr = parseInt(m[0])
        const fullYr = yr < 100 ? 2000 + yr : yr
        if (years.from && fullYr < years.from) continue
        if (years.to && fullYr > years.to) continue
      }
    }

    // Season filter
    if (seasons && seasons.length > 0) {
      if (!seasons.includes(PaperUtils.getSeason(doc.time))) continue
    }

    let dir
    try {
      dir = await doc.ensureDir()
    } catch (e) {
      continue
    }
    if (!dir || !Array.isArray(dir.dirs)) continue

    for (const d of dir.dirs) {
      if (!d.qN) continue

      const qTopics = Array.isArray(d.topics) ? d.topics : []
      const matchedTopics = qTopics.filter(t => selectedTags.has(t))

      const matchedSubparts = []
      if (Array.isArray(d.subparts)) {
        for (const sp of d.subparts) {
          const spTopics = Array.isArray(sp.topics) ? sp.topics : []
          if (spTopics.some(t => selectedTags.has(t))) {
            matchedSubparts.push(sp.part || '')
            spTopics
              .filter(t => selectedTags.has(t) && !matchedTopics.includes(t))
              .forEach(t => matchedTopics.push(t))
          }
        }
      }

      if (matchedTopics.length === 0) continue

      rows.push({
        docId: doc._id.toString(),
        subject: doc.subject,
        time: doc.time,
        paper: doc.paper,
        variant: doc.variant,
        type: doc.type,
        qN: d.qN,
        page: d.page,
        qNRect: d.qNRect || null,
        topics: qTopics,
        subparts: d.subparts || [],
        matchedSubparts,
        matchedTopics
      })
    }
  }

  // Ordering
  const seed = (ordering && ordering.seed != null) ? ordering.seed : Date.now()
  let ordered
  if (!ordering || ordering.mode !== 'random') {
    ordered = sortDeterministic(rows)
  } else {
    ordered = fisherYates(rows, mulberry32(seed))
  }

  // Per-topic counts (before sampling)
  const perTopicCounts = {}
  for (const row of ordered) {
    for (const t of row.matchedTopics) {
      perTopicCounts[t] = (perTopicCounts[t] || 0) + 1
    }
  }

  // Sampling
  let sampled
  const mode = sampling ? sampling.mode : 'all'
  if (mode === 'cap' && sampling.total) {
    sampled = ordered.slice(0, sampling.total)
  } else if (mode === 'proportions' && sampling.total && Array.isArray(sampling.perTopic)) {
    const topicNames = sampling.perTopic.map(pt => pt.topic)

    // Bucket rows by primary matched topic
    const buckets = {}
    for (const row of ordered) {
      const primary = row.matchedTopics.find(t => topicNames.includes(t)) || row.matchedTopics[0]
      if (!buckets[primary]) buckets[primary] = []
      buckets[primary].push(row)
    }

    // Compute per-bucket quota; rounding goes to highest-pct topic
    const counts = sampling.perTopic.map(pt => ({
      topic: pt.topic,
      pct: pt.pct,
      count: Math.round(sampling.total * pt.pct / 100)
    }))
    const countSum = counts.reduce((s, c) => s + c.count, 0)
    if (countSum < sampling.total) {
      const maxIdx = counts.reduce((mi, c, i, a) => c.pct > a[mi].pct ? i : mi, 0)
      counts[maxIdx].count += sampling.total - countSum
    }

    sampled = []
    for (const c of counts) {
      sampled.push(...(buckets[c.topic] || []).slice(0, c.count))
    }

    // Re-apply global ordering
    sampled = ordering && ordering.mode === 'random'
      ? fisherYates(sampled, mulberry32(seed))
      : sortDeterministic(sampled)
  } else {
    sampled = ordered
  }

  const meta = {
    total: sampled.length,
    matched: rows.length,
    perTopicCounts
  }
  if (ordering && ordering.mode === 'random') meta.seed = seed
  if (sampling && sampling.total && rows.length < sampling.total) {
    meta.warning = `requested ${sampling.total}, only ${rows.length} matched`
  }

  return { rows: sampled, meta }
}

module.exports = { loadSyllabus, resolveSelectedTags, queryQuestions }
