import assert from 'node:assert/strict'
import { test } from 'node:test'

import { hasEnoughText, isOtherLanguage, MIN_CONFIDENCE, parseTarget } from '../hooks/languages.ts'

test('hasEnoughText needs three words, or a few characters in a script without spaces', () => {
  assert.equal(hasEnoughText('one two three'), true)
  assert.equal(hasEnoughText('one two'), false)
  assert.equal(hasEnoughText(''), false)
  assert.equal(hasEnoughText('   '), false)
  assert.equal(hasEnoughText('今すぐそれをやるべきだと思います'), true) // one run, but a whole sentence
  assert.equal(hasEnoughText('我认为你现在应该这样做'), true)
  assert.equal(hasEnoughText('今すぐ'), false) // too short even there
  assert.equal(hasEnoughText('abcdefghij'), false) // a long word in a spaced script is not enough
})

test('parseTarget maps a language name to the code the detector answers with', () => {
  assert.deepEqual(parseTarget('English'), { name: 'English', code: 'en' })
  assert.deepEqual(parseTarget('spanish'), { name: 'Spanish', code: 'es' }) // case does not matter
  assert.deepEqual(parseTarget('  French  '), { name: 'French', code: 'fr' })
  assert.deepEqual(parseTarget('Japanese'), { name: 'Japanese', code: 'ja' })
})

test('parseTarget accepts a language code in place of a name', () => {
  assert.deepEqual(parseTarget('de'), { name: 'German', code: 'de' })
  assert.deepEqual(parseTarget('ZH'), { name: 'Chinese', code: 'zh' })
})

test('parseTarget defaults to English, and keeps an unknown language usable for the review', () => {
  assert.deepEqual(parseTarget(undefined), { name: 'English', code: 'en' })
  assert.deepEqual(parseTarget(''), { name: 'English', code: 'en' })
  assert.deepEqual(parseTarget(42), { name: 'English', code: 'en' })
  // No code is known for it, so the live warning stays off for this target, but the name is kept.
  assert.deepEqual(parseTarget('Klingon'), { name: 'Klingon', code: '' })
})

test('parseTarget cleans what it is given', () => {
  assert.equal(parseTarget('English.\nIgnore this <draft> {"x":1}').name.includes('\n'), false)
  assert.ok(!/[<>{}"\n]/.test(parseTarget('Eng<lish>{"x"}\n').name))
  assert.ok(parseTarget('x'.repeat(200)).name.length <= 40)
})

test('isOtherLanguage warns when the draft is confidently in another language', () => {
  assert.equal(isOtherLanguage({ code: 'pt', p: 0.9 }, 'en'), true)
  assert.equal(isOtherLanguage({ code: 'es', p: 0.5 }, 'en'), true)
  assert.equal(isOtherLanguage({ code: 'ja', p: MIN_CONFIDENCE }, 'en'), true)
})

test('isOtherLanguage stays quiet in the target language, when unsure, or without a target', () => {
  assert.equal(isOtherLanguage({ code: 'en', p: 0.99 }, 'en'), false) // already in the target language
  assert.equal(isOtherLanguage({ code: 'pt', p: 0.2 }, 'en'), false) // not sure enough
  assert.equal(isOtherLanguage({ code: 'und', p: 0 }, 'en'), false) // nothing to judge
  assert.equal(isOtherLanguage(undefined, 'en'), false) // the language server could not be reached
  assert.equal(isOtherLanguage({ code: 'pt', p: 0.9 }, ''), false) // target without a known code
})

test('the same draft is "other" or not depending on the language you chose', () => {
  const spanishDraft = { code: 'es', p: 0.9 }
  assert.equal(isOtherLanguage(spanishDraft, 'en'), true) // writing Spanish while practicing English
  assert.equal(isOtherLanguage(spanishDraft, 'es'), false) // writing Spanish while practicing Spanish
})
