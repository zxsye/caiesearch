import * as React from 'react'
import { AppState } from './appstate.js'
import HomeButton from './homebutton.jsx'
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
      samplingWeights: {},

      showAdvanced: false,

      // Results
      rows: null,
      meta: null,
      resultsLoading: false,
      resultsError: null,

      // Export
      exporting: null, // null | 'qp' | 'ms'
      exportError: null,
      exportWarnings: null,
      lastExportNote: null
    }

    this.handleApply = this.handleApply.bind(this)
    this.handleOpenRow = this.handleOpenRow.bind(this)
    this.handleExportQp = this.handleExport.bind(this, 'qp')
    this.handleExportMs = this.handleExport.bind(this, 'ms')
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

  buildQueryBody () {
    const {
      subject, level, selections,
      yearFrom, yearTo, seasons, papers, variants,
      orderingMode, randomSeed, samplingMode, samplingTotal, samplingWeights
    } = this.state

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
      if (samplingMode === 'proportions') {
        body.sampling.perSelection = selections
          .map(s => ({
            kind: s.kind,
            name: s.name,
            weight: Number(samplingWeights[`${s.kind}:${s.name}`] ?? 1)
          }))
          .filter(p => Number.isFinite(p.weight) && p.weight > 0)
      }
    }

    return body
  }

  handleApply () {
    if (this.state.selections.length === 0) {
      this.setState({ resultsError: 'Select at least one topic or subtopic.' })
      return
    }

    const body = this.buildQueryBody()
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

  handleExport (kind) {
    if (this.state.exporting) return
    if (this.state.selections.length === 0) {
      this.setState({ exportError: 'Select at least one topic or subtopic.' })
      return
    }

    const body = this.buildQueryBody()
    this.setState({ exporting: kind, exportError: null, exportWarnings: null, lastExportNote: null })

    fetch(`/topics/export/${kind}.pdf`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
      .then(r => {
        if (!r.ok) {
          return r.json().then(
            j => { throw new Error(j.error || `HTTP ${r.status}`) },
            () => { throw new Error(`HTTP ${r.status}`) }
          )
        }
        const cd = r.headers.get('Content-Disposition') || ''
        const m = cd.match(/filename="([^"]+)"/)
        const filename = m ? m[1] : `topics_${kind}.pdf`
        let warnings = null
        const wh = r.headers.get('X-Export-Warnings')
        if (wh) {
          try { warnings = JSON.parse(decodeURIComponent(wh)) } catch (e) {}
        }
        const qCount = parseInt(r.headers.get('X-Export-Question-Count') || '0', 10) || null
        return r.blob().then(blob => ({ blob, filename, warnings, qCount }))
      })
      .then(({ blob, filename, warnings, qCount }) => {
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = filename
        document.body.appendChild(a)
        a.click()
        a.remove()
        setTimeout(() => URL.revokeObjectURL(url), 1000)
        const note = qCount
          ? `${qCount} matched question${qCount === 1 ? '' : 's'} highlighted in the PDF.`
          : 'Matched questions are highlighted on each page.'
        this.setState({ exporting: null, exportWarnings: warnings, lastExportNote: warnings ? null : note })
      })
      .catch(err => {
        this.setState({ exporting: null, exportError: err.message || String(err) })
      })
  }

  handleOpenRow (row) {
    AppState.dispatch({
      type: 'v2view',
      fileId: row.docId,
      tCurrentType: row.type,
      viewDir: row.page != null ? { page: row.page } : null,
      showPaperSetTitle: true,
      asPopup: true
    })
  }

  renderExportBar () {
    const { exporting, exportError, exportWarnings, lastExportNote, selections } = this.state
    const disabled = exporting !== null || selections.length === 0
    const qpLabel = exporting === 'qp' ? 'Exporting…' : 'Export QP PDF'
    const msLabel = exporting === 'ms' ? 'Exporting…' : 'Export MS PDF'
    return (
      <div className='tb-export-wrap'>
        <div className='tb-export-bar'>
          <button
            className={'tb-export-btn' + (disabled ? '' : ' enabled')}
            disabled={disabled}
            onClick={this.handleExportQp}
            title={selections.length === 0 ? 'Select at least one topic first' : 'Download a PDF containing the question pages for the current selection'}
          >
            {qpLabel}
          </button>
          <button
            className={'tb-export-btn' + (disabled ? '' : ' enabled')}
            disabled={disabled}
            onClick={this.handleExportMs}
            title={selections.length === 0 ? 'Select at least one topic first' : 'Download a PDF containing the matching markscheme pages'}
          >
            {msLabel}
          </button>
        </div>
        {exportError && <div className='tb-export-error'>{exportError}</div>}
        {exportWarnings && exportWarnings.length > 0 && (
          <div className='tb-export-warnings'>
            <div className='tb-export-warnings-title'>Some questions were skipped:</div>
            <ul>
              {exportWarnings.slice(0, 5).map((w, i) => <li key={i}>{w}</li>)}
              {exportWarnings.length > 5 && <li>…and {exportWarnings.length - 5} more</li>}
            </ul>
          </div>
        )}
        {lastExportNote && <div className='tb-export-note'>{lastExportNote}</div>}
      </div>
    )
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
      selections, samplingWeights,
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
          {samplingMode === 'proportions' && selections.length > 0 && (() => {
            const total = parseInt(samplingTotal) || 0
            const weights = selections.map(s =>
              Number(samplingWeights[`${s.kind}:${s.name}`] ?? 1))
            const sumW = weights.reduce((a, b) => a + (b > 0 ? b : 0), 0)
            return (
              <div className='tb-ratio-editor'>
                {selections.map((sel, i) => {
                  const key = `${sel.kind}:${sel.name}`
                  const w = weights[i]
                  const approx = sumW > 0 && w > 0 ? Math.round(total * w / sumW) : 0
                  return (
                    <div className='tb-ratio-row' key={key}>
                      <span className='tb-ratio-kind'>{sel.kind === 'topic' ? 'T' : 'S'}</span>
                      <span className='tb-ratio-label' title={sel.name}>{sel.name}</span>
                      <input
                        className='tb-ratio-input'
                        type='number' min='0' step='1'
                        value={samplingWeights[key] ?? 1}
                        onChange={e => {
                          const v = e.target.value
                          this.setState(prev => ({
                            samplingWeights: { ...prev.samplingWeights, [key]: v }
                          }))
                        }}
                      />
                      <span className='tb-ratio-approx'>&#8776; {approx}</span>
                    </div>
                  )
                })}
                <div className='tb-ratio-summary'>
                  Ratio sum: {sumW || 0} &rarr; {total} question{total !== 1 ? 's' : ''} total
                </div>
              </div>
            )
          })()}
        </div>

        <button className='tb-apply-btn' onClick={this.handleApply}>
          Apply
        </button>

        {this.renderExportBar()}
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
          <HomeButton />
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
