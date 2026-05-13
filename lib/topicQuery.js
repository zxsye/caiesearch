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

// Returns Set<string> of tag strings for a single selection — used both by
// the union-style resolver (filtering) and by the per-selection bucketing
// used in proportions sampling.
function tagSetForSelection (sel, syllabus) {
  const tags = new Set()
  if (!sel || !syllabus) return tags
  if (sel.kind === 'subtopic') {
    tags.add(sel.name)
    // Also match the parent topic name, since the tagger may have stored
    // either the topic-level or subtopic-level name on a question.
    const parent = syllabus.topics.find(t =>
      (t.subtopics || []).some(s => s.name === sel.name)
    )
    if (parent) tags.add(parent.topic_name)
  } else if (sel.kind === 'topic') {
    const topic = syllabus.topics.find(t => t.topic_name === sel.name)
    if (topic) {
      tags.add(topic.topic_name)
      for (const sub of (topic.subtopics || [])) {
        tags.add(sub.name)
      }
    }
  }
  return tags
}

function selectionKey (sel) {
  return `${sel.kind}:${sel.name}`
}

// Returns Map<selectionKey, Set<string>> for proportions bucketing.
function resolveSelectionTagSets (selections, syllabus) {
  const map = new Map()
  if (!Array.isArray(selections) || !syllabus) return map
  for (const sel of selections) {
    map.set(selectionKey(sel), tagSetForSelection(sel, syllabus))
  }
  return map
}

// Returns Set<string> of tag strings to match against doc topics arrays.
function resolveSelectedTags (req, syllabus) {
  const { selections } = req
  const tagSet = new Set()
  if (!Array.isArray(selections) || !syllabus) return tagSet
  for (const sel of selections) {
    for (const t of tagSetForSelection(sel, syllabus)) tagSet.add(t)
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

    // Read cached dir directly. We can't call ensureDir() here because the
    // query projects fileBlob out (ensureDir requires it to be a buffer or
    // explicit null, not undefined). Untagged docs have nothing to match
    // anyway, so skipping those without a cached dir is correct.
    const dir = doc.dir
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
  const meta = {
    total: 0,
    matched: rows.length,
    perTopicCounts
  }

  if (mode === 'cap' && sampling.total) {
    sampled = ordered.slice(0, sampling.total)
  } else if (mode === 'proportions' && sampling.total && Array.isArray(sampling.perSelection)) {
    const perSel = sampling.perSelection.filter(p => Number(p.weight) > 0)
    const sumW = perSel.reduce((s, p) => s + Number(p.weight), 0)
    if (perSel.length === 0 || sumW <= 0) {
      sampled = ordered.slice(0, sampling.total)
    } else {
      const tagSetsByKey = resolveSelectionTagSets(perSel, syllabus)

      // Use a shuffled pool for picking so deterministic global ordering still
      // yields a random pick within each bucket. When the user already chose
      // random ordering, reuse `ordered` (already shuffled with `seed`).
      const pickPool = ordering && ordering.mode === 'random'
        ? ordered
        : fisherYates(ordered, mulberry32(seed))

      const buckets = new Map(perSel.map(p => [selectionKey(p), []]))
      for (const row of pickPool) {
        for (const p of perSel) {
          const tags = tagSetsByKey.get(selectionKey(p))
          if (tags && row.matchedTopics.some(t => tags.has(t))) {
            buckets.get(selectionKey(p)).push(row)
            break
          }
        }
      }

      const quotas = perSel.map(p => ({
        key: selectionKey(p),
        weight: Number(p.weight),
        quota: Math.round(sampling.total * Number(p.weight) / sumW)
      }))
      const qSum = quotas.reduce((s, q) => s + q.quota, 0)
      if (qSum < sampling.total) {
        const maxIdx = quotas.reduce((mi, q, i, a) => q.weight > a[mi].weight ? i : mi, 0)
        quotas[maxIdx].quota += sampling.total - qSum
      }

      const perSelectionCounts = {}
      const underfilled = []
      sampled = []
      for (const q of quotas) {
        const bucket = buckets.get(q.key) || []
        const picked = bucket.slice(0, q.quota)
        sampled.push(...picked)
        perSelectionCounts[q.key] = { picked: picked.length, available: bucket.length, quota: q.quota }
        if (picked.length < q.quota) underfilled.push(`${q.key} (${picked.length}/${q.quota})`)
      }

      // Re-apply user's chosen ordering to the picked subset
      sampled = ordering && ordering.mode === 'random'
        ? fisherYates(sampled, mulberry32(seed))
        : sortDeterministic(sampled)

      meta.perSelectionCounts = perSelectionCounts
      if (underfilled.length) {
        meta.warning = `underfilled: ${underfilled.join(', ')}`
      }
    }
  } else {
    sampled = ordered
  }

  meta.total = sampled.length
  if (ordering && ordering.mode === 'random') meta.seed = seed
  if (sampling && sampling.total && rows.length < sampling.total && !meta.warning) {
    meta.warning = `requested ${sampling.total}, only ${rows.length} matched`
  }

  return { rows: sampled, meta }
}

module.exports = { loadSyllabus, resolveSelectedTags, resolveSelectionTagSets, queryQuestions }
