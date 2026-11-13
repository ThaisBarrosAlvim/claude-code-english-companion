"""Pure-Python reader and predictor for fastText supervised models (the `.ftz` language-id model).

No dependencies, no native code: it needs only the Python standard library, so the language
server runs unchanged on any machine that has `python3`, with no pip install and no compiler or
shared-library trouble. It implements exactly what `lid.176.ftz` uses: format version 12, a
product-quantized input matrix with quantized norms, a dense output matrix, and the hierarchical
softmax loss, with subword (character n-gram) hashing. Other fastText model kinds (softmax
loss, quantized output, word n-grams) are not supported and raise ValueError.

It follows fastText's algorithm (dictionary and subword hashing, quantized matrices, the label
tree of the hierarchical softmax); test/golden.json pins its answers to the official library's.

    model = FastTextModel("lid.176.ftz")
    model.predict("eu acho que voce deveria fazer isso", k=3)
    # [("__label__pt", 0.998...), ("__label__gl", 0.0...), ...]
"""

import math
import struct
import sys
from array import array

_MAGIC = 793712314
_LOSS_HS = 1  # fastText's loss_name enum: hs=1, ns=2, softmax=3, ova=4
_MODEL_SUPERVISED = 3  # model_name enum: cbow=1, sa=2, sup=3
_EOS = b"</s>"
_WHITESPACE = frozenset(b" \n\r\t\v\f\0")
_ENTRY_LABEL = 1
_MAX_LINE_TOKENS = 1024  # fastText stops reading a line after this many tokens
_LOG_EPS = 1e-5  # fastText's std_log adds this before every log


def _fnv1a(data: bytes) -> int:
    """fastText's hash: 32-bit FNV-1a over bytes sign-extended like a C `int8_t`."""
    h = 2166136261
    for c in data:
        h ^= (c - 256 if c > 127 else c) & 0xFFFFFFFF
        h = (h * 16777619) & 0xFFFFFFFF
    return h


def _floats(raw: bytes) -> array:
    values = array("f")
    values.frombytes(raw)
    if sys.byteorder == "big":  # the file is little-endian
        values.byteswap()
    return values


class _Reader:
    def __init__(self, data: bytes) -> None:
        self.data = data
        self.pos = 0

    def take(self, n: int) -> bytes:
        chunk = self.data[self.pos : self.pos + n]
        if len(chunk) != n:
            raise ValueError("truncated model file")
        self.pos += n
        return chunk

    def i32(self) -> int:
        return struct.unpack("<i", self.take(4))[0]

    def i64(self) -> int:
        return struct.unpack("<q", self.take(8))[0]

    def u8(self) -> int:
        return self.take(1)[0]

    def cstring(self) -> bytes:
        end = self.data.index(b"\0", self.pos)
        word = self.data[self.pos : end]
        self.pos = end + 1
        return word


class _ProductQuantizer:
    """Centroids of a product quantizer: `nsubq` sub-vectors of `dsub` floats, 256 codes each."""

    def __init__(self, r: _Reader) -> None:
        self.dim, self.nsubq, self.dsub, self.lastdsub = r.i32(), r.i32(), r.i32(), r.i32()
        self.centroids = _floats(r.take(self.dim * 256 * 4))


