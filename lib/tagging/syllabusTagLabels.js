'use strict'

const fs = require('fs')
const path = require('path')

/**
 * Build the set of strings the tagger may legally assign:
 * - Every subtopic `name` under each topic.
 * - A topic's `topic_name` only when that topic has no subtopics (coarse / legacy syllabi).
 */
function collectAllowedTaggingLabels (syllabusData) {
  const allowed = new Set()
  if (!Array.isArray(syllabusData)) return allowed
  for (const topic of syllabusData) {
    if (!topic || typeof topic !== 'object') continue
    const subs = topic.subtopics || []
    if (subs.length === 0 && typeof topic.topic_name === 'string' && topic.topic_name.length > 0) {
      allowed.add(topic.topic_name)
    }
    for (const s of subs) {
      if (s && typeof s.name === 'string' && s.name.length > 0) {
        allowed.add(s.name)
      }
    }
  }
  return allowed
}

/** Keep only labels present in allowedSet; trim whitespace; preserve first-seen order. */
function filterLabelsToSyllabus (labels, allowedSet) {
  if (!Array.isArray(labels) || !allowedSet || allowedSet.size === 0) return []
  const out = []
  const seen = new Set()
  for (const raw of labels) {
    if (typeof raw !== 'string') continue
    const t = raw.trim()
    if (!t || !allowedSet.has(t) || seen.has(t)) continue
    seen.add(t)
    out.push(t)
  }
  return out
}

/** When the syllabus yields no allowed labels, only trim/dedupe (should not happen in normal runs). */
function normalizeTagLabels (labels, allowedSet) {
  if (!Array.isArray(labels)) return []
  if (allowedSet && allowedSet.size > 0) return filterLabelsToSyllabus(labels, allowedSet)
  const out = []
  const seen = new Set()
  for (const raw of labels) {
    if (typeof raw !== 'string') continue
    const t = raw.trim()
    if (!t || seen.has(t)) continue
    seen.add(t)
    out.push(t)
  }
  return out
}

/** Union of labels from q.topics and q.subparts[].topics (trimmed strings, order preserved, deduped). */
function collectLabelsFromDirEntry (q) {
  const seen = new Set()
  const out = []
  function add (raw) {
    if (typeof raw !== 'string') return
    const t = raw.trim()
    if (!t || seen.has(t)) return
    seen.add(t)
    out.push(t)
  }
  if (!q || typeof q !== 'object') return out
  if (Array.isArray(q.topics)) {
    for (const x of q.topics) add(x)
  }
  if (Array.isArray(q.subparts)) {
    for (const sp of q.subparts) {
      if (!sp || !Array.isArray(sp.topics)) continue
      for (const x of sp.topics) add(x)
    }
  }
  return out
}

/**
 * Map syllabus labels (subtopic name or coarse topic_name) to parent topic titles for display.
 * Unknown strings pass through unchanged.
 */
function resolveLabelsToTopicTitles (syllabusData, labels) {
  if (!Array.isArray(syllabusData) || !Array.isArray(labels)) return []
  const subtopicToTopic = new Map()
  const subLowerToTopic = new Map()
  const topicNamesNoSubs = new Set()
  const topicNamesWithSubs = new Set()
  const noSubLowerToCanon = new Map()
  const withSubLowerToCanon = new Map()
  for (const topic of syllabusData) {
    if (!topic || typeof topic !== 'object') continue
    const tn = topic.topic_name
    if (typeof tn !== 'string' || !tn.length) continue
    const subs = topic.subtopics || []
    if (subs.length === 0) {
      topicNamesNoSubs.add(tn)
      noSubLowerToCanon.set(tn.toLowerCase(), tn)
    } else {
      topicNamesWithSubs.add(tn)
      withSubLowerToCanon.set(tn.toLowerCase(), tn)
      for (const s of subs) {
        if (s && typeof s.name === 'string' && s.name.length > 0) {
          subtopicToTopic.set(s.name, tn)
          subLowerToTopic.set(s.name.toLowerCase(), tn)
        }
      }
    }
  }
  const out = new Set()
  for (const raw of labels) {
    if (typeof raw !== 'string') continue
    const label = raw.trim()
    if (!label) continue
    const fromSub = subtopicToTopic.get(label) || subLowerToTopic.get(label.toLowerCase())
    if (fromSub) {
      out.add(fromSub)
      continue
    }
    if (topicNamesNoSubs.has(label)) {
      out.add(label)
      continue
    }
    if (noSubLowerToCanon.has(label.toLowerCase())) {
      out.add(noSubLowerToCanon.get(label.toLowerCase()))
      continue
    }
    if (topicNamesWithSubs.has(label)) {
      out.add(label)
      continue
    }
    if (withSubLowerToCanon.has(label.toLowerCase())) {
      out.add(withSubLowerToCanon.get(label.toLowerCase()))
      continue
    }
    out.add(label)
  }
  return [...out].sort()
}

let taggingConfigCache = null
function getTaggingConfig () {
  if (taggingConfigCache !== null) return taggingConfigCache
  try {
    const configPath = path.join(__dirname, 'config.json')
    if (fs.existsSync(configPath)) {
      taggingConfigCache = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    } else {
      taggingConfigCache = {}
    }
  } catch (e) {
    taggingConfigCache = {}
  }
  return taggingConfigCache
}

/** AS/A2 per paper — mirrors doLinkTopics.bin.js */
function levelForSubjectPaper (subject, paper) {
  let level = 'AS'
  const subj = subject != null ? String(subject).trim() : ''
  const subjectConfig = subj ? getTaggingConfig()[subj] : null
  if (subjectConfig) {
    if (subjectConfig.A2 && subjectConfig.A2.includes(paper)) level = 'A2'
    else if (subjectConfig.AS && subjectConfig.AS.includes(paper)) level = 'AS'
  } else if (subj.startsWith('9') && paper >= 4) {
    level = 'A2'
  }
  return level
}

/**
 * @returns {{ level: string, syllabusData: object[] } | null}
 */
function loadSyllabusForSubjectPaper (subject, paper) {
  const subj = subject != null ? String(subject).trim() : ''
  if (!subj) return null
  const p = Number.isFinite(paper) ? paper : parseInt(paper, 10)
  if (!Number.isFinite(p)) return null
  const level = levelForSubjectPaper(subj, p)
  const filePath = path.join(__dirname, subj, `${level}.json`)
  try {
    if (!fs.existsSync(filePath)) return null
    const syllabusData = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    if (!Array.isArray(syllabusData)) return null
    return { level, syllabusData }
  } catch (e) {
    return null
  }
}

module.exports = {
  collectAllowedTaggingLabels,
  filterLabelsToSyllabus,
  normalizeTagLabels,
  collectLabelsFromDirEntry,
  resolveLabelsToTopicTitles,
  loadSyllabusForSubjectPaper,
  levelForSubjectPaper
}
