import * as React from 'react'

// Collapsible topic/subtopic tree with checkboxes.
// Props:
//   syllabus: {topics: [{topic_id, topic_name, subtopics: [{id, name}]}]}
//   selections: [{kind: 'topic'|'subtopic', name: string}]
//   onChange: (newSelections) => void
export default class SyllabusTree extends React.Component {
  constructor (props) {
    super(props)
    this.state = {
      // Set of topic_name strings whose subtopic list is expanded
      expanded: new Set()
    }
  }

  isTopicFullySelected (topic) {
    const { selections } = this.props
    if (!selections) return false
    // Either the topic itself is selected, or all subtopics are selected
    if (selections.some(s => s.kind === 'topic' && s.name === topic.topic_name)) return true
    const subNames = (topic.subtopics || []).map(s => s.name)
    if (subNames.length === 0) return false
    return subNames.every(n => selections.some(s => s.kind === 'subtopic' && s.name === n))
  }

  isTopicPartiallySelected (topic) {
    const { selections } = this.props
    if (!selections) return false
    if (this.isTopicFullySelected(topic)) return false
    const subNames = (topic.subtopics || []).map(s => s.name)
    return subNames.some(n => selections.some(s => s.kind === 'subtopic' && s.name === n))
  }

  isSubtopicSelected (subtopicName) {
    const { selections } = this.props
    if (!selections) return false
    return selections.some(s =>
      (s.kind === 'subtopic' && s.name === subtopicName)
    )
  }

  toggleTopic (topic) {
    const { selections = [], onChange } = this.props
    if (!onChange) return
    const isFull = this.isTopicFullySelected(topic)
    let next
    if (isFull) {
      // Deselect topic and all its subtopics
      next = selections.filter(s =>
        !(s.kind === 'topic' && s.name === topic.topic_name) &&
        !(s.kind === 'subtopic' && (topic.subtopics || []).some(sub => sub.name === s.name))
      )
    } else {
      // Remove any individual subtopics and add the topic
      const withoutSubs = selections.filter(s =>
        !(s.kind === 'subtopic' && (topic.subtopics || []).some(sub => sub.name === s.name)) &&
        !(s.kind === 'topic' && s.name === topic.topic_name)
      )
      next = [...withoutSubs, { kind: 'topic', name: topic.topic_name }]
    }
    onChange(next)
  }

  toggleSubtopic (topic, subtopicName) {
    const { selections = [], onChange } = this.props
    if (!onChange) return
    const isSelected = this.isSubtopicSelected(subtopicName)
    let next
    if (isSelected) {
      // Remove this subtopic; also expand topic selection if needed
      next = selections.filter(s =>
        !(s.kind === 'subtopic' && s.name === subtopicName) &&
        !(s.kind === 'topic' && s.name === topic.topic_name)
      )
      // If topic was selected as a whole, expand to individual subtopics minus this one
      const wasTopicSelected = selections.some(s => s.kind === 'topic' && s.name === topic.topic_name)
      if (wasTopicSelected) {
        const otherSubs = (topic.subtopics || [])
          .filter(s => s.name !== subtopicName)
          .map(s => ({ kind: 'subtopic', name: s.name }))
        next = [...next, ...otherSubs]
      }
    } else {
      // Remove whole-topic selection if present, add this subtopic
      next = selections.filter(s =>
        !(s.kind === 'topic' && s.name === topic.topic_name)
      )
      next = [...next, { kind: 'subtopic', name: subtopicName }]
      // If all subtopics are now selected, collapse to topic-level
      const allSelected = (topic.subtopics || []).every(sub =>
        next.some(s => s.kind === 'subtopic' && s.name === sub.name)
      )
      if (allSelected && (topic.subtopics || []).length > 0) {
        next = next.filter(s =>
          !(s.kind === 'subtopic' && (topic.subtopics || []).some(sub => sub.name === s.name))
        )
        next = [...next, { kind: 'topic', name: topic.topic_name }]
      }
    }
    onChange(next)
  }

  toggleExpanded (topicName) {
    this.setState(prev => {
      const expanded = new Set(prev.expanded)
      if (expanded.has(topicName)) expanded.delete(topicName)
      else expanded.add(topicName)
      return { expanded }
    })
  }

  render () {
    const { syllabus } = this.props
    if (!syllabus || !Array.isArray(syllabus.topics)) {
      return <div className='syllabus-tree-empty'>No syllabus loaded.</div>
    }

    return (
      <div className='syllabus-tree'>
        {syllabus.topics.map(topic => {
          const full = this.isTopicFullySelected(topic)
          const partial = this.isTopicPartiallySelected(topic)
          const expanded = this.state.expanded.has(topic.topic_name)

          return (
            <div key={topic.topic_id} className='syllabus-topic'>
              <div className='syllabus-topic-row'>
                <input
                  type='checkbox'
                  className='syllabus-checkbox'
                  checked={full}
                  ref={el => { if (el) el.indeterminate = partial }}
                  onChange={() => this.toggleTopic(topic)}
                />
                <span
                  className='syllabus-topic-name'
                  onClick={() => this.toggleExpanded(topic.topic_name)}
                >
                  <span className='syllabus-topic-num'>{topic.topic_id}.</span>
                  {' '}{topic.topic_name}
                </span>
                <span
                  className={'syllabus-expand-btn' + (expanded ? ' expanded' : '')}
                  onClick={() => this.toggleExpanded(topic.topic_name)}
                >
                  {expanded ? '▾' : '▸'}
                </span>
              </div>
              {expanded && (
                <div className='syllabus-subtopics'>
                  {(topic.subtopics || []).map(sub => (
                    <div key={sub.id} className='syllabus-subtopic-row'>
                      <input
                        type='checkbox'
                        className='syllabus-checkbox'
                        checked={this.isSubtopicSelected(sub.name) || full}
                        onChange={() => this.toggleSubtopic(topic, sub.name)}
                      />
                      <span className='syllabus-subtopic-name'>
                        <span className='syllabus-topic-num'>{sub.id}</span>
                        {' '}{sub.name}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    )
  }
}
