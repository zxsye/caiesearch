import * as React from 'react'
import { createStore } from 'redux'
import { AppState } from './appstate.js'
import * as FetchErrorPromise from './fetcherrorpromise.jsx'
import CIESubjects from './CIESubjects.js'

let statusInfoState = createStore(function (state = {}, action) {
  switch (action.type) {
    case 'load':
      return Object.assign({}, state, {stat: action.data, err: null, loading: false})
    case 'unload':
      return Object.assign({}, state, {stat: null, err: null, loading: true})
    case 'error':
      return Object.assign({}, state, {stat: null, err: action.err, loading: false})
  }
})

let lastTimeout
function fetchStatusInfo () {
  if ((statusInfoState.getState() || {}).loading) return
  if (!AppState.getState().querying) {
    statusInfoState.dispatch({type: 'unload'})
    fetch('/status/').then(FetchErrorPromise.then, FetchErrorPromise.error).then(res => res.json()).then(stat => {
      statusInfoState.dispatch({type: 'load', data: stat})
    }, err => {
      statusInfoState.dispatch({type: 'error', err})
    })
    lastTimeout && clearTimeout(lastTimeout)
    lastTimeout = setTimeout(fetchStatusInfo, 5000)
  } else {
    let unsub = AppState.subscribe(() => {
      if (!AppState.getState().querying) {
        unsub()
        fetchStatusInfo()
      }
    })
  }
}

export default class Description extends React.Component {
  constructor (props) {
    super(props)
    this.state = {}
    if (AppState.getState().serverrender) {
      this.state.server = true
      this.state.status = AppState.getState().serverrender.status
    }
    this.updateStat = this.updateStat.bind(this)
    this.handleShowHelp = this.handleShowHelp.bind(this)
    this.handleHideHelp = this.handleHideHelp.bind(this)
  }
  componentDidMount () {
    this.updateStat()
    this.unsub = statusInfoState.subscribe(this.updateStat)
    if (!AppState.getState().serverrender) {
      fetchStatusInfo()
    }
  }
  componentWillUnmount () {
    this.unsub()
    this.unsub = null
  }
  updateStat () {
    let st = statusInfoState.getState() || {}
    this.setState({loading: st.loading, error: st.err})
    if (st.stat) {
      this.setState({status: st.stat})
    } else if (st.server) {
      this.setState({server: true})
    }
  }
  render () {
    let statusInfo = null
    let reloadBtn = (
      <div className="reload">
        <span onClick={fetchStatusInfo}>Refresh</span>
      </div>
    )
    if (this.state.server) {
      statusInfo = (
        <span className='status'>
          Currently supporting&nbsp;
          <a href='/subjects/'>{CIESubjects.length} subjects</a>.
        </span>
      )
    } else if (this.state.status && !this.state.error) {
      let stat = this.state.status
      statusInfo = (
        <span className={'status' + (this.state.loading ? ' loading' : '')}>
          <a onClick={evt => AppState.dispatch({type: 'subjects'})} href='/subjects/'>
            {CIESubjects.length} subjects
          </a> · {stat.docCount} papers · {stat.indexCount} pages
          {this.state.loading ? null : reloadBtn}
        </span>
      )
    } else if (!this.state.error) {
      statusInfo = (
        <span className='status'>
          Fetching status information...
        </span>
      )
    } else {
      statusInfo = (
        <span className='status'>
          <FetchErrorPromise.ErrorDisplay error={this.state.error} serverErrorActionText={'fetch status'} />
          {reloadBtn}
        </span>
      )
    }
    // Quick-access subject cards (Maths + 3 Sciences)
    // Each card dispatches a search query when clicked.
    const quickSubjects = [
      { id: '9709', name: 'Mathematics', emoji: '📐' },
      { id: '9702', name: 'Physics', emoji: '⚛️' },
      { id: '9701', name: 'Chemistry', emoji: '🧪' },
      { id: '9700', name: 'Biology', emoji: '🧬' },
      { id: '9608', name: 'Computer Science', emoji: '💻' },
      { id: '9708', name: 'Economics', emoji: '📈' },
    ]

    return (
      <div className='home-desc'>
        {this.state.server && !this.props.showHelp ? (
          <div className='links'>
            <a href='/disclaim/'>Disclaimer</a>
            &nbsp;
            <a href='https://github.com/micromaomao/schsrch/blob/master/index.js' target='_blank'>API</a>
          </div>
        ) : null}

        {/* Quick-access subject cards */}
        {!this.props.showHelp ? (
          <div className='quick-subjects'>
            {quickSubjects.map(subj => (
              <div
                className='quick-subject-card'
                key={subj.id}
                onClick={() => AppState.dispatch({type: 'query', query: subj.id + ' '})}
              >
                <div className='card-emoji'>{subj.emoji}</div>
                <div className='card-name'>{subj.name}</div>
                <div className='card-code'>{subj.id}</div>
              </div>
            ))}
          </div>
        ) : null}

        {/* Browse all subjects link */}
        {!this.props.showHelp ? (
          <div className='browse-all'>
            <a onClick={evt => AppState.dispatch({type: 'subjects'})} href='/subjects/'>
              Browse all {CIESubjects.length} subjects →
            </a>
          </div>
        ) : null}

        {this.props.showHelp ? (
          <div className='help'>
            <a className='helpbtn' onClick={this.handleHideHelp} href='/'>{this.state.server ? 'Back' : 'Close help'}</a>
          </div>
        ) : null}

        {(this.state.server ? AppState.getState().serverrender.siteOrigin : window.location.origin) === 'https://paper.sc' || this.props.showHelp ? null : (
          <div className='mirrornotice'>You are viewing a mirror of <a href='https://paper.sc'>paper.sc</a>.</div>
        )}
        
        {!this.props.showHelp ? (
          <div className='footer-stats'>
            {statusInfo}
            <span className='separator'> · </span>
            <span className='copyright'>© <a href='http://www.cambridgeassessment.org.uk/' target='_blank'>UCLES</a> · Educational use only</span>
            <span className='separator'> · </span>
            <a className='help-link' onClick={this.handleShowHelp} href='/help/'>Help</a>
          </div>
        ) : null}
      </div>
    )
  }

  handleShowHelp (evt) {
    evt.preventDefault()
    AppState.dispatch({type: 'show-help'})
  }
  handleHideHelp (evt) {
    evt.preventDefault()
    AppState.dispatch({type: 'hide-help'})
  }
}
