# nfi-tools - Specification

**Package:** `nfi-tools` on npm, bin name `nfi`, MIT license, Node 20+, Bun compatible

A CLI tool and MCP server that allows AI assistants to handle sensitive information (API keys, passwords, secrets) without the secret values ever entering the AI's context window. The tool prompts the user directly via a browser-based UI or TTY, then writes the value to the target file.

The name "nfi" is deliberately ambiguous - it can stand for many things, making it accessible to everyone.

## Commands

| Command | Description |
|---------|-------------|
| `nfi set <file> <key> [key...]` | Prompt for secret(s) via browser UI, write to file |
| `nfi has <key> <file>` | Check if key exists and has non-empty value (exit code 0/1) |
| `nfi keys <file>` | List all key names/leaf paths, no values |
| `nfi diff <file1> <file2>` | Show keys present in one but not the other (same format only v1) |
| `nfi remove <key> <file>` | Delete the key and its line/entry entirely |
| `nfi copy <key> <source> <dest>` | Copy value between local files without exposing it |
| `nfi generate <key> <file>` | Generate and write a random secret |
| `nfi mcp install` | Auto-configure MCP server in Claude Desktop/Cursor/etc. |

## Global Flags

- `--format env|json|yaml|toml` - override format auto-detection
- `--overwrite` - allow replacing existing keys
- `--verbose` - show format detection, file creation, debug info
- `--quiet` - exit code only, no stdout (for scripting)
- `--timeout <ms>` - browser prompt timeout (default 5 minutes / 300000ms)
- `--dry-run` - for generate, show what would be created without writing

## Command-Specific Flags

### `nfi keys`
- `--depth <n>` - limit depth for structured formats (default: show all leaf paths)

### `nfi copy`
- `--path <dotpath>` - target key path in destination file (for structured formats)

### `nfi generate`
- `--template <name>` - generation template (default: `hex:64`)

## Supported Formats

| Format | Detection | Parser |
|--------|-----------|--------|
| `.env` / `.env.*` | File extension | Custom parser (no dependency). Preserves comments and blank lines on write. |
| `.json` | File extension | Built-in `JSON.parse` / `JSON.stringify` |
| `.yaml` / `.yml` | File extension | `yaml` npm package |
| `.toml` | File extension | `smol-toml` npm package |

### Nested Key Paths

For structured formats (JSON, YAML, TOML), dot notation is used for nested paths:

```
nfi set stripe.secretKey config.json
nfi copy DATABASE_URL .env config.json --path database.url
```

Edge case: keys that literally contain dots can be addressed later if needed (bracket notation or escaping).

### .env Parser Behavior

- Preserves all comments and blank lines
- Surgical insertion/replacement (does not rewrite the whole file)
- Handles quoted values, inline comments
- Writes new keys at the end of the file

## Input Collection

Three-tier fallback chain for collecting secret values from the user:

### 1. Browser UI (primary)
- Spins up a temporary localhost HTTP server on a random port
- Generates a one-time token for the URL: `http://localhost:<port>/?token=<token>`
- Attempts to auto-open the user's default browser via `open` (macOS) / `xdg-open` (Linux) / `start` (Windows)
- If auto-open succeeds, the user enters the secret in the browser form

### 2. URL Return (fallback for MCP / no-browser)
- If auto-open fails or the tool is invoked via MCP, the URL is returned in the tool output
- The LLM relays this to the user as a clickable link (e.g., in Claude Desktop)
- The localhost server remains running, waiting for form submission

### 3. TTY Prompt (last resort)
- If no browser is available (SSH sessions, headless environments)
- Prompts via `/dev/tty` directly, bypassing stdin/stdout that the AI controls
- Password-masked input

### Timeout
- Default 5 minutes, configurable via `--timeout` flag and config file
- Returns an error to the caller if the user doesn't respond in time

## Browser UI Design

### Form Layout
- One labeled password input field per requested key
- Show/hide toggle (eye icon) per field, defaulting to hidden
- Keys that already exist in the target file are shown as disabled/greyed out with an "overwrite" checkbox to re-enable
- Single "Save" button at the bottom

### Styling
- Minimal and clean
- Dark mode support via `prefers-color-scheme` media query
- No framework - vanilla HTML/CSS/JS in a single static file

### Post-Submission
- Shows a "Done" success message
- Does not attempt auto-close (unreliable)

### Security
- One-time token in URL prevents other local processes from submitting
- Server shuts down immediately after successful submission or timeout
- Secret value transmitted only over localhost, never leaves the machine

### Password Manager Integration
- Browser-based input lets the user paste from 1Password, Bitwarden, LastPass, macOS Keychain, etc.
- Autofill/save-password prompts are deliberately suppressed (`data-1p-ignore`, `data-lpignore`, `data-bwignore`, `data-form-type="other"`, `autocomplete="off"`) since the one-off localhost/tunnel URL never matches a saved login and would only compete with pasting
- Pasting into the browser field is still a key advantage over native OS dialogs

## MCP Server

### Tools

One tool per command for clear LLM discoverability:

