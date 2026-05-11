import * as React from 'react'
import { AppState } from './appstate.js'
import SubjectData from './CIESubjects.data.js'
import * as FetchErrorPromise from './fetcherrorpromise.jsx'

export default class SubjectsView extends React.Component {
  constructor (props) {
    super(props)
    this.state = {
      activeTab: 'A/s',
      searchQuery: ''
    }
    this.handleHome = this.handleHome.bind(this)
    this.handleSearch = this.handleSearch.bind(this)
  }
  componentDidMount () {
    if (!this.props.statistics) {
      this.startLoad()
    }
  }
  startLoad () {
    AppState.dispatch({type: 'subjects-stst-perpare'})
    fetch('/subjects/?as=json').then(FetchErrorPromise.then, FetchErrorPromise.error).then(res => res.json()).then(agg => {
      AppState.dispatch({type: 'subjects-stst-load', data: agg})
    }, err => {
      AppState.dispatch({type: 'subjects-stst-error', error: err})
    })
  }
  handleSearch (evt) {
    this.setState({ searchQuery: evt.target.value.toLowerCase() })
  }
  render () {
    let agg = null
    let err = null
    if (this.props.statistics && this.props.statistics.result) {
      agg = this.props.statistics.result
    } else if (this.props.statistics && this.props.statistics.error) {
      err = this.props.statistics.error
    }
    
    const filteredSubjects = SubjectData.filter(subj => {
      let matchesTab = false
      if (this.state.activeTab === 'IGCSE') {
        matchesTab = subj.level === 'IGCSE'
      } else if (this.state.activeTab === 'A/s') {
        matchesTab = subj.level === 'A/s'
      } else {
        matchesTab = subj.level !== 'A/s' && subj.level !== 'IGCSE'
      }
      
      let matchesSearch = true
      if (this.state.searchQuery) {
        matchesSearch = subj.id.toLowerCase().includes(this.state.searchQuery) ||
                        subj.name.toLowerCase().includes(this.state.searchQuery)
      }
      
      return matchesTab && matchesSearch
    })

    let subjFunc = subj => {
      let aggItem = agg ? agg.find(g => g._id === subj.id) : null
      return (
        <div className='subject-card' key={subj.id}>
          <a
            href={`/search/?as=page&query=${subj.id}`}
            onClick={this.handleQuery.bind(this, subj.id)}
            className='card-header'
          >
            <div className='card-title'>
              <span className='code-badge'>{subj.id}</span>
              <span className='name'>{subj.name}</span>
            </div>
            {aggItem ? (
              <span className='count-badge'>
                {aggItem.totalPaper} papers
              </span>
            ) : null}
          </a>
          
          {aggItem && aggItem.times && aggItem.times.length > 0 ? (
            <div className='card-seasons'>
              <span className='seasons-label'>Sessions available:</span>
              <div className='seasons-list'>
                {aggItem.times.map(t => {
                  let seasonClass = 'season-pill '
                  if (t.startsWith('s')) seasonClass += 'summer'
                  else if (t.startsWith('w')) seasonClass += 'winter'
                  else if (t.startsWith('m')) seasonClass += 'march'
                  
                  return (
                    <a key={t} href={`/search/?as=page&query=${encodeURIComponent(`${subj.id} ${t}`)}`}
                      onClick={this.handleQuery.bind(this, `${subj.id} ${t}`)} className={seasonClass}>{t}</a>
                  )
                })}
              </div>
            </div>
          ) : null}
        </div>
      )
    }
    return (
      <div className='subjects-redesign'>
        <div className='header-section'>
          <h1 className='page-title'>Browse Subjects</h1>
          <p className='page-subtitle'>
            {SubjectData.length} subjects supported.
            {!AppState.getState().serverrender && (
              <span> Missing something? <a onClick={evt => AppState.dispatch({type: 'showFeedback', search: '/subjects/'})}>Request it</a>.</span>
            )}
          </p>
        </div>

        <div className='controls-section'>
          <div className='tabs'>
            <button 
              className={`tab-btn ${this.state.activeTab === 'A/s' ? 'active' : ''}`}
              onClick={() => this.setState({activeTab: 'A/s'})}>
              AS & A Level
            </button>
            <button 
              className={`tab-btn ${this.state.activeTab === 'IGCSE' ? 'active' : ''}`}
              onClick={() => this.setState({activeTab: 'IGCSE'})}>
              IGCSE
            </button>
            <button 
              className={`tab-btn ${this.state.activeTab === 'Misc' ? 'active' : ''}`}
              onClick={() => this.setState({activeTab: 'Misc'})}>
              Misc
            </button>
          </div>
          
          <div className='search-filter'>
            <svg className='icon' viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8"></circle>
              <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
            </svg>
            <input 
              type='text' 
              placeholder='Filter by code or name...' 
              value={this.state.searchQuery}
              onChange={this.handleSearch}
            />
          </div>
        </div>

        <div className='subject-grid'>
          {filteredSubjects.length > 0 ? 
            filteredSubjects.map(subjFunc) : 
            <div className='empty-state'>
              <div className='empty-icon'>🔍</div>
              <div>No subjects found matching your criteria.</div>
            </div>
          }
        </div>
      </div>
    )
  }

  handleQuery (query, evt) {
    evt.preventDefault()
    AppState.dispatch({type: 'query', query})
    AppState.dispatch({type: 'home'})
  }
  handleHome (evt) {
    evt.preventDefault()
    AppState.dispatch({type: 'home'})
  }
}
