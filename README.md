# pi-tinyfish

Register [TinyFish](https://tinyfish.ai) web services as tools for pi coding agent. TinyFish provides live web search, page extraction, AI browser automation, managed browser sessions, wallet status, and optional TinyFish MCP access.

## Install

Install the cloud version from GitHub:

```bash
pi install git:github.com/inouemoby/pi-tinyfish
```

After installation, restart pi or run `/reload`.

## Setup

Configure your API key with Pi's unified login command:

```text
/login
→ Select "Sign in with an API key"
→ Select "TinyFish"
→ Enter the TinyFish API key
```

You can also pass the provider directly:

```text
/login tinyfish
→ Enter the TinyFish API key when prompted
```

The key is stored in `~/.pi/agent/auth.json` and reused across sessions. The environment variable `TINYFISH_API_KEY` is also supported and takes priority. Use `/logout` to remove the stored key.

## What It Does

This extension registers three TinyFish tools:

### `tinyfish_search`

Searches the live web and returns structured ranked results with titles, snippets, URLs, and metadata. Supports:

- Web, news, and research-paper search
- Country and language targeting
- Domain include/exclude filters
- Recency and date filters
- Academic publication-year filters
- Deep mode with parallel consecutive page requests from the first page (`rounds`, default 3, maximum 10)

### `tinyfish_wallet`

Checks the authenticated wallet balance and billing status through the native `GET /v1/wallet` endpoint. Legacy accounts may return `FEATURE_NOT_AVAILABLE`.

### `tinyfish_fetch`

Fetches and extracts content from known URLs. Supports all Fetch request fields: up to 10 URLs, Markdown/HTML/JSON output, purpose, links, image links, cache TTL, per-URL timeout, conditional ETag/Last-Modified requests, validator capture, and CSS selectors.

### `tinyfish_agent` (disabled)

The Web Agent implementation is retained in the source code but is currently commented out and not registered as a Pi tool. Its previous capabilities included:

- Blocking, async, and SSE native Agent endpoints
- Lite and stealth browser profiles
- Tetra/custom proxy configuration
- Saved authenticated browser profiles
- TinyFish Vault credentials and scoped credential IDs
- Default/strict agent mode and step/duration limits
- Webhook notifications and capture artifacts
- JSON output schemas

Use this for workflows that require interaction, login, judgment, or multiple browser steps.

### `tinyfish_browser_session` (disabled)

The Browser Session implementation is retained in the source code but is currently commented out and not registered as a Pi tool.

## Usage Examples

Ask pi naturally:

> Use TinyFish Search to find the latest papers about browser agents and return the source URLs.

> Use TinyFish Fetch to read these three URLs and compare their pricing.

> Use TinyFish Agent to open the pricing page, switch to annual billing, and return every plan and price as JSON.

> Create a TinyFish browser session for this URL so I can control it with Playwright.

## Billing

TinyFish Search and Fetch are free according to the current TinyFish pricing policy. Agent and Browser usage is billed by TinyFish according to the account's wallet and contract rates.

## Installation

The extension is installed in Pi's global extension directory:

```text
C:\Users\36190\.pi\agent\extensions\tinyfish\index.ts
```

Restart pi or run `/reload` after changing the extension. After loading the extension, TinyFish appears as a provider in `/login`; its web tools are available to the agent directly.