| MCP Tool | Maps to CLI | Parameters |
|----------|-------------|------------|
| `store_secret` | `nfi set` | `keys: string[]`, `file: string`, `format?: string`, `overwrite?: boolean` |
| `check_secret` | `nfi has` | `key: string`, `file: string` |
| `list_keys` | `nfi keys` | `file: string`, `depth?: number` |
| `diff_keys` | `nfi diff` | `file1: string`, `file2: string` |
| `generate_secret` | `nfi generate` | `key: string`, `file: string`, `template?: string`, `dryRun?: boolean` |
| `remove_secret` | `nfi remove` | `key: string`, `file: string` |
| `copy_secret` | `nfi copy` | `key: string`, `source: string`, `dest: string`, `path?: string` |
| `describe_capabilities` | - | none |

### Return Values

All tools return human-readable confirmation messages. Secret values are never included in return values.

| Tool | Success example | Failure examples |
|------|----------------|-----------------|
| `store_secret` | "Wrote STRIPE_KEY to .env" or URL if browser couldn't auto-open | File not found, key exists without overwrite |
| `check_secret` | "STRIPE_KEY exists in .env and has a non-empty value" | File not found, parse error |
| `list_keys` | Array of key names/paths | File not found, parse error |
| `diff_keys` | "Missing from .env: STRIPE_KEY, REDIS_URL. Extra in .env: OLD_KEY" | File not found, format mismatch |
| `generate_secret` | "Generated and wrote SESSION_SECRET to .env (hex, 64 chars)" | File not found, key exists |
| `remove_secret` | "Removed API_KEY from .env" | Key not found |
| `copy_secret` | "Copied DATABASE_URL from .env to config.json at db.url" | Key not found in source |
| `describe_capabilities` | Structured object: commands, formats, templates, config | - |

### Running the MCP Server

```
nfi mcp install              # auto-configure for detected client
nfi mcp install --client cursor  # specify client
```

The MCP server itself runs as: `nfi-tools mcp` (or however the client launches it).

## Generate Templates

### v1 Built-in Templates

| Template | Description | Example |
|----------|-------------|---------|
| `hex:<length>` | Random hex string (default: 64) | `a3f2b1...` |
| `base64:<length>` | Random bytes encoded as base64 | `K8Fj2p...` |
| `uuid` | UUID v4 | `550e8400-e29b-41d4-a716-446655440000` |
| `alphanumeric:<length>` | Random alphanumeric string | `kA9mZ2...` |

Default template when none specified: `hex:64`

### v2 (future)
- Framework-specific templates (BetterAuth, NextAuth, etc.)
- Community-contributed templates
- User-defined templates in config file

## .gitignore Awareness

When writing to a file, the tool checks if that file is listed in `.gitignore`. If not, it emits a warning:

```
Warning: .env is not in .gitignore
```

This warning appears in both CLI stdout and MCP tool return values, so the AI can suggest adding the file to `.gitignore`.

## Configuration

### Config File Location

`~/.config/nfi/config.json`

### Supported Config Options

```json
{
  "timeout": 300000,
  "defaultFormat": null,
  "overwriteByDefault": false,
  "inputMethod": "auto",
  "generateTemplate": "hex:64"
}
```

- `timeout` - default browser prompt timeout in ms
- `defaultFormat` - override format detection globally (rarely needed)
- `overwriteByDefault` - skip the `--overwrite` flag requirement
- `inputMethod` - "auto" (fallback chain), "browser", "tty"
- `generateTemplate` - default template for `nfi generate`

CLI flags always override config file values.

## Concurrency

Last-write-wins. No file locking in v1. Concurrent writes to the same file may result in data loss - this is acceptable as simultaneous secret writes are an unlikely edge case.

## Project Structure

```
nfi-tools/
  src/
    core/
      formats/
        env.ts          # .env parser/writer
        json.ts         # JSON parser/writer
        yaml.ts         # YAML parser/writer
        toml.ts         # TOML parser/writer
        detect.ts       # auto-detect format from extension
      secrets.ts        # set, has, keys, remove, copy, diff logic
      generate.ts       # secret generation + templates
      gitignore.ts      # .gitignore checking
    cli/
      index.ts          # entry point, argument parsing
      commands/         # one file per command (set, has, keys, diff, etc.)
    mcp/
      index.ts          # MCP server entry point
      tools/            # one file per MCP tool
    ui/
      index.ts          # localhost server logic
      page.html         # the browser form
    input/
      browser.ts        # browser prompt strategy
      tty.ts            # TTY fallback strategy
      resolve.ts        # fallback chain logic
    config/
      index.ts          # ~/.config/nfi/config.json handling
  tests/
    core/
    cli/
    mcp/
  package.json
  tsconfig.json
  vitest.config.ts
```

## Dependencies

### Production
- `commander` - CLI argument parsing
- `@modelcontextprotocol/sdk` - MCP server
- `yaml` - YAML parse/write
- `smol-toml` - TOML parse/write
- `open` - cross-platform browser opening

### Development
- `typescript`
- `vitest`
- `tsup` - bundling (esbuild-based)
- `@types/node`

## Build and Distribution

- TypeScript compiled to ESM via tsup
- Published to npm as `nfi-tools`
- Bin name: `nfi`
- GitHub Actions CI: test + lint on PR, auto-publish on git tag
- Repository: user's personal GitHub account

## Future (v2+)

- Framework-specific generate templates (BetterAuth, NextAuth, etc.)
- Stack/framework auto-detection and presets
- Cross-format diff
- External service targets (Cloudflare Workers, Heroku, AWS SSM)
- User-defined generate templates in config
- Bracket notation for keys containing literal dots
- Homebrew formula
