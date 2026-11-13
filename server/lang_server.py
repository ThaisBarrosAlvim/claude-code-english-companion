#!/usr/bin/env python3
"""english-companion language server: tells the mod which language a prompt draft is written in.

Keeps the 917 kB fastText language-id model in memory and answers over a Unix socket, so the
mod's `prompt.edit` hook gets an answer in milliseconds instead of paying for a process start
on every keystroke burst. The model is read and evaluated by ftz.py, pure Python with no
dependencies, so this runs on any machine with python3.

Started by the mod when nobody answers on the socket. It detaches itself (double fork), so it
outlives the chat that started it and every open chat shares the one process, and it exits on
its own after --idle seconds without a request. Stateless: each request carries its own text.

    python lang_server.py --sock PATH --model PATH [--idle SECONDS] [--foreground]

The launcher exits 0 once the socket is listening, or at once with "already running" when
another server holds the lock; it exits non-zero, with the reason on stderr, when it cannot
start (4: the model cannot be loaded).

Wire format, HTTP over the socket:
    POST /  body = draft text (UTF-8)
    200     {"lang": "es", "p": 0.97, "top": [["es", 0.97], ["pt", 0.01], ["gl", 0.01]]}

`lang` and `p` are the most likely language (a code of the model's 176) and how sure it is; `top`
holds the three most likely. "und" means there was nothing to judge.
"""

import argparse
import asyncio
import fcntl
import json
import os
import re
import signal
import socket
import sys
import time

from ftz import FastTextModel

MAX_BODY = 8192  # a draft longer than this is cut: its first characters decide the language

# Things that say nothing about the human language: fenced and inline code, URLs, paths,
# identifiers. Removed before classifying so a pasted traceback does not read as English.
_NOISE = re.compile(r"```.*?```|`[^`]*`|https?://\S+|[~./]\S*/\S*|\b\w*[_\\]\w*\b", re.S)


def classify(model, text: str) -> dict:
    clean = _NOISE.sub(" ", text[:MAX_BODY])
    clean = " ".join(clean.split())  # fastText refuses newlines
    best = model.predict(clean, k=3) if clean else []
    if not best:
        return {"lang": "und", "p": 0.0, "top": []}
    top = [[label.replace("__label__", ""), round(p, 4)] for label, p in best]
    return {"lang": top[0][0], "p": top[0][1], "top": top}


def daemonize() -> None:
    """Detach from the launcher: the chat that started us may close, we must not die with it."""
    if os.fork() > 0:
        os._exit(0)
    os.setsid()
    if os.fork() > 0:
        os._exit(0)
    os.chdir("/")
    devnull = os.open(os.devnull, os.O_RDWR)
    for fd in (0, 1, 2):
        os.dup2(devnull, fd)


async def serve(srv: socket.socket, model, idle: int, sock_path: str) -> None:
    last = time.monotonic()
    stop = asyncio.Event()

    async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        nonlocal last
        last = time.monotonic()
        try:
            head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), timeout=2)
            m = re.search(rb"content-length:\s*(\d+)", head, re.I)
            n = min(int(m.group(1)), MAX_BODY * 4) if m else 0
            body = await asyncio.wait_for(reader.readexactly(n), timeout=2) if n else b""
            out = json.dumps(classify(model, body.decode("utf-8", "replace"))).encode()
            status = b"200 OK"
        except Exception as exc:  # one bad request must not take the server down
            out = json.dumps({"error": type(exc).__name__}).encode()
            status = b"400 Bad Request"
        writer.write(
            b"HTTP/1.1 " + status + b"\r\nContent-Type: application/json\r\n"
            b"Content-Length: " + str(len(out)).encode() + b"\r\nConnection: close\r\n\r\n" + out
        )
        try:
            await writer.drain()
        finally:
            writer.close()

    async def watchdog() -> None:
        tick = max(1, min(30, idle // 4))
        while not stop.is_set():
            await asyncio.sleep(tick)
            if time.monotonic() - last > idle:
                stop.set()

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stop.set)

    server = await asyncio.start_unix_server(handle, sock=srv)
    if idle > 0:
        asyncio.create_task(watchdog())
    await stop.wait()
    server.close()
    try:
        os.unlink(sock_path)
    except FileNotFoundError:
        pass


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--sock", required=True, help="Unix socket path to listen on")
    ap.add_argument("--model", required=True, help="fastText language-id model (lid.176.ftz)")
    ap.add_argument("--idle", type=int, default=1800, help="exit after this many idle seconds; 0 = never")
    ap.add_argument("--foreground", action="store_true", help="do not detach (service managers, tests)")
    args = ap.parse_args()

    sock_dir = os.path.dirname(os.path.abspath(args.sock))
    os.makedirs(sock_dir, mode=0o700, exist_ok=True)

    # One server per socket: whoever holds the lock serves, the others leave.
    lock_fd = os.open(args.sock + ".lock", os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print("already running")
        return 0

    try:
        model = FastTextModel(args.model)
    except (OSError, ValueError) as exc:
        print(f"cannot load the model {args.model}: {exc}", file=sys.stderr)
        return 4

    # Listen before detaching, so the launcher's exit means "ready".
    if os.path.exists(args.sock):
        os.unlink(args.sock)  # stale socket from a server that died
    srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    old_umask = os.umask(0o177)  # socket file ends up 0600: only this user can ask
    try:
        srv.bind(args.sock)
    finally:
        os.umask(old_umask)
    srv.listen(64)
    srv.setblocking(False)

    if not args.foreground:
        daemonize()
    asyncio.run(serve(srv, model, args.idle, args.sock))
    return 0


if __name__ == "__main__":
    sys.exit(main())
