'use strict'

import * as React from 'react'
import { AppState } from './appstate.js'

/** Same navigation as Sidebar → Home; use from non-React code or custom UIs. */
export function navigateHome () {
  AppState.dispatch({ type: 'home' })
}

/**
 * Reusable Home control (toolbar / headers). Matches app-wide home routing.
 *
 * @param {object} props
 * @param {string} [props.className] — appended to `schsrch-home-btn`
 * @param {string} [props.label='Home']
 * @param {boolean} [props.showIcon=true] — house emoji before label
 * @param {string} [props.title='Return to search']
 */
export default function HomeButton (props) {
  const {
    className = '',
    label = 'Home',
    showIcon = true,
    title = 'Return to search'
  } = props

  return (
    <button
      type='button'
      className={'schsrch-home-btn ' + className}
      title={title}
      onClick={navigateHome}
    >
      {showIcon ? (
        <span className='schsrch-home-btn__icon' aria-hidden='true'>🏠</span>
      ) : null}
      <span className='schsrch-home-btn__label'>{label}</span>
    </button>
  )
}
