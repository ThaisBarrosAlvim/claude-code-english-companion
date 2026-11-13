// One suggested change: a piece of the draft, how it should read instead, and why.
export type Change = { from: string; to: string; why: string }

// What the model said about a submitted draft: `fixes` are clear mistakes (spelling, grammar, a
// wrong word), `improvements` are pieces that are correct but would sound unnatural to a native
// speaker. At most two of each. Shown on the hint row and in the details band.
export type Review = { fixes: Change[]; improvements: Change[] }

declare module 'claude-code' {
  interface PluginState {
    // `review` is the tip being shown, null when there is none (shaped: a review stored by an
    // earlier version of the mod is read as absent); `isExpanded` says whether the details band
    // above the prompt is open; `otherLanguage` is the language code of the draft being typed
    // when it is not the language you chose, empty otherwise. The hint row under the prompt
    // draws from these.
    'english-companion': { review: Shaped<Review | null>; isExpanded: boolean; otherLanguage: string }
  }
}
