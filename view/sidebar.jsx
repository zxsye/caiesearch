import * as React from 'react'
import * as FetchErrorPromise from './fetcherrorpromise.jsx'
import { AppState } from './appstate.js'
import { navigateHome } from './homebutton.jsx'

export default class Sidebar extends React.Component {
  constructor (props) {
    super(props)
    this.state = {}
  }

  render () {
    let { currentView: view } = this.props
    return (
      <div className={'sidebar ' + (this.props.show ? 'show' : 'hide')}>
        {this.state.userOperationError && !this.state.userOperationProgressText ?
          (
            <div className='userOperationError'>
              <div className='error'>{this.state.userOperationError.message}</div>
              <div className='clear' onClick={evt => this.setState({userOperationError: null})}>Dismiss</div>
            </div>
          ) : null}
        <div className='menu'>
          <div className='menu-section'>Navigation</div>
          <div className={'menuitem' + (view === 'home' ? ' current' : '')} onClick={evt => navigateHome()}>
            <span className='icon'>🏠</span> Home
          </div>
          <div className={'menuitem' + (view === 'subjects' ? ' current' : '')} onClick={evt => AppState.dispatch({type: 'subjects'})}>
            <span className='icon'>📚</span> Browse Subjects
          </div>
          <div className={'menuitem' + (view === 'topics' ? ' current' : '')} onClick={evt => AppState.dispatch({type: 'topics'})}>
            <span className='icon'>🔖</span> Browse by Topic
          </div>
          <div className={'menuitem' + (AppState.getState().showHelp ? ' current' : '')} onClick={evt => AppState.dispatch({type: 'show-help'})}>
            <span className='icon'>❓</span> Help
          </div>
          
          <div className='menu-section' style={{marginTop: '1rem'}}>Quick Subjects</div>
          <div className='menuitem' onClick={evt => AppState.dispatch({type: 'query', query: '9709'})}>
            <span className='icon'>📐</span> Math (9709)
          </div>
          <div className='menuitem' onClick={evt => AppState.dispatch({type: 'query', query: '9700'})}>
            <span className='icon'>🧬</span> Biology (9700)
          </div>
          <div className='menuitem' onClick={evt => AppState.dispatch({type: 'query', query: '9701'})}>
            <span className='icon'>🧪</span> Chemistry (9701)
          </div>
          <div className='menuitem' onClick={evt => AppState.dispatch({type: 'query', query: '9702'})}>
            <span className='icon'>⚡</span> Physics (9702)
          </div>
        </div>
        <div className='bottom'>
          <a onClick={evt => AppState.dispatch({type: 'disclaim'})}>Disclaimer</a>
          <a href='https://github.com/micromaomao/schsrch/blob/master/index.js' target='_blank'>API</a>
        </div>
      </div>
    )
  }
}
