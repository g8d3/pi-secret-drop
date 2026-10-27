# pi-secret-drop

Secrets enter through a private UI dialog and land in a `0600` env file.
Values never touch the transcript — only metadata (name, length, time).

Install:

```bash
pi install git:github.com/g8d3/pi-secret-drop
```

Then, from any session:

- `secret_drop` (tool, or `/secret-drop NAME` command) — I pop an input,
  you paste, it lands in `~/.config/echolike/store-secrets.env`. Nothing in chat.
- `secret_exec` (tool, or `/secret-exec NAME program args...`) — run with the
  secret as env; output comes back scrubbed.
- `secret_list` / `secret_forget` — audit and rotate (names only, never values).

Rules: scoped API tokens only, never account passwords. Anything pasted in chat
lands in session logs; this path never puts the value in a message, tool result,
entry, notification, or log. Override path with `PI_SECRETS_FILE`.

Limit: Pi's `input` dialog has no password-mask flag, so shield the screen while
pasting. The value is single-shot: dialog → file, never rendered back.
