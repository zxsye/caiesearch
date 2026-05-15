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
              {firstDoc.index.topics && firstDoc.index.topics.length > 0 && (
                <div className='topics'>
                  {firstDoc.index.topics.map(t => <span key={t} className='topic-badge'>{t}</span>)}
                </div>
              )}
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
        {(() => {
          if (firstDoc !== null) return null
          const qp = set.types.find(d => d.type === 'qp')
          const cov = qp && qp.topicCoverage
          if (cov && cov.totalUnits > 0) {
            const total = cov.totalUnits
            const rows = cov.byTopic && Object.keys(cov.byTopic).length > 0
              ? Object.keys(cov.byTopic)
                .map(name => ({ name, count: cov.byTopic[name] }))
                .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
              : []
            if (rows.length === 0) {
              return (
                <div className='pp-topic-coverage'>
                  <div className='pp-cov-head'>Topic coverage</div>
                  <div className='pp-cov-note'>
                    This paper has {total} indexed question part{total === 1 ? '' : 's'} (or whole items), but none are tagged with syllabus topics yet.
                  </div>
                </div>
              )
            }
            return (
              <div className='pp-topic-coverage'>
                <div className='pp-cov-head'>Topic coverage</div>
                <div className='pp-cov-note'>
                  This paper contains {total} subquestion{total === 1 ? '' : 's'} (or individual questions for MCQ). Each subquestion can have multiple topic tags, so the bars add up to more than {total}—the same subquestion can appear in several categories.
                </div>
                <div className='pp-cov-chart'>
                  {rows.map(row => (
                    <div className='pp-cov-row' key={row.name}>
                      <div className='pp-cov-label' title={row.name}>{row.name}</div>
                      <div className='pp-cov-mid'>
                        <div className='pp-cov-bar-wrap' title={`${row.count} / ${total}`}>
                          <div
                            className='pp-cov-bar-fill'
                            style={{ width: `${Math.min(100, (row.count / total) * 100)}%` }}
                          />
                        </div>
                      </div>
                      <div className='pp-cov-num'>{row.count}/{total}</div>
                    </div>
                  ))}
                </div>
              </div>
            )
          }
          if (qp && Array.isArray(qp.topics) && qp.topics.length > 0) {
            return (
              <div className='pp-topics'>
                {[...qp.topics].sort().map(t => (
                  <span key={t} className='topic-badge'>{t}</span>
                ))}
              </div>
            )
          }
          return null
        })()}
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
