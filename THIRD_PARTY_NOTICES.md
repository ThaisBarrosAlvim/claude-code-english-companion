# Third-party notices

## fastText language identification model (`model/lid.176.ftz`)

- **What:** the compressed language-identification model from fastText (917 kB, 176 languages),
  redistributed here unchanged.
- **Source:** <https://fasttext.cc/docs/en/language-identification>
- **Author:** Facebook AI Research (fastText).
- **License:** [Creative Commons Attribution-ShareAlike 3.0](https://creativecommons.org/licenses/by-sa/3.0/)
  (CC BY-SA 3.0). The license of this repository (MIT) covers the mod's code only; this one file stays
  under CC BY-SA 3.0, and so would any copy of it you redistribute.

## fastText library

Not used or bundled. `server/ftz.py` is an independent, dependency-free reimplementation in Python
of how fastText reads and evaluates a supervised model file, following fastText's algorithm and
checked against the official library's answers (`test/golden.json`).
