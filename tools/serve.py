"""Serve the web app locally for development.

Like `python -m http.server`, but every response carries
`Cache-Control: no-cache`, so the browser checks each file again on every
load. Without it, Safari in particular keeps using its stored copy of an
edited JavaScript module and shows a model built by the old code.

    python3 tools/serve.py            # http://localhost:8765, serving web/
    python3 tools/serve.py 8000
"""
import functools
import http.server
import sys
from pathlib import Path

WEB = Path(__file__).resolve().parent.parent / "web"


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    handler = functools.partial(NoCacheHandler, directory=str(WEB))
    with http.server.ThreadingHTTPServer(("", port), handler) as httpd:
        print(f"Serving {WEB} at http://localhost:{port} (no-cache)", flush=True)
        httpd.serve_forever()


if __name__ == "__main__":
    main()
