import http.server
import socketserver
import os
import urllib.parse

PORT = 8000
DIRECTORY = os.path.dirname(os.path.abspath(__file__))

class CleanUrlHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        clean_path = parsed.path
        local_path = self.translate_path(clean_path)
        
        if not os.path.exists(local_path) and os.path.exists(local_path + '.html'):
            if parsed.query:
                self.path = clean_path + '.html?' + parsed.query
            else:
                self.path = clean_path + '.html'
        return super().do_GET()

if __name__ == '__main__':
    with http.server.ThreadingHTTPServer(("0.0.0.0", PORT), CleanUrlHandler) as httpd:
        print(f"Server running at http://localhost:{PORT}")
        httpd.serve_forever()
