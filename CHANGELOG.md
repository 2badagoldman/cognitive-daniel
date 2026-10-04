# Changelog

## 7.0.0
- Cognitive Trader: broker adapters (Alpaca, Tradier, OANDA, Coinbase Advanced, Kraken, IBKR beta, built-in simulator), risk engine, indicators, backtester, agent with confirm-to-execute tickets, Trading view (`api/trading.js`, `api/_trading.js`).
- Sign in with GitHub; per-user GitHub tokens for repos and PRs (`api/auth.js`, `api/_auth.js`).
- Sign in with Google; Google users can link GitHub. First sign-in creates the account.
- After GitHub sign-in the repository picker opens automatically.
- Repository picker: signed-in users choose from their GitHub repos instead of pasting URLs (`/api/repo?action=list`).
- Cognitive Personal agent with memory and connections: Google, Microsoft, X, Twilio SMS, Home Assistant (`api/personal.js`, `api/_personal.js`). Outbound actions require user confirmation.
- Verification integrity: finish is rejected when existing test files were edited or deleted, or when the test command is trivial.
- Automatic toolchain bootstrap for Go, Java/Maven, Rust, Python and Ruby repos.
- Access control: closed by default, per-route rate limits, wrong-code lockout, constant-time compare.
- UI: missing-key banner, no auto-retry on auth errors, Wiki errors shown inline, Personal view, account row in Settings.
- `.vercelignore` excludes `*.zip` so archives are never served from the site.
- Unit tests under `test/` (`npm test`).

## 6.0.0
- Imported from the Vercel production deployment.
