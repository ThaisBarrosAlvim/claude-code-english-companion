// Which language you want to write in, and whether a draft is in another one.
//
// The language model answers with a language code ("en", "es", "pt"...); the `targetLanguage`
// setting is a name ("English"). This file maps one to the other for the languages people most
// often write in, and also accepts a code directly, so any of the model's languages can be the
// target. It imports nothing local, so the tests can load it on its own.

// How sure the model must be that the draft is in a different language before a warning shows.
// It is low on purpose: the model is unsure about short text full of technical terms.
export const MIN_CONFIDENCE = 0.3

const CODES: Record<string, string> = {
  english: 'en',
  spanish: 'es',
  portuguese: 'pt',
  french: 'fr',
  german: 'de',
  italian: 'it',
  dutch: 'nl',
  russian: 'ru',
  ukrainian: 'uk',
  polish: 'pl',
  czech: 'cs',
  slovak: 'sk',
  hungarian: 'hu',
  romanian: 'ro',
  bulgarian: 'bg',
  serbian: 'sr',
  croatian: 'hr',
  slovenian: 'sl',
  lithuanian: 'lt',
  latvian: 'lv',
  estonian: 'et',
  greek: 'el',
  turkish: 'tr',
  hebrew: 'he',
  arabic: 'ar',
  persian: 'fa',
  hindi: 'hi',
  bengali: 'bn',
  urdu: 'ur',
  tamil: 'ta',
  telugu: 'te',
  thai: 'th',
  vietnamese: 'vi',
  indonesian: 'id',
  malay: 'ms',
  chinese: 'zh',
  japanese: 'ja',
  korean: 'ko',
  swedish: 'sv',
  norwegian: 'no',
  danish: 'da',
  finnish: 'fi',
  icelandic: 'is',
  catalan: 'ca',
  galician: 'gl',
  basque: 'eu',
  irish: 'ga',
  welsh: 'cy',
  latin: 'la',
  esperanto: 'eo',
  swahili: 'sw',
  afrikaans: 'af',
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

// The same table the other way round: "es" → "Spanish".
const NAMES: Record<string, string> = Object.fromEntries(Object.entries(CODES).map(([name, code]) => [code, capitalized(name)]))

export type Target = {
  name: string // as the person wrote it, for messages: "English"
  code: string // what the language model answers with: "en"; empty when the language is not known
}

// The `targetLanguage` setting: a language name from the table above, or a language code. An
// unknown name still works for the review; only the live warning needs the code, and it stays
// off without one.
export function parseTarget(value: unknown): Target {
  const text = typeof value === 'string' ? value.replace(/[^\p{L} -]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 40) : ''
  const name = capitalized(text || 'English')
  const key = name.toLowerCase()

  const code = CODES[key]
  if (code) return { name, code }

  const named = NAMES[key] // a code was written instead of a name
  if (named) return { name: named, code: key }

  return { name, code: '' }
}

// Scripts written without spaces between words: a sentence is one long run of letters there.
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u

// Whether a draft holds enough text for a language guess to mean something: three words, or, in a
// script without spaces, a handful of characters. Anything shorter is a coin flip.
export function hasEnoughText(draft: string): boolean {
  if (draft.split(/\s+/).filter(Boolean).length >= 3) return true
  return UNSPACED.test(draft) && Array.from(draft.replace(/\s+/g, '')).length >= 6
}

export type Detected = { code: string; p: number }

// True when the model is sure enough that the draft is not in the language you want to write in.
export function isOtherLanguage(detected: Detected | undefined, targetCode: string): boolean {
  if (!detected || targetCode === '') return false
  if (detected.code === targetCode || detected.code === 'und') return false
  return detected.p >= MIN_CONFIDENCE
}
