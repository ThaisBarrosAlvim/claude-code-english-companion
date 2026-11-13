"""Checks the pure-Python fastText predictor against the official library's answers.

golden.json holds what the official fastText library (fasttext-predict 0.9.2.4) answers for
model/lid.176.ftz on 94 texts: the top three labels and their probabilities. Run with
`python3 -m unittest discover -s test`; nothing but the standard library is needed.
"""

import json
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "server"))

from ftz import FastTextModel  # noqa: E402

MODEL = FastTextModel(os.path.join(ROOT, "model", "lid.176.ftz"))
with open(os.path.join(ROOT, "test", "golden.json"), encoding="utf-8") as fh:
    GOLDEN = json.load(fh)["cases"]


class MatchesOfficialLibrary(unittest.TestCase):
    def test_top_three_labels_and_probabilities(self):
        for case in GOLDEN:
            with self.subTest(text=case["text"][:50]):
                got = MODEL.predict(" ".join(case["text"].split()), k=3)
                self.assertEqual([label for label, _ in got], [label for label, _ in case["top"]])
                for (_, p), (_, expected) in zip(got, case["top"]):
                    self.assertAlmostEqual(p, expected, delta=1e-4)

    def test_portuguese_and_english(self):
        self.assertEqual(MODEL.predict("eu acho que você deveria fazer isso agora")[0][0], "__label__pt")
        self.assertEqual(MODEL.predict("please run the tests again")[0][0], "__label__en")

    def test_text_without_words_still_answers(self):
        # Only the end-of-line token is left to average, as in the official library.
        self.assertEqual(len(MODEL.predict("12345 !!! ???", k=3)), 3)
        self.assertEqual(len(MODEL.predict("", k=3)), 3)


class RejectsOtherModels(unittest.TestCase):
    def test_not_a_fasttext_file(self):
        path = os.path.join(ROOT, "README.md")
        with self.assertRaises(ValueError):
            FastTextModel(path)


if __name__ == "__main__":
    unittest.main()
