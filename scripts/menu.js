#!/usr/bin/env node
// Interactive control panel for caiesearch.
// Runs on the HOST (not inside the container) and wraps the docker / reindex
// commands documented in AGENTS.md. See `npm run menu`.

const { spawn } = require('child_process')
const { select, input, confirm, checkbox } = require('@inquirer/prompts')

const CONTAINER = 'schsrch-www'

function run (cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: 'inherit', ...opts })
    child.on('exit', (code) => resolve(code ?? 0))
    child.on('error', (err) => {
      console.error(`\n  ✗ failed to spawn ${cmd}: ${err.message}\n`)
      resolve(1)
    })
  })
}

const dockerExec = (...args) => run('docker', ['exec', '-it', CONTAINER, ...args])
const compose = (...args) => run('docker-compose', args)

async function pause () {
  await input({ message: 'Press Enter to return to the menu.', default: '' })
}

// ── Stack ────────────────────────────────────────────────────────────────────
async function stackMenu () {
  const action = await select({
    message: 'Stack',
    choices: [
      { name: 'Start (docker-compose up -d)', value: 'up' },
      { name: 'Stop (docker-compose down)', value: 'down' },
      { name: 'Status (docker-compose ps)', value: 'ps' },
      { name: 'Restart www (Node server)', value: 'restart' },
      { name: 'Tail www logs (Ctrl-C to stop)', value: 'logs' },
      { name: '← back', value: 'back' }
    ]
  })
  if (action === 'back') return
  if (action === 'up') await compose('up', '-d')
  if (action === 'down') {
    const ok = await confirm({ message: 'Bring the whole stack down?', default: false })
    if (ok) await compose('down')
  }
  if (action === 'ps') await compose('ps')
  if (action === 'restart') await compose('restart', 'www')
  if (action === 'logs') await compose('logs', '-f', '--tail=200', 'www')
  await pause()
}

// ── Build ────────────────────────────────────────────────────────────────────
async function buildMenu () {
  const action = await select({
    message: 'Build',
    choices: [
      { name: 'npm install (inside container — recompiles sspdf addon)', value: 'install' },
      { name: 'webpack (production build of frontend)', value: 'webpack' },
      { name: 'webpack-dev (watch mode — Ctrl-C to stop)', value: 'webpack-dev' },
      { name: 'rebuild (webpack + restart www)', value: 'rebuild' },
      { name: '← back', value: 'back' }
    ]
  })
  if (action === 'back') return
  if (action === 'install') await dockerExec('npm', 'install')
  if (action === 'webpack') await dockerExec('npm', 'run', 'webpack')
  if (action === 'webpack-dev') await dockerExec('npm', 'run', 'webpack-dev')
  if (action === 'rebuild') await dockerExec('npm', 'run', 'rebuild')
  await pause()
}

// ── Ingest ───────────────────────────────────────────────────────────────────
async function ingestMenu () {
  const action = await select({
    message: 'Ingest papers (Stage 1)',
    choices: [
      { name: 'Add NEW papers (--new /papers)', value: 'new' },
      { name: 'FULL re-index (⚠ destructive — wipes topic tags)', value: 'full' },
      { name: 'Show reindex.bin.js --help', value: 'help' },
      { name: '← back', value: 'back' }
    ]
  })
  if (action === 'back') return
  if (action === 'help') {
    await dockerExec('node', 'reindex.bin.js', '--help')
    await pause()
    return
  }
  const dir = await input({ message: 'Papers directory inside container:', default: '/papers' })
  const quick = await confirm({ message: 'Quick mode (skip sspdf + ES)?', default: action === 'new' })
  if (action === 'full') {
    const ok = await confirm({ message: 'This will wipe existing topic tags. Continue?', default: false })
    if (!ok) return
  }
  const args = ['node', 'reindex.bin.js', action === 'full' ? '--full' : '--new']
  if (quick) args.push('--quick')
  args.push(dir)
  await dockerExec(...args)
  if (quick) {
    const chain = await confirm({
      message: 'Quick mode skipped dirs + ES. Run --repair-dirs and reIndexElasticSearch now?',
      default: true
    })
    if (chain) {
      await dockerExec('node', 'reindex.bin.js', '--repair-dirs')
      await dockerExec('node', 'reIndexElasticSearch.bin.js')
    }
  } else {
    const chain = await confirm({ message: 'Run --repair-dirs now to populate question maps?', default: true })
    if (chain) await dockerExec('node', 'reindex.bin.js', '--repair-dirs')
  }
  await pause()
}

// ── Repair ───────────────────────────────────────────────────────────────────
async function repairMenu () {
  const action = await select({
    message: 'Repair / re-recognize (Stage 2)',
    choices: [
      { name: '--repair-dirs   (backfill QP + MS dirs where empty)', value: 'repair-dirs' },
      { name: '--repair-qp     (backfill QP dirs only)', value: 'repair-qp' },
      { name: '--repair-ms     (backfill MS dirs only)', value: 'repair-ms' },
      { name: '--rerecognize-qp  (re-run recognizer on ALL QPs, preserve tags)', value: 'rerecognize' },
      { name: 'reIndexElasticSearch.bin.js  (rebuild full-text search)', value: 'reindex-es' },
      { name: '← back', value: 'back' }
    ]
  })
  if (action === 'back') return
  if (action === 'reindex-es') {
    await dockerExec('node', 'reIndexElasticSearch.bin.js')
    await pause()
    return
  }
  if (action === 'rerecognize') {
    const flags = await checkbox({
      message: 'Flags:',
      choices: [
        { name: '--dry-run (preview only, no writes)', value: '--dry-run', checked: true },
        { name: '--only-changed (skip docs whose qN set is unchanged)', value: '--only-changed' }
      ]
    })
    const subject = await input({ message: 'Restrict to subject code (blank = all):', default: '' })
    const args = ['node', 'reindex.bin.js', '--rerecognize-qp', ...flags]
    if (subject.trim()) args.push('--subject', subject.trim())
    await dockerExec(...args)
    await pause()
    return
  }
  await dockerExec('node', 'reindex.bin.js', `--${action}`)
  await pause()
}

