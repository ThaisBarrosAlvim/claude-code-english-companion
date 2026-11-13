import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

// Runs the real server (server/lang_server.py) against a throwaway socket. Needs python3
// (set ENGLISH_COMPANION_PYTHON to pick another interpreter); skipped where there is none.

const python = process.env.ENGLISH_COMPANION_PYTHON ?? 'python3'
const hasPython = spawnSync(python, ['--version']).status === 0

const server = new URL('../server/lang_server.py', import.meta.url).pathname
const model = new URL('../model/lid.176.ftz', import.meta.url).pathname

type Answer = { lang: string; p: number; top: [string, number][] }

function ask(socketPath: string, text: string): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, method: 'POST', path: '/' }, res => {
      let body = ''
      res.on('data', chunk => (body += chunk))
      res.on('end', () => resolve(JSON.parse(body)))
    })
    req.on('error', reject)
    req.end(text)
  })
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

test('server detaches, answers, is single, and exits when idle', { skip: !hasPython && 'python3 is not installed' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'english-companion-'))
  const sock = join(dir, 'english-companion.sock')
  const launch = () =>
    spawnSync(python, [server, '--sock', sock, '--model', model, '--idle', '3'], { encoding: 'utf8', timeout: 15_000 })

  try {
    // The launcher returns once the socket listens, with the server detached.
    assert.equal(launch().status, 0)

    // Any of the model's languages is answered, not just one pair.
    const samples: [string, string][] = [
      ['eu acho que você deveria fazer isso agora', 'pt'],
      ['creo que deberías hacerlo ahora mismo por favor', 'es'],
      ['ich glaube du solltest das jetzt machen', 'de'],
      ['please refactor the parser and run the tests again', 'en'],
    ]
    for (const [text, code] of samples) {
      const answer = await ask(sock, text)
      assert.equal(answer.lang, code, text)
      assert.ok(answer.p > 0.5)
      assert.equal(answer.top[0]?.[0], code) // the best of the top three is the answer
      assert.equal(answer.top.length, 3)
    }

    // An empty draft, or one that is all code, is undetermined.
    assert.deepEqual(await ask(sock, ''), { lang: 'und', p: 0, top: [] })

    // A second launcher finds the lock held and leaves.
    const second = launch()
    assert.equal(second.status, 0)
    assert.match(second.stdout, /already running/)

    // After the idle time it removes its socket and exits.
    await sleep(5500)
    await assert.rejects(ask(sock, 'still there?'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the launcher fails with a reason when the model is missing', { skip: !hasPython && 'python3 is not installed' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'english-companion-'))
  try {
    const run = spawnSync(python, [server, '--sock', join(dir, 's.sock'), '--model', join(dir, 'nope.ftz'), '--foreground'], {
      encoding: 'utf8',
      timeout: 15_000,
    })
    assert.equal(run.status, 4)
    assert.match(run.stderr, /cannot load the model/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
