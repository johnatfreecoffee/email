# Security

Report vulnerabilities privately: open a GitHub security advisory on this repo. Do not file a public issue for secrets or auth bypasses.

## What this app holds

- Mail (Resend + your database)
- An allowlist of who may talk to coding agents
- API keys in environment variables only

## Rules

- Never commit `.env.local`, `.dev.vars`, or `config.env`
- Worker `config.env` lives on the machine, not in git
- Pages Functions use service-role keys; do not expose them to `NEXT_PUBLIC_*`
- Rotate any key that lands in a gist, chat, or screenshot
