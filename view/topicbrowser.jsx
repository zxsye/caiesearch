import * as React from 'react'
import { AppState } from './appstate.js'
import SyllabusTree from './syllabustree.jsx'
const PaperUtils = require('./paperutils.js')
import * as FetchErrorPromise from './fetcherrorpromise.jsx'
const CIESubjects = require('./CIESubjects.js')

const KNOWN_SUBJECTS = ['9700', '9701', '9702', '9709']
const LEVELS = ['AS', 'A2']

function DefaultRow ({ row, onOpen }) {
  const timeLabel = PaperUtils.myTimeToHumanTime(row.time)
  const paperLabel = `${row.subject}/${row.time}/1${row.variant} p${row.paper}v${row.variant}`
  return (
    <div className='tb-result-row' onClick={() => onOpen(row)}>
      <div className='tb-result-qn'>Q{row.qN}</div>
      <div className='tb-result-meta'>
        <span className='tb-result-paper'>{paperLabel}</span>
        <span className='tb-result-time'>{timeLabel}</span>
      </div>
      <div className='tb-result-topics'>
        {row.matchedTopics.map((t, i) => (
          <span className='topic-badge' key={i}>{t}</span>
        ))}
        {row.matchedSubparts.length > 0 && (
          <span className='topic-badge subpart-badge'>
            matches ({row.matchedSubparts.join(', ')})
          </span>
        )}
      </div>
    </div>
  )
}

function ResultList ({ rows, loading, error, onOpen }) {
  if (loading) return <div className='tb-status'>Loading&hellip;</div>
  if (error) return <div className='tb-status tb-error'>{error}</div>
  if (!rows) return <div className='tb-status tb-hint'>Select topics and click Apply to see questions.</div>
  if (rows.length === 0) return <div className='tb-status'>No matching questions found.</div>
  return (
    <div className='tb-result-list'>
      {rows.map((row, i) => (
        <DefaultRow key={`${row.docId}_${row.qN}_${i}`} row={row} onOpen={onOpen} />
      ))}
    </div>
  )
}

export default class TopicBrowser extends React.Component {
  constructor (props) {
    super(props)
    this.state = {
      subject: '9701',
      level: 'AS',
      syllabus: null,
      syllabusLoading: false,
      syllabusError: null,

      selections: [],

      // Filters
      yearFrom: '',
      yearTo: '',
      seasons: ['m', 's', 'w'],
      papers: [],
      variants: [],
      orderingMode: 'deterministic',
      randomSeed: '',
      samplingMode: 'all',
      samplingTotal: '20',
      samplingPerTopic: [],

      showAdvanced: false,

      // Results
      rows: null,
      meta: null,
      resultsLoading: false,
      resultsError: null
    }

    this.handleApply = this.handleApply.bind(this)
    this.handleOpenRow = this.handleOpenRow.bind(this)
  }

  componentDidMount () {
    this.loadSyllabus(this.state.subject, this.state.level)
  }

  loadSyllabus (subject, level) {
    this.setState({ syllabusLoading: true, syllabusError: null, syllabus: null, selections: [] })
    fetch(`/topics/syllabus/?subject=${encodeURIComponent(subject)}&level=${encodeURIComponent(level)}`)
      .then(FetchErrorPromise.then, FetchErrorPromise.error)
      .then(r => r.json())
      .then(data => {
        this.setState({ syllabus: data, syllabusLoading: false })
      })
      .catch(err => {
        this.setState({ syllabusError: err.message || String(err), syllabusLoading: false })
      })
  }

  handleSubjectChange (subject) {
    this.setState({ subject, rows: null, meta: null }, () => {
      this.loadSyllabus(subject, this.state.level)
    })
  }

  handleLevelChange (level) {
    this.setState({ level, rows: null, meta: null }, () => {
      this.loadSyllabus(this.state.subject, level)
    })
  }

  toggleSeason (season) {
    this.setState(prev => {
      const seasons = prev.seasons.includes(season)
        ? prev.seasons.filter(s => s !== season)
        : [...prev.seasons, season]
      return { seasons }
    })
  }

  togglePaper (p) {
    this.setState(prev => {
      const papers = prev.papers.includes(p)
        ? prev.papers.filter(x => x !== p)
        : [...prev.papers, p]
      return { papers }
    })
  }