// ── Tag (Gemini) ─────────────────────────────────────────────────────────────
async function tagMenu () {
  if (!process.env.GEMINI_API_KEY) {
    console.log('\n  ⚠ GEMINI_API_KEY is not set in your shell. doLinkTopics will fail.\n')
    const cont = await confirm({ message: 'Continue anyway?', default: false })
    if (!cont) return
  }
  const subject = await input({ message: 'Subject code:', default: '9709' })
  const limit = await input({ message: 'Limit (max papers to process):', default: '5' })
  const year = await input({ message: 'Year or range (blank = all):', default: '' })
  const papers = await input({ message: 'Papers / variants (blank = all, e.g. 1,2 or 11,12):', default: '' })
  const force = await confirm({ message: 'Force re-tag questions that already have topics?', default: false })

  const args = ['node', 'doLinkTopics.bin.js', subject, limit]
  if (year.trim()) args.push(year.trim())
  if (papers.trim()) {
    if (!year.trim()) args.push('') // positional placeholder
    args.push(papers.trim())
  }
  if (force) args.push('--force')

  console.log(`\n  $ docker exec -it ${CONTAINER} ${args.join(' ')}\n`)
  await dockerExec(...args)
  await pause()
}

// ── Full pipeline ────────────────────────────────────────────────────────────
async function pipelineMenu () {
  console.log('\n  Pipeline: ingest --new --quick → repair-dirs → reIndexElasticSearch → doLinkTopics\n')
  const dir = await input({ message: 'Papers directory:', default: '/papers' })
  const subject = await input({ message: 'Subject to tag (blank = skip tagging):', default: '9709' })
  const limit = subject.trim() ? await input({ message: 'Tagging limit:', default: '20' }) : null
  const ok = await confirm({ message: 'Run the pipeline now?', default: true })
  if (!ok) return

  const steps = [
    ['Ingest new papers (quick)', ['node', 'reindex.bin.js', '--new', '--quick', dir]],
    ['Repair dirs', ['node', 'reindex.bin.js', '--repair-dirs']],
    ['Rebuild Elasticsearch index', ['node', 'reIndexElasticSearch.bin.js']]
  ]
  if (subject.trim()) steps.push([`Tag topics (${subject})`, ['node', 'doLinkTopics.bin.js', subject.trim(), limit]])

  for (const [label, args] of steps) {
    console.log(`\n  ▶ ${label}`)
    const code = await dockerExec(...args)
    if (code !== 0) {
      console.log(`\n  ✗ Step "${label}" exited with code ${code}. Aborting pipeline.\n`)
      break
    }
  }
  await pause()
}

// ── Top level ────────────────────────────────────────────────────────────────
async function main () {
  while (true) {
    let action
    try {
      action = await select({
        message: 'caiesearch — control panel',
        pageSize: 12,
        choices: [
          { name: 'Stack       — start / stop / status / restart', value: 'stack' },
          { name: 'Build       — webpack, npm install, rebuild', value: 'build' },
          { name: 'Ingest      — add or re-index papers (Stage 1)', value: 'ingest' },
          { name: 'Repair      — populate / re-recognize dir (Stage 2)', value: 'repair' },
          { name: 'Tag topics  — doLinkTopics via Gemini (Stage 3)', value: 'tag' },
          { name: 'Pipeline    — ingest → repair → ES → tag, in one shot', value: 'pipeline' },
          { name: 'Tests       — npm test inside container', value: 'test' },
          { name: 'Shell       — open bash in schsrch-www', value: 'shell' },
          { name: 'Quit', value: 'quit' }
        ]
      })
    } catch (err) {
      // Ctrl-C at the top-level prompt
      if (err && (err.name === 'ExitPromptError' || err.message?.includes('force closed'))) return
      throw err
    }
    if (action === 'quit') return
    try {
      if (action === 'stack') await stackMenu()
      else if (action === 'build') await buildMenu()
      else if (action === 'ingest') await ingestMenu()
      else if (action === 'repair') await repairMenu()
      else if (action === 'tag') await tagMenu()
      else if (action === 'pipeline') await pipelineMenu()
      else if (action === 'test') { await dockerExec('npm', 'test'); await pause() }
      else if (action === 'shell') await dockerExec('bash')
    } catch (err) {
      if (err && (err.name === 'ExitPromptError' || err.message?.includes('force closed'))) {
        // Ctrl-C inside a submenu — drop back to the top level instead of crashing.
        console.log('\n  (cancelled — returning to main menu)\n')
        continue
      }
      throw err
    }
  }
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err)
  process.exit(1)
})
