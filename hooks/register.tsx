import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Review } from '../types'
import { detect, warmUp } from './client'
import type { Target } from './languages'
import { hasEnoughText, isOtherLanguage, parseTarget } from './languages'
import type { ReviewSettings } from './review'
import { changedPieces, cleanSettings, clip, fitPairs, highlights, reviewDraft, shouldReview } from './review'

// english-companion helps you write in the language you chose (English by default), in two
// moments. Both are drawn on the hint row under the prompt (the engine's status line would add
// its own "⚠ name:" in front, and cannot be colored), so the line is made of colored pieces:
//
//   while you type  if the draft is in another language (any of the 176 the detector knows), a
//                   solid yellow block, easy to catch at a glance:
//                   🎓 english-companion  [ 🌐 ES → EN ] write in English
//   after you send  a short Haiku review of your writing, no block. 📝 fixes (mistakes) show the
//                   wrong piece in red and the right one in green, ✨ improvements (correct but
//                   unnatural) show the better wording in purple:
//                   🎓 english-companion  📝 2 fixes: recieve → receive · chek → check   1: details · 2: dismiss
//                   🎓 english-companion  ✨ 1 improvement: need make → need to make   1: details · 2: dismiss
//                   With the prompt box empty, `1` opens the full explanation in a bordered band
//                   above the prompt and `2` dismisses the tip; typing anything else also
//                   dismisses it.
//
// Nothing here blocks, rewrites or delays what you type or send. The state is per session, so
// with several chats open each one shows the state of its own draft.

const KEYS = '1: details · 2: dismiss'
const WORD = 18 // longest piece of a change shown on the row; longer ones are cut

// Change the tag when the shape of a review changes: it declines what an earlier version stored,
// which outlives a reload.
const review = atom({ plugin: 'english-companion', key: 'review' } as const, null, { shape: 'review-2' })
const isExpanded = atom({ plugin: 'english-companion', key: 'isExpanded' } as const, false)
// The code of the language the draft is in when it is not the one you chose; empty otherwise.
const otherLanguage = atom({ plugin: 'english-companion', key: 'otherLanguage' } as const, '')

let latest = 0 // newest language check; an older answer arriving late is dropped
let edits = 0 // real changes to the draft so far; a review shows only if none happened since the send
let reviewSeq = 0 // newest review request; an older answer arriving late is dropped
let isTipShown = false
let shownOther = '' // what the state holds, so an unchanged answer does not redraw
// The settings the reviewer works with, and the language you write in (its name and its code).
let settings: ReviewSettings = cleanSettings({})
let target: Target = parseTarget(undefined)

async function setOther($: EngineInterface, code: string): Promise<void> {
  if (shownOther === code) return
  shownOther = code
  await update($, otherLanguage, () => code)
}

// While you type: the warning when the draft is in another language.
async function check($: EngineInterface, text: string): Promise<void> {
  const mine = ++latest
  const draft = text.trim()

  if (draft === '') {
    await setOther($, '') // empty box: nothing to warn about
    return
  }
  if (!hasEnoughText(draft)) return // too short to judge: keep what shows now

  const detected = await detect($, draft)
  if (mine === latest) await setOther($, isOtherLanguage(detected, target.code) ? (detected?.code ?? '') : '')
}

async function clearTip($: EngineInterface): Promise<void> {
  isTipShown = false
  await update($, isExpanded, () => false)
  await update($, review, () => null)
}

async function showTip($: EngineInterface, tip: Review, editsAtSend: number): Promise<void> {
  if (editsAtSend !== edits) return // you already started the next prompt
  isTipShown = true
  await setOther($, '')
  await update($, isExpanded, () => false)
  await update($, review, () => tip)
}

// After you send: the review, if it is turned on. A draft in another language is left to the live
// warning, and short prompts, slash commands and shell lines are not worth a model call.
async function reviewSent($: EngineInterface, text: string, editsAtSend: number): Promise<void> {
  const mine = ++reviewSeq
  if (!settings.enabled || !shouldReview(text)) return
  if (isOtherLanguage(await detect($, text), target.code)) return

  const tip = await reviewDraft($, text, settings)
  if (tip && mine === reviewSeq) await showTip($, tip, editsAtSend)
}

async function pressKey($: EngineInterface, key: string): Promise<void> {
  if (key === '1') await update($, isExpanded, () => true)
  else await clearTip($)
}