  handleApply () {
    const {
      subject, level, selections,
      yearFrom, yearTo, seasons, papers, variants,
      orderingMode, randomSeed, samplingMode, samplingTotal, samplingPerTopic
    } = this.state

    if (selections.length === 0) {
      this.setState({ resultsError: 'Select at least one topic or subtopic.' })
      return
    }

    const body = {
      subject,
      level,
      selections,
      ordering: { mode: orderingMode }
    }

    if (orderingMode === 'random' && randomSeed.trim()) {
      body.ordering.seed = parseInt(randomSeed) || undefined
    }

    const yFrom = parseInt(yearFrom)
    const yTo = parseInt(yearTo)
    if (!isNaN(yFrom) || !isNaN(yTo)) {
      body.years = {}
      if (!isNaN(yFrom)) body.years.from = yFrom
      if (!isNaN(yTo)) body.years.to = yTo
    }

    if (seasons.length < 3) body.seasons = seasons
    if (papers.length > 0) body.papers = papers
    if (variants.length > 0) body.variants = variants

    if (samplingMode !== 'all') {
      body.sampling = { mode: samplingMode, total: parseInt(samplingTotal) || 20 }
      if (samplingMode === 'proportions' && samplingPerTopic.length > 0) {
        body.sampling.perTopic = samplingPerTopic
      }
    }

    this.setState({ resultsLoading: true, resultsError: null, rows: null, meta: null })

    fetch('/topics/questions/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
      .then(FetchErrorPromise.then, FetchErrorPromise.error)
      .then(r => r.json())
      .then(data => {
        if (data.error) throw new Error(data.error)
        this.setState({
          rows: data.rows,
          meta: data.meta,
          resultsLoading: false,
          randomSeed: data.meta && data.meta.seed != null ? String(data.meta.seed) : this.state.randomSeed
        })
      })
      .catch(err => {
        this.setState({ resultsError: err.message || String(err), resultsLoading: false })
      })
  }

  handleOpenRow (row) {
    AppState.dispatch({
      type: 'v2view',
      fileId: row.docId,
      viewDir: { highlightDirIndex: null },
      showPaperSetTitle: true
    })
  }

  renderSubjectPanel () {
    const { subject, level, syllabus, syllabusLoading, syllabusError, selections } = this.state
    const subjectName = CIESubjects.findExactById(subject)

    return (
      <div className='tb-panel tb-panel-left'>
        <div className='tb-section-title'>Subject &amp; Level</div>
        <div className='tb-subject-row'>
          <select
            className='tb-select'
            value={subject}
            onChange={e => this.handleSubjectChange(e.target.value)}
          >
            {KNOWN_SUBJECTS.map(id => {
              const info = CIESubjects.findExactById(id)
              return (
                <option key={id} value={id}>
                  {id}{info ? ` – ${info.name}` : ''}
                </option>
              )
            })}
          </select>
          <div className='tb-level-tabs'>
            {LEVELS.map(l => (
              <button
                key={l}
                className={'tb-level-tab' + (level === l ? ' active' : '')}
                onClick={() => this.handleLevelChange(l)}
              >
                {l}
              </button>
            ))}
          </div>
        </div>

        <div className='tb-section-title' style={{ marginTop: '1rem' }}>
          Topics
          {selections.length > 0 && (
            <span className='tb-selection-count'> ({selections.length} selected)</span>
          )}
        </div>

        {syllabusLoading && <div className='tb-status'>Loading syllabus&hellip;</div>}
        {syllabusError && <div className='tb-status tb-error'>Could not load syllabus: {syllabusError}</div>}
        {!syllabusLoading && !syllabusError && syllabus && (
          <SyllabusTree
            syllabus={syllabus}
            selections={selections}
            onChange={sel => this.setState({ selections: sel })}
          />
        )}

        {selections.length > 0 && (
          <button
            className='tb-clear-btn'
            onClick={() => this.setState({ selections: [] })}
          >
            Clear selection
          </button>
        )}
      </div>
    )
  }

  renderFiltersPanel () {
    const {
      yearFrom, yearTo, seasons, papers,
      orderingMode, randomSeed, samplingMode, samplingTotal,
      showAdvanced
    } = this.state

    const allSeasons = [
      { key: 'm', label: 'Feb/Mar' },
      { key: 's', label: 'May/Jun' },
      { key: 'w', label: 'Oct/Nov' }
    ]
    const allPapers = [1, 2, 3, 4]

    return (
      <div className='tb-panel tb-panel-right'>
        <div className='tb-section-title'>Filters</div>

        <div className='tb-filter-group'>
          <label className='tb-label'>Year range</label>
          <div className='tb-year-row'>
            <input
              className='tb-input tb-year-input'
              type='number'
              placeholder='From'
              value={yearFrom}
              onChange={e => this.setState({ yearFrom: e.target.value })}
            />
            <span className='tb-year-sep'>–</span>
            <input
              className='tb-input tb-year-input'
              type='number'
              placeholder='To'
              value={yearTo}
              onChange={e => this.setState({ yearTo: e.target.value })}
            />
          </div>
        </div>

        <div className='tb-filter-group'>
          <label className='tb-label'>Season</label>
          <div className='tb-checkbox-row'>
            {allSeasons.map(({ key, label }) => (
              <label key={key} className='tb-checkbox-label'>
                <input
                  type='checkbox'
                  checked={seasons.includes(key)}
                  onChange={() => this.toggleSeason(key)}
                />
                {' '}{label}
              </label>
            ))}
          </div>
        </div>

        <div className='tb-filter-group'>
          <label className='tb-label'>Paper</label>
          <div className='tb-checkbox-row'>
            {allPapers.map(p => (
              <label key={p} className='tb-checkbox-label'>
                <input
                  type='checkbox'
                  checked={papers.includes(p)}
                  onChange={() => this.togglePaper(p)}
                />
                {' '}P{p}
              </label>
            ))}
          </div>
        </div>

        <div className='tb-filter-group'>
          <label className='tb-label'>Order</label>
          <div className='tb-radio-row'>
            {['deterministic', 'random'].map(mode => (
              <label key={mode} className='tb-radio-label'>
                <input
                  type='radio'
                  name='orderingMode'
                  value={mode}
                  checked={orderingMode === mode}
                  onChange={() => this.setState({ orderingMode: mode })}
                />
                {' '}{mode === 'deterministic' ? 'Chronological' : 'Random'}
              </label>
            ))}
          </div>
          {orderingMode === 'random' && (
            <input
              className='tb-input'
              type='number'
              placeholder='Seed (optional)'
              value={randomSeed}
              onChange={e => this.setState({ randomSeed: e.target.value })}
              style={{ marginTop: '4px' }}
            />
          )}
        </div>

        <div className='tb-filter-group'>
          <label className='tb-label'>Sampling</label>
          <div className='tb-radio-row'>
            {['all', 'cap', 'proportions'].map(mode => (
              <label key={mode} className='tb-radio-label'>
                <input
                  type='radio'
                  name='samplingMode'
                  value={mode}
                  checked={samplingMode === mode}
                  onChange={() => this.setState({ samplingMode: mode })}
                />
                {' '}{mode === 'all' ? 'All' : mode === 'cap' ? 'Cap' : 'Proportions'}
              </label>
            ))}
          </div>
          {samplingMode !== 'all' && (
            <input
              className='tb-input'
              type='number'
              placeholder='Max questions'
              value={samplingTotal}
              onChange={e => this.setState({ samplingTotal: e.target.value })}
              style={{ marginTop: '4px' }}
            />
          )}
        </div>

        <button className='tb-apply-btn' onClick={this.handleApply}>
          Apply
        </button>

        <div className='tb-export-bar'>
          <button
            className='tb-export-btn'
            disabled
            title='PDF export coming soon'
          >
            Export QP PDF
          </button>
          <button
            className='tb-export-btn'
            disabled
            title='PDF export coming soon'
          >
            Export MS PDF
          </button>
        </div>
      </div>
    )
  }

  renderResultsPanel () {
    const { rows, meta, resultsLoading, resultsError } = this.state
    return (
      <div className='tb-panel tb-panel-center'>
        <div className='tb-results-header'>
          <div className='tb-section-title'>
            Results
            {meta && (
              <span className='tb-result-count'>
                {' '}— {meta.total} question{meta.total !== 1 ? 's' : ''}
                {meta.matched !== meta.total ? ` (${meta.matched} matched)` : ''}
              </span>
            )}
          </div>
          {meta && meta.warning && (
            <div className='tb-warning'>{meta.warning}</div>
          )}
          {meta && meta.seed != null && (
            <div className='tb-seed'>Seed: {meta.seed}</div>
          )}
        </div>
        <ResultList
          rows={rows}
          loading={resultsLoading}
          error={resultsError}
          onOpen={this.handleOpenRow}
        />
      </div>
    )
  }

  render () {
    return (
      <div className='topic-browser'>
        <div className='tb-header'>
          <h2 className='tb-title'>Browse by Topic</h2>
        </div>
        <div className='tb-body'>
          {this.renderSubjectPanel()}
          {this.renderFiltersPanel()}
          {this.renderResultsPanel()}
        </div>
      </div>
    )
  }
}
