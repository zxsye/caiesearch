import * as React from 'react'
import CIESubjects from './CIESubjects.js'
import { AppState } from './appstate.js'
import AnimatorReactComponent from './animatorReactComponent.jsx'

export default class SearchBar extends AnimatorReactComponent {
  constructor (props) {
    super(props)
    this.state = {
      query: '', // The string in the input box
      lastQueryChange: 0, // timestamp
      loadingStart: null, // timestamp
      lastTimeout: null, // return of setTimeout
      lastQuerySubmited: '',
      focus: true,
      subjectHintSelect: null
    }
    if (AppState.getState().serverrender) {
      this.state.server = true
      let querying = AppState.getState().querying
      if (querying)
        this.state.query = querying.query
    }
    this.inputDelay = 1000
    this.handleQueryChange = this.handleQueryChange.bind(this)
    this.handleKey = this.handleKey.bind(this)
    this.handleAppStateUpdate = this.handleAppStateUpdate.bind(this)
  }
  shouldShowLoading () {
    let querying = AppState.getState().querying
    return querying && querying.loading
  }
  componentDidMount () {
    if (AppState.getState().querying) {
      let q = AppState.getState().querying.query
      if (!q) return
      this.setState({
        query: q,
        lastQuerySubmited: q,
        lastQueryChange: Date.now()
      })
    }
    this.setState({loadingStart: this.shouldShowLoading() ? Date.now() : null})
    this.unsub = AppState.subscribe(this.handleAppStateUpdate)
  }
  handleAppStateUpdate () {
    let showLoading = this.shouldShowLoading()
    if (showLoading && this.state.loadingStart === null) {
      this.setState({loadingStart: Date.now()})
    } else if (!showLoading && this.state.loadingStart !== null) {
      this.setState({loadingStart: null})
    }

    let { querying } = AppState.getState()
    if (querying && querying.query !== this.state.lastQuerySubmited && !this.state.focus) {
      this.setQueryImmediate(querying.query)
      this.setState({lastQuerySubmited: querying.query})
    }
    if (!querying && this.state.lastQuerySubmited !== '') {
      this.setQueryImmediate('')
      this.setState({lastQuerySubmited: ''})
    }
  }
  handleQueryChange (evt) {
    let val = evt.target.value
    let fullQuery = this.state.query
    let pillMatch = fullQuery.match(/^(\d{4})(?:\s+(.*))?$/)
    let pillSubject = null

    if (pillMatch && CIESubjects.findExactById(pillMatch[1])) {
      pillSubject = CIESubjects.findExactById(pillMatch[1])
    }

    if (pillSubject) {
      val = pillSubject.id + (val.length > 0 ? ' ' + val.replace(/^\s+/, '') : '')
    }

    this.setState({query: val, lastQueryChange: Date.now(), subjectHintSelect: null}, () => {
       let newPillMatch = val.match(/^(\d{4})\s*$/)
       if (newPillMatch && CIESubjects.findExactById(newPillMatch[1])) {
         this.submitQuery(newPillMatch[1])
       } else if (val.trim() === '') {
         AppState.dispatch({type: 'query-clear'})
         this.submitQuery('')
       }
    })
  }
  clear () {
    this.setQueryImmediate('')
    this.focus()
    AppState.dispatch({type: 'query-clear'})
    this.submitQuery('')
  }
  handleKey (evt) {
    if (evt.key === 'ArrowDown' || evt.keyCode === 40) {
      evt.preventDefault()
      this.setState({subjectHintSelect: this.state.subjectHintSelect !== null ? this.state.subjectHintSelect + 1 : 0})
    }
    if (evt.key === 'ArrowUp' || evt.keyCode === 38) {
      evt.preventDefault()
      this.setState({subjectHintSelect: this.state.subjectHintSelect !== null ? this.state.subjectHintSelect - 1 : -1})
    }
    if (evt.key === 'Backspace' || evt.keyCode === 8) {
      let fullQuery = this.state.query
      let pillMatch = fullQuery.match(/^(\d{4})(?:\s+(.*))?$/)
      if (pillMatch && CIESubjects.findExactById(pillMatch[1])) {
        let displayQuery = pillMatch[2] || ''
        if (displayQuery === '') {
           evt.preventDefault()
           let newQuery = pillMatch[1].slice(0, -1)
           this.setState({
             query: newQuery,
             lastQueryChange: Date.now(),
             subjectHintSelect: null
           }, () => {
             AppState.dispatch({type: 'query-clear'})
             this.submitQuery('')
           })
           return
        }
      }
    }
    if (evt.key === 'Enter' || evt.keyCode === 13) {
      evt.preventDefault()
      if (this.state.subjectHintSelect !== null) {
        this.selectThisSubject()
      } else {
        this.submitQuery()
      }
    }
    this.focus()
  }
  selectThisSubject () {
    if (this.state.subjectHintSelect === null || !this.state.focus) {
      return
    }
    let srs = this.searchSubject(this.state.query)
    let sr = srs[this.calculateSubjectHintSelect(this.state.subjectHintSelect, srs.length)]
    if (!sr) return
    this.chooseSubject(sr.id)
  }
  componentWillUnmount () {
    this.blur()
    this.unsub()
    this.unsub = null
  }
  chooseSubject (id) {
    this.setState({
      query: id + ' ',
      lastQueryChange: Date.now(),
      subjectHintSelect: null
    }, () => {
      this.submitQuery(id)
    })
    setTimeout(() => this.input.focus(), 1)
  }
  setQueryImmediate (query) {
    this.setState({
      query: query,
      lastQueryChange: Date.now(),
      subjectHintSelect: null
    })
  }
  searchSubject (query) {
    let pillMatch = query.match(/^(\d{4})(?:\s+(.*))?$/)
    if (pillMatch && CIESubjects.findExactById(pillMatch[1])) {
      return CIESubjects.search((pillMatch[2] || '').replace(/^\s+/, ''))
    }
    return CIESubjects.search(query.replace(/^\s+/, ''))
  }
  calculateSubjectHintSelect (select, length) {
    if (length === 0) return 0
    select = select % length
    if (select < 0) {
      select = length + select
    }
    return select
  }
  submitQuery (valOverride) {
    let val = typeof valOverride !== 'undefined' ? valOverride : this.state.query
    if (val !== this.state.lastQuerySubmited) {
      this.props.onQuery && this.props.onQuery(val)
      this.setState({lastQuerySubmited: val})
    }
  }
  removePill (evt) {
    if (evt) evt.stopPropagation()
    let currentPillMatch = this.state.query.match(/^(\d{4})(?:\s+(.*))?$/)
    if (currentPillMatch) {
       let newQuery = (currentPillMatch[2] || '').replace(/^\s+/, '')
       this.setState({query: newQuery, lastQueryChange: Date.now(), subjectHintSelect: null}, () => {
         if (newQuery === '') {
           AppState.dispatch({type: 'query-clear'})
           this.submitQuery('')
         } else {
           this.submitQuery()
         }
       })
       setTimeout(() => this.input.focus(), 1)
    }
  }
  render () {
    let fullQuery = this.state.query
    let pillMatch = fullQuery.match(/^(\d{4})(?:\s+(.*))?$/)
    let pillSubject = null
    let displayQuery = fullQuery

    if (pillMatch && CIESubjects.findExactById(pillMatch[1])) {
      pillSubject = CIESubjects.findExactById(pillMatch[1])
      displayQuery = pillMatch[2] || ''
    }

    let hideBanner = !this.state.server && !this.props.big && !this.props.alwaysShowIcon && !AppState.getState().serverrender
    let strokeFillStyle = {}
    let lastChangedDur = Date.now() - this.state.lastQueryChange
    let loadingDur = Date.now() - this.state.loadingStart
    let loadAnimationCycle = 1000
    if (this.state.loadingStart !== null) {
      let ani = (loadingDur % loadAnimationCycle) / loadAnimationCycle
      if (ani <= 0.5) {
        // Stretch out from left
        strokeFillStyle.transform = `translateX(-${Math.round((1 - ani / 0.5) * 1000) / 10}%)`
      } else {
        // Stretch in from right
        strokeFillStyle.transform = `translateX(${Math.round((ani / 0.5 - 1) * 1000) / 10}%)`
      }
      strokeFillStyle.willChange = 'transform'
      this.nextFrameForceUpdate()
    } else {
      strokeFillStyle.transform = `translateX(0)`
    }
    let subjectHint = null
    let subjectSearchRes = this.state.focus ? this.searchSubject(this.state.query) : null
    if (!this.state.server && subjectSearchRes && subjectSearchRes.length > 0) {
      subjectSearchRes = subjectSearchRes.slice(0, 6)
      let sjHintSelect = this.state.subjectHintSelect
      if (sjHintSelect !== null) {
        sjHintSelect = this.calculateSubjectHintSelect(sjHintSelect, subjectSearchRes.length)
      }
      let getFocus = evt => {
        this.input.focus()
        evt.preventDefault()
      }
      subjectHint = (
        <div className='subjecthints'>
          {subjectSearchRes.map((sj, index) => {
            let thisSelected = index === sjHintSelect
            return (
              <div className={'subject' + (thisSelected ? ' select' : '')} key={sj.id}
                onClick={evt => this.chooseSubject(sj.id)}
                onTouchStart={getFocus} onTouchEnd={evt => {
                  getFocus(evt)
                  this.chooseSubject(sj.id)
                }} onMouseDown={getFocus} onMouseUp={getFocus}>
                <span className='id'>({sj.id})</span>
                &nbsp;
                <span className='level'>({sj.level})</span>
                &nbsp;
                <span className='name'>{sj.name}</span>
              </div>
          )
          })}
        </div>
      )
    }
    let renderT = (
      <div className={this.props.big ? 'searchbar big' : 'searchbar small'}>
        <div className={'bannerContain' + (hideBanner ? ' hide' : '')} key='bannerContain'>
          {this.props.big ? (
            <React.Fragment>
              <h1 className='heroTitle'>Search Past Papers</h1>
              <p className='heroSubtitle'>Find any CAIE paper instantly</p>
            </React.Fragment>
          ) : null}
        </div>
        <div className={'inputContain' + (hideBanner ? ' hidebanner' : '')}>
          <div className='inputPositionWrap'>
            {/* Search Icon — inline SVG for the magnifying glass */}
            <svg className='searchIcon' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round'>
              <circle cx='11' cy='11' r='8' />
              <line x1='21' y1='21' x2='16.65' y2='16.65' />
            </svg>
            {pillSubject ? (
              <div className='subjectPill'>
                <span className='code'>{pillSubject.id}</span>
                <span className='name'>{pillSubject.name}</span>
                <div className='removePill' onClick={evt => this.removePill(evt)} title='Remove subject filter'>
                  <svg viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round'><line x1='18' y1='6' x2='6' y2='18'></line><line x1='6' y1='6' x2='18' y2='18'></line></svg>
                </div>
              </div>
            ) : null}
            <input
              className={'querybox' + (this.state.server ? ' border' : '')}
              type='text'
              ref={f => this.input = f}
              value={displayQuery}
              onChange={this.handleQueryChange}
              onFocus={evt => this.focus(true)}
              onBlur={evt => this.blur(true)}
              onKeyDown={this.handleKey}
              name='query'
              placeholder={pillSubject ? 'Search paper content...' : 'Search by subject code, name, or paper content…'}
              autoComplete='off' />
            {this.state.server ? null : (
              <div className='stroke'>
                <div className='fill' style={strokeFillStyle} />
              </div>
            )}
            <div className='rightWrap'>
              {this.state.server ? (
                <button className='formsubmit' type='submit'>Search</button>
              ) : null}
              {this.state.query.length && !this.state.server
                ? (
                  <div className='clearInput' onClick={evt => this.clear()} title='Clear search'>
                    <svg className="icon ii-c"><use href="#ii-c" xlinkHref="#ii-c"></use></svg>
                  </div>
                )
                : null}
            </div>
          </div>
          {subjectHint}
        </div>
      </div>
    )
    if (this.state.server) {
      return (
        <form action='/search' method='get'>
          <input type='hidden' name='as' value='page' />
          {renderT}
        </form>
      )
    }
    return renderT
  }
  focus (dryRun) {
    if (!dryRun) this.input.focus()
    this.setState({focus: true})
  }
  blur (dryRun) {
    if (!dryRun) this.input.blur()
    this.setState({focus: false, subjectHintSelect: null})
  }
}