export const register: Register = (on, options) => {
  settings = cleanSettings(options)
  target = parseTarget(options.targetLanguage)

  // Start the language server ahead of the first keystroke.
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    void warmUp($)
    return started
  })

  // Typing and pasting. `e.text` is the draft before the key; the edited draft comes from
  // `next`. The editor gets the draft back first, so typing never waits on a check.
  on('prompt.edit', async ($, e, next) => {
    // The tip's keys: only in an empty box, so they never eat a digit of a prompt being typed.
    if (isTipShown && e.text === '' && (e.inputText === '1' || e.inputText === '2')) {
      await pressKey($, e.inputText)
      return { text: e.text, cursor: e.cursor }
    }

    if (e.inputText !== '' || e.end !== e.start) {
      edits += 1
      if (isTipShown) await clearTip($)
    }

    const after = await next(e)
    void check($, after.text)
    return after
  })

  // Text that did not come from typing: a recalled history entry, the clear after sending.
  on('prompt.change', async ($, e, next) => {
    if (isTipShown && e.text !== '') {
      edits += 1
      await clearTip($)
    }
    void check($, e.text)
    return next(e)
  })

  // A prompt you sent: review it without holding it back.
  // `.catch`: if this hook ever fails, the prompt goes on as it was; it must never hold one back.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'composer' && !e.command && !e.isMeta) void reviewSent($, e.text, edits)
    return next(e)
  }).catch(($, e, next) => next(e))

  // The line itself, on the hint row under the prompt. While there is nothing to say, the
  // engine's own hint line (its mode label and shortcuts) stays as it is.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const tip = await read($, review)
    const other = await read($, otherLanguage)
    if (!tip && other === '') return next(e)

    const { Box, Text } = $.ui.resolve(e)

    // Fixes come first; with none, the improvements take the row. What does not fit is counted.
    const isFix = (tip?.fixes.length ?? 0) > 0
    const list = tip ? (isFix ? tip.fixes : tip.improvements) : []
    const { shown, more } = fitPairs(list)
    const extra = isFix ? (tip?.improvements.length ?? 0) : 0
    const label = isFix ? (list.length === 1 ? 'fix' : 'fixes') : list.length === 1 ? 'improvement' : 'improvements'

    return (
      <Box>
        <Text>🎓 </Text>
        <Text color="blue" weight="bold">
          english-companion
        </Text>
        <Text>{'  '}</Text>
        {tip ? (
          <Box>
            <Text weight="bold" color="white">{`${isFix ? '📝' : '✨'} ${list.length} ${label}: `}</Text>
            {shown.map((change, i) => (
              <Box key={change.from}>
                {i > 0 && <Text dimColor>{' · '}</Text>}
                <Text color={isFix ? 'red' : undefined}>{clip(change.from, WORD)}</Text>
                <Text>{' → '}</Text>
                <Text color={isFix ? 'green' : 'magenta'}>
                  {change.to.length <= WORD
                    ? changedPieces(change.from, change.to).map(piece => (piece.underline ? <Text underline>{piece.text}</Text> : piece.text))
                    : clip(change.to, WORD)}
                </Text>
              </Box>
            ))}
            {more > 0 && <Text dimColor>{` +${more}`}</Text>}
            {extra > 0 && <Text color="magenta">{`  ✨ +${extra}`}</Text>}
            <Text dimColor>{`   ${KEYS}`}</Text>
          </Box>
        ) : (
          <Box>
            <Text backgroundColor="yellow" color="black" weight="bold">
              {` 🌐 ${other.toUpperCase()} → ${target.code.toUpperCase()} `}
            </Text>
            <Text color="yellow">{` write in ${target.name}`}</Text>
          </Box>
        )}
      </Box>
    )
  })

  // The details, in the band above the prompt: every fix and improvement with its reason. The
  // reviewer can color the words it wants you to notice. Drawn only after `1`.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const tip = await read($, review)
    if (e.props.hasSurvey || !tip || !(await read($, isExpanded))) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)

    // One block per kind, a blank row after each: 📝 fixes, then ✨ improvements.
    const kinds = [
      { icon: '📝', list: tip.fixes, from: 'red', to: 'green' },
      { icon: '✨', list: tip.improvements, from: undefined, to: 'magenta' },
    ]

    return (
      <Box flexDirection="column" marginTop={1} marginBottom={1} paddingX={1} borderStyle="round" borderColor="cyan">
        <Box marginBottom={1}>
          <Text weight="bold">🎓 english-companion</Text>
        </Box>
        {kinds.map(kind =>
          kind.list.length > 0 ? (
            <Box key={kind.icon} flexDirection="column" marginBottom={1}>
              {kind.list.map(change => (
                <Box key={change.from} flexDirection="column">
                  <Box>
                    <Text>{`${kind.icon} `}</Text>
                    <Text color={kind.from}>{change.from}</Text>
                    <Text> → </Text>
                    <Text color={kind.to}>
                      {changedPieces(change.from, change.to).map(piece => (piece.underline ? <Text underline>{piece.text}</Text> : piece.text))}
                    </Text>
                  </Box>
                  <Text dimColor>
                    {'   '}
                    {highlights(change.why).map(piece =>
                      piece.color || piece.underline || piece.strike ? (
                        <Text color={piece.color} underline={piece.underline} strikethrough={piece.strike} dimColor={false} weight="bold">
                          {piece.text}
                        </Text>
                      ) : (
                        piece.text
                      ),
                    )}
                  </Text>
                </Box>
              ))}
            </Box>
          ) : null,
        )}
        <Button hotkey="2" plain onPress={() => clearTip($)}>
          Close
        </Button>
      </Box>
    )
  })
}
