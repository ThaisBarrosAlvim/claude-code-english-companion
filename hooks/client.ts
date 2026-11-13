import type { EngineInterface } from 'claude-code'

import type { Detected } from './languages'

// Which language a draft is written in, asked of the fastText language server
// (server/lang_server.py), which knows 176 languages.
//
// The server listens on a Unix socket and is shared by every open chat. If nobody answers,
// the first chat that needs it starts it (it detaches itself and exits after 30 idle minutes),
// so there is nothing to install or keep running by hand: it is pure Python 3, standard library
// only. Without a python3 the language warning stays off, and the mod says so once; the English
// review does not need the server.

const SOCKET_NAME = 'english-companion.sock'
const IDLE_SECONDS = 1800
const RETRY_AFTER_MS = 60_000 // after a failed start, do not try again for this long

type Answer = { lang: string; p: number; top: [string, number][] }

let socketPath: string | undefined
let starting: Promise<boolean> | undefined
let giveUpUntil = 0
let hasWarned = false

// $XDG_RUNTIME_DIR when the system has one, else a private folder under the cache.
async function resolveSocket($: EngineInterface): Promise<string> {
  if (socketPath) return socketPath

  const runtime = await $.env.get('XDG_RUNTIME_DIR')
  if (runtime) {
    socketPath = `${runtime}/${SOCKET_NAME}`
  } else {
    const home = (await $.env.get('HOME')) ?? '/tmp'
    socketPath = `${home}/.cache/english-companion/${SOCKET_NAME}`
  }
  return socketPath
}

async function ask($: EngineInterface, text: string): Promise<Answer | undefined> {
  try {
    const res = await $.http.fetch('http://english-companion/', {
      method: 'POST',
      body: text,
      socketPath: await resolveSocket($),
    })
    return res.ok ? (JSON.parse(res.text) as Answer) : undefined
  } catch {
    return undefined // nobody listening
  }
}

// The first interpreter that is Python 3.7 or newer: an override, then python3, then python.
async function findPython($: EngineInterface): Promise<string | undefined> {
  const override = await $.env.get('ENGLISH_COMPANION_PYTHON')
  const candidates = [override, 'python3', 'python']

  for (const python of candidates) {
    if (!python) continue
    try {
      const probe = await $.process.run([python, '-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 7) else 1)'])
      if (probe.exitCode === 0) return python
    } catch {
      // not installed there: try the next one
    }
  }
  return undefined
}

async function startServer($: EngineInterface): Promise<boolean> {
  const python = await findPython($)
  if (!python) return false

  const root = $.plugin.root
  const sock = await resolveSocket($)
  try {
    // The launcher detaches the server and exits once the socket listens; one that lost the
    // race to another chat exits at once, so below we wait for whoever won.
    const run = await $.process.run(
      [python, `${root}/server/lang_server.py`, '--sock', sock, '--model', `${root}/model/lid.176.ftz`, '--idle', String(IDLE_SECONDS)],
      { timeoutMs: 15_000 },
    )
    if (run.exitCode !== 0) return false
  } catch {
    return false
  }

  for (let i = 0; i < 20; i++) {
    if (await ask($, 'warming up the language server')) return true
    await $.clock.sleep(150)
  }
  return false
}

// Chats that need the server at the same moment share one start.
async function startOnce($: EngineInterface): Promise<boolean> {
  starting ??= startServer($)
  try {
    return await starting
  } finally {
    starting = undefined
  }
}

// Called when a session starts, so the first keystroke already finds the server up.
export async function warmUp($: EngineInterface): Promise<void> {
  if (!(await ask($, 'warming up the language server'))) await startOnce($)
}

// The language the draft is written in, as a language code and how sure the model is; undefined
// when the server cannot be reached or started.
export async function detect($: EngineInterface, draft: string): Promise<Detected | undefined> {
  let answer = await ask($, draft)

  if (!answer) {
    const now = await $.clock.now()
    if (now >= giveUpUntil) {
      if (await startOnce($)) answer = await ask($, draft)
      if (!answer) giveUpUntil = now + RETRY_AFTER_MS
    }
  }
  if (answer) return { code: answer.lang, p: answer.p }

  if (!hasWarned) {
    hasWarned = true
    $.ui.toast('🎓 english-companion: no python3 found, so the language warning is off (see the README)')
  }
  return undefined
}
