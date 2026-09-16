# nfi-tools

CLI tool and MCP server for handling sensitive information without exposing secret values to AI assistants.

When you tell an AI assistant "add my Stripe key to .env", the assistant calls `nfi` which opens a browser-based prompt for you to enter the secret. The value goes straight into the file -- the AI never sees it.

## Install

```bash
npm install -g nfi-tools
```

Or use without installing:

```bash
npx nfi-tools set .env STRIPE_SECRET_KEY
```

## How it works

1. You tell the AI: "Add my Stripe secret key to `.env`"
2. The AI runs: `nfi set .env STRIPE_SECRET_KEY`
3. A browser tab opens with a password input form
4. You paste your secret (password managers work here)
5. The tool writes `STRIPE_SECRET_KEY=sk_live_...` to `.env`
6. The AI only sees: "Wrote 1 secret to .env"

The secret never enters the AI's context window. The browser-based input also means you can paste straight from 1Password, Bitwarden, LastPass, or your browser's built-in password manager. Autofill is deliberately suppressed on the page, since the one-off URL never matches a saved login anyway.

## Commands

### Set secrets

```bash
nfi set .env STRIPE_SECRET_KEY                    # single secret
nfi set .env STRIPE_SECRET_KEY DATABASE_URL       # multiple secrets in one form
nfi set config.json database.password             # nested key in JSON
nfi set config.yaml api.key --overwrite           # overwrite existing
```

### Check if a key exists

```bash
nfi has API_KEY .env        # exit code 0 if exists, 1 if not
nfi has API_KEY .env -q     # quiet mode, exit code only
```

### List keys (no values)

```bash
nfi keys .env                     # flat list for .env
nfi keys config.json              # leaf paths: database.host, database.port, ...
nfi keys config.json --depth 1    # top-level only: database, api, ...
```

### Diff keys between files

```bash
nfi diff .env .env.example        # what's missing from each
```

### Remove a key

```bash
nfi remove API_KEY .env           # deletes the line entirely
```

### Copy a secret between files

```bash
nfi copy DATABASE_URL .env config.json --path database.url
```

The value is read and written internally -- it never appears in stdout.

### Generate random secrets

```bash
nfi generate SESSION_SECRET .env                        # default: hex, 64 chars
nfi generate APP_KEY .env --template uuid               # UUID v4
nfi generate TOKEN .env --template base64:32            # base64, 32 chars
nfi generate SECRET .env --template alphanumeric:48     # alphanumeric, 48 chars
nfi generate KEY .env --dry-run                         # preview without writing
```

## Supported formats

| Format | Detection | Notes |
|--------|-----------|-------|
| `.env` | `.env`, `.env.local`, `.env.*` | Preserves comments and blank lines. Handles `export` prefix and inline comments. |
| `.json` | `.json` | Dot notation for nested paths (`database.password`) |
| `.yaml` / `.yml` | `.yaml`, `.yml` | Dot notation for nested paths |
| `.toml` | `.toml` | Dot notation for nested paths |

Override detection with `--format`:

```bash
nfi set secrets.txt API_KEY --format env
```

## MCP server

For AI clients that support MCP but not shell access (Claude Desktop, Cursor, etc.):

```bash
nfi mcp install                    # auto-detect client
nfi mcp install --client cursor    # specify client
```

This registers `nfi` as an MCP server. The AI can then call tools like `store_secret`, `check_secret`, `list_keys`, and `generate_secret` directly.

Available MCP tools:
- `store_secret` - prompt for secret(s) via browser, write to file
- `check_secret` - check if a key exists (never reveals the value)
- `list_keys` - list all key names in a file
- `diff_keys` - compare keys between two files
- `generate_secret` - generate and write a random secret
- `remove_secret` - remove a key from a file
- `copy_secret` - copy a secret between files
- `describe_capabilities` - list available tools, formats, and templates

## Configuration

Optional config file at `~/.config/nfi/config.json`:

```json
{
  "timeout": 300000,
  "defaultFormat": null,
  "overwriteByDefault": false,
  "inputMethod": "auto",
  "generateTemplate": "hex:64"
}
```

- `timeout` - browser prompt timeout in ms (default: 5 minutes)
- `inputMethod` - `"auto"` (browser with TTY fallback), `"browser"`, or `"tty"`
- `generateTemplate` - default template for `nfi generate`

CLI flags always override config values.

## Global flags

| Flag | Description |
|------|-------------|
| `--format <fmt>` | Override format detection (`env`, `json`, `yaml`, `toml`) |
| `--overwrite` | Allow replacing existing keys |
| `--verbose` | Show detailed output |
| `--quiet` | Suppress output (exit code only) |
| `--timeout <ms>` | Browser prompt timeout |
| `--dry-run` | Preview without writing (generate only) |

## Security

- Secret values never appear in stdout, stderr, or tool return values
- Browser input collected via a temporary localhost server with a one-time token
- Token comparisons use constant-time equality to prevent timing attacks
- POST submissions validated against the Origin header
- Request body size limited to prevent memory exhaustion
- TTY fallback reads from `/dev/tty` directly, bypassing AI-controlled stdin
- If `/dev/tty` is unavailable, the tool errors rather than falling back to stdin
- `.gitignore` warnings when writing to files not covered by `.gitignore`

## Input fallback chain

1. **Browser** - opens a localhost page with password fields (paste from your password manager; autofill is suppressed)
2. **URL relay** - if the browser can't auto-open (MCP/remote), returns a clickable URL
3. **TTY** - direct `/dev/tty` prompt with masked input (SSH sessions, headless environments)

## Requirements

- Node.js 20+
- Also works with Bun

## License

MIT
