"""Serves web/ for development without caching, so an edit shows on reload.

    python3 scripts/serve.py [port]
"""
import functools
import http.server
import pathlib
import sys


class NoStore(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
web = pathlib.Path(__file__).resolve().parent.parent / "web"
handler = functools.partial(NoStore, directory=str(web))
http.server.ThreadingHTTPServer(("127.0.0.1", port), handler).serve_forever()
