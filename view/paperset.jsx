import * as React from 'react'
import * as Subjects from './CIESubjects.js'
import PaperUtils from './paperutils.js'
import IndexContent from './indexcontent.jsx'
import { AppState } from './appstate.js'

export default class PaperSet extends React.Component {
  constructor (props) {
    super(props)
    this.state = {}
    if (AppState.getState().serverrender) {
      this.state.server = true
    }
  }
  render () {
    let set = this.props.paperSet
    let subject = Subjects.findExactById(set.subject)
    let sortedTypes
    let firstDoc = null
    // firstDoc is the doc to be displayed its content. Remaining docs will appear under "Related:"
    if (set.types[0] && set.types[0].index) {
      firstDoc = set.types[0]
    }
    // sortedTypes is all the document in this set *except* the one that gets displayed its content in full text search.
    const ALLOWED_TYPES = ['qp', 'ms', 'er', 'gt']
    sortedTypes = set.types.slice(firstDoc !== null ? 1 : 0)
      .filter(file => ALLOWED_TYPES.includes(file.type))
      .sort((a, b) => PaperUtils.funcSortType(a.type, b.type))
    return (
      <div className={'set' + (this.props.mini ? ' mini' : '') + (this.props.current ? ' current' : '')}>
        <div className='set-header'>
          <div className='subject-info'>
            {subject
              ? <span>
                  <span className='level'>({subject.level})</span>
                  {subject.name}
                </span>
              : <span>{set.subject}???</span>}
          </div>
          
          <div className='badges'>
            <span className={`badge season-${PaperUtils.getSeason(set.time)}`}>
              {PaperUtils.myTimeToHumanTime(set.time)}
            </span>
            {set.paper !== 0 ? (
              <span className='badge paper'>Paper {set.paper}</span>
            ) : null}
            {set.variant !== 0 ? (
              <span className='badge variant'>v{set.variant}</span>
            ) : null}
          </div>
        </div>

        {firstDoc !== null
          ? (
            <div className='file first' key={firstDoc._id} onClick={evt => this.openFile(firstDoc._id, firstDoc.index.page, firstDoc.type)}>
              <div className='file-main'>
                <span className='typename'>{PaperUtils.capitalizeFirst(PaperUtils.getTypeString(firstDoc.type))}</span>
                <span className='pageinfo'>
                  page {firstDoc.index.page + 1} of {firstDoc.numPages}
                </span>
              </div>
              <IndexContent content={firstDoc.index.content} search={this.props.query || ''} />
            </div>
          )
          : null}

        <div className='file-list'>
          {firstDoc && (sortedTypes.length > 0 || set.types.find(x => x.type === 'qp')) ? <div className='related-label'>Related</div> : null}
          <div className='pills-container'>
            {set.types.find(x => x.type === 'qp') ? (
              <div className='file-pill questions' onClick={evt => this.openFile(set.types.find(x => x.type === 'qp')._id, 0, null)}>
                <svg className="pill-icon icon ii-dir"><use href="#ii-dir" xlinkHref="#ii-dir"></use></svg>
                <span className='pill-name'>Questions</span>
              </div>
            ) : null}
            {sortedTypes.map(file => {
              let icon = 'ii-pg'
              if (file.type === 'ms') icon = 'ii-pg' // Could differentiate if more icons exist
              return (
                <div className='file-pill' key={file._id} onClick={evt => this.openFile(file._id, this.getLastPreviewPage(file._id), file.type)}>
                  <svg className="pill-icon icon ii-pg"><use href="#ii-pg" xlinkHref="#ii-pg"></use></svg>
                  <span className='pill-name'>{PaperUtils.capitalizeFirst(PaperUtils.getTypeString(file.type))}</span>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    )
  }

  shouldComponentUpdate (nextProps, nextState) {
    if (nextState.server || this.state.server) return true
    if (nextProps.paperSet !== this.props.paperSet || nextProps.query !== this.props.query || nextProps.current != this.props.current) return true
    return false
  }

  openFile (id, page = 0, type = null) {
    if (this.props.onOpenFile) {
      this.props.onOpenFile(id, page, type)
    } else {
      window.open(this.fileUrl(id))
    }
  }
  fileUrl (id) {
    return '/doc/' + encodeURIComponent(id)
  }
  getLastPreviewPage (doc) {
    let pres = AppState.getState().previewPages[doc]
    return pres || 0
  }
}