class FastTextModel:
    def __init__(self, path: str) -> None:
        with open(path, "rb") as fh:
            r = _Reader(fh.read())

        if r.i32() != _MAGIC:
            raise ValueError("not a fastText model")
        version = r.i32()
        if version > 12:
            raise ValueError(f"unsupported fastText model version {version}")

        names = "dim ws epoch minCount neg wordNgrams loss model bucket minn maxn lrUpdateRate".split()
        args = {name: r.i32() for name in names}
        r.take(8)  # `t`, a double: only training uses it
        if args["model"] != _MODEL_SUPERVISED or args["loss"] != _LOSS_HS or args["wordNgrams"] != 1:
            raise ValueError("only supervised hierarchical-softmax models without word n-grams are supported")
        self.dim = args["dim"]
        self.bucket = args["bucket"]
        self.minn = args["minn"]
        self.maxn = args["maxn"]

        # Dictionary: every word and label, then the map from pruned hash buckets to rows.
        size, self.nwords, nlabels = r.i32(), r.i32(), r.i32()
        r.i64()  # ntokens
        pruneidx_size = r.i64()
        self.word2id = {}
        self.labels = []
        label_counts = []
        for i in range(size):
            word, count, kind = r.cstring(), r.i64(), r.u8()
            if kind == _ENTRY_LABEL:
                self.labels.append(word.decode("utf-8"))
                label_counts.append(count)
            else:
                self.word2id[word] = i
        if len(self.labels) != nlabels:
            raise ValueError("inconsistent label count")
        self.prune = {}
        for _ in range(pruneidx_size):
            bucket_id, row = r.i32(), r.i32()
            self.prune[bucket_id] = row
        if pruneidx_size <= 0:
            raise ValueError("only pruned (quantized) models are supported")

        # Input matrix: product-quantized, one code per sub-vector, with a quantized norm per row.
        if not r.u8():
            raise ValueError("only quantized input matrices are supported")
        qnorm = r.u8()
        self.rows, cols = r.i64(), r.i64()
        codesize = r.i32()
        if cols != self.dim:
            raise ValueError("inconsistent input matrix")
        self.codes = r.take(codesize)
        self.pq = _ProductQuantizer(r)
        if codesize != self.rows * self.pq.nsubq or self.pq.dim != self.dim:
            raise ValueError("inconsistent quantization")
        self.norm_codes = r.take(self.rows) if qnorm else None
        self.norm_centroids = _ProductQuantizer(r).centroids if qnorm else None

        # Output matrix: one row per inner node of the label tree, dense floats.
        if r.u8():
            raise ValueError("quantized output matrices are not supported")
        out_rows, out_cols = r.i64(), r.i64()
        if out_cols != self.dim or out_rows != nlabels:
            raise ValueError("inconsistent output matrix")
        self.output = _floats(r.take(out_rows * out_cols * 4))
        if r.pos != len(r.data):
            raise ValueError("unexpected data after the model")

        self._build_tree(label_counts)

    def _build_tree(self, counts: list) -> None:
        """Huffman tree over the labels, built the way fastText builds it (loss.cc)."""
        osz = len(counts)
        total = 2 * osz - 1
        self.osz = osz
        self.left = [-1] * total
        self.right = [-1] * total
        count = list(counts) + [10**15] * (osz - 1)
        leaf, node = osz - 1, osz
        for i in range(osz, total):
            picked = []
            for _ in range(2):
                if leaf >= 0 and count[leaf] < count[node]:
                    picked.append(leaf)
                    leaf -= 1
                else:
                    picked.append(node)
                    node += 1
            self.left[i], self.right[i] = picked
            count[i] = count[picked[0]] + count[picked[1]]
        self.root = total - 1

    def _subword_ids(self, token: bytes) -> list:
        """Rows of the hashed character n-grams of `<token>`, pruned like the dictionary says."""
        ids = []
        word = b"<" + token + b">"
        n = len(word)
        for i in range(n):
            if (word[i] & 0xC0) == 0x80:  # inside a UTF-8 sequence
                continue
            j = i
            for length in range(1, self.maxn + 1):
                if j >= n:
                    break
                j += 1
                while j < n and (word[j] & 0xC0) == 0x80:
                    j += 1
                if length >= self.minn and not (length == 1 and (i == 0 or j == n)):
                    row = self.prune.get(_fnv1a(word[i:j]) % self.bucket)
                    if row is not None:
                        ids.append(self.nwords + row)
        return ids

    def _input_ids(self, text: str) -> list:
        ids = []
        tokens = 0
        word = bytearray()

        def flush() -> None:
            token = bytes(word)
            word.clear()
            wid = self.word2id.get(token)
            if wid is not None:
                ids.append(wid)
            if token != _EOS:
                ids.extend(self._subword_ids(token))

        for c in text.encode("utf-8"):
            if c in _WHITESPACE:
                if word:
                    flush()
                    tokens += 1
                    if tokens >= _MAX_LINE_TOKENS:
                        return ids
            else:
                word.append(c)
        if word:
            flush()
        # The official predict reads the text as one line and so ends it with the end-of-line
        # token, which counts in the average like any word.
        eos = self.word2id.get(_EOS)
        if eos is not None:
            ids.append(eos)
        return ids

    def _hidden(self, ids: list) -> list:
        pq = self.pq
        nsubq, dsub = pq.nsubq, pq.dsub
        centroids = pq.centroids
        hidden = [0.0] * self.dim
        for i in ids:
            norm = self.norm_centroids[self.norm_codes[i]] if self.norm_codes is not None else 1.0
            base = i * nsubq
            for m in range(nsubq):
                at = (m * 256 + self.codes[base + m]) * dsub
                for d in range(dsub):
                    hidden[m * dsub + d] += norm * centroids[at + d]
        scale = 1.0 / len(ids)
        return [x * scale for x in hidden]

    def predict(self, text: str, k: int = 1) -> list:
        """The `k` most likely labels as `(label, probability)`, best first; [] for no usable text."""
        ids = self._input_ids(text)
        if not ids:
            return []
        hidden = self._hidden(ids)
        dim, output, osz = self.dim, self.output, self.osz

        scored = []
        stack = [(self.root, 0.0)]
        while stack:  # walk the whole tree: 176 labels are cheap to score exactly
            node, score = stack.pop()
            if self.left[node] == -1 and self.right[node] == -1:
                scored.append((score, node))
                continue
            at = (node - osz) * dim
            f = sum(hidden[d] * output[at + d] for d in range(dim))
            f = 1.0 / (1.0 + math.exp(-f)) if f > -700 else 0.0
            stack.append((self.left[node], score + math.log(1.0 - f + _LOG_EPS)))
            stack.append((self.right[node], score + math.log(f + _LOG_EPS)))

        scored.sort(reverse=True)
        return [(self.labels[node], math.exp(score)) for score, node in scored[:k]]
