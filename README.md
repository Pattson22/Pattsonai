# PATTSON

A personal AI assistant: chat with it in a browser, and it can take real
actions on your behalf via Claude's tool-calling — starting with posting to
X/Instagram/TikTok, designed to grow into more automations over time.

Built as a companion project after `../tradingbot` — same conventions where
they apply (env-var credentials, never hardcoded; one file per tool/concern).

## Persona

PATTSON is an elite, loyal, dry-witted British-butler-style assistant (see
`lib/persona.ts` for the full system prompt). It's designed for **seamless,
autonomous action** — it does not ask permission before using a tool, and
posting tools (X/Instagram/TikTok) publish directly with no confirmation
step. This was an explicit, discussed tradeoff: the only safety net is an
after-the-fact activity log (visible in the UI) and a per-tool rate/sanity
guard against runaway loops — not a pre-publish approval gate. Know that
before pointing it at real accounts.

## Setup

```bash
npm install
cp .env.local.example .env.local
# fill in .env.local, then:
npm run dev
```

Open http://localhost:3000.

### Required: Anthropic API key

Get one at https://console.anthropic.com (account/billing setup you need to
do yourself). Set `ANTHROPIC_API_KEY` in `.env.local`.

### X (Twitter) — can go fully live today

No app review needed, but **no free tier as of 2026** — pay-per-use:
~$0.015 per plain-text post, $0.20 per post containing a link, credits
purchased upfront at https://developer.x.com. Create a developer account,
generate API keys + access tokens with read/write permissions, load
credits, then fill in the four `TWITTER_*` vars in `.env.local`.

### Instagram — requires external approval first

1. Convert your Instagram account to a Business or Creator account and link
   it to a Facebook Page.
2. Create a Meta developer app at https://developers.facebook.com.
3. Request the `instagram_business_content_publish` permission via App
   Review — typically takes 2-4 weeks, and needs a written use-case
   description + your privacy policy.
4. Once approved, generate a long-lived access token and find your
   Instagram Business Account ID, then fill in the `INSTAGRAM_*` vars.

Until that review completes, `tools/instagram.ts` is fully implemented and
testable against the real Graph API shape, but calls will be rejected by
Meta until the permission is granted.

### TikTok — highest friction, requires external approval + a live website

1. Register a developer app at https://developers.tiktok.com and request
   Content Posting API access.
2. TikTok requires your app to link to a **live external website** with
   visible Privacy Policy and Terms of Service pages as a prerequisite for
   approval — you'll need to stand this up before submitting for review.
3. Review typically takes 1-6 weeks.
4. Until approved, an *unaudited* app can still post, but only as
   **private/SELF_ONLY** visibility, to up to 5 test users per 24h — useful
   for testing the integration, not for real public posts.
5. Once approved, fill in the `TIKTOK_*` vars.

## Architecture

- `app/page.tsx` — chat UI, streams responses from `app/api/chat/route.ts`.
- `lib/persona.ts` — PATTSON's system prompt, parameterized by output mode
  (`"text" | "voice"` — only text is wired up yet; voice interface is a
  later phase).
- `lib/assistant.ts` — the conversation loop: calls Claude, dispatches any
  `tool_use` blocks to the right tool handler, logs every call to
  `activity_log`, feeds tool errors back to Claude so it can explain them
  in-character rather than surfacing a raw stack trace.
- `lib/tools/index.ts` — the tool registry. Adding a new automation later
  (email, calendar, files, ...) means adding one module here, not
  restructuring anything.
- `lib/db.ts` — SQLite (`better-sqlite3`), local-first: `conversations` +
  `activity_log` tables in `data/pattson.db` (gitignored).

## Known limitations

- No confirmation gate before publishing (see Persona above) — a
  misjudged or hallucinated post goes live with no pre-publish safety net,
  by explicit design choice.
- No voice interface yet.
- No multi-user/auth — this is a single-user personal assistant.
- No deployment/hosting story yet — runs locally.
