# Security

postil runs a local HTTP and WebSocket server that can read your repository and write to your
working tree (to apply suggestions). It is built to be reachable only from your own machine:

- The server listens on `127.0.0.1` only.
- Every request needs a random bearer token, stored in `.git/postil/` with owner-only permissions.
  The browser receives it in the URL fragment, which is never sent to the server, and removes it
  from the address bar.
- Requests with an unrecognised `Host` header are rejected, which blocks DNS rebinding, and the
  WebSocket refuses connections from pages on other sites.
- Raw file previews are served under a sandboxing content security policy, so a malicious SVG in a
  diff cannot run script on postil's origin.

## Reporting a vulnerability

Please report security problems privately, through GitHub's
[private vulnerability reporting](https://github.com/sakian/postil/security/advisories/new),
rather than in a public issue. Include the steps to reproduce and the postil version
(`postil --version` prints it).
