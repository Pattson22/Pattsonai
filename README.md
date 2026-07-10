# Pat

A personal AI assistant: chat with it in a browser, and it can take real
actions on your behalf via Claude's tool-calling — starting with posting to
X/Instagram/TikTok, designed to grow into more automations over time.

Built as a companion project after `../tradingbot` — same conventions where
they apply (env-var credentials, never hardcoded; one file per tool/concern).

## Persona

Pat is an elite, loyal, dry-witted British-butler-style assistant (see
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
  Dark voice-deck aesthetic (glowing state orb, ember/cyan transcript,
  Space Grotesk + JetBrains Mono) adapted from a Lovable reference design
  ("Echo Voice Studio"). Handles both text and voice input/output
  client-side.
- `lib/persona.ts` — Pat's system prompt, parameterized by output mode
  (`"text" | "voice"` — both wired up now; voice mode keeps replies under
  15 spoken words and avoids reading out raw JSON/URLs).
- `lib/assistant.ts` — the conversation loop: calls Claude, dispatches any
  `tool_use` blocks to the right tool handler, logs every call to
  `activity_log`, feeds tool errors back to Claude so it can explain them
  in-character rather than surfacing a raw stack trace.
- `lib/tools/index.ts` — the tool registry. Adding a new automation later
  (email, calendar, files, ...) means adding one module here, not
  restructuring anything. This only covers *client-executed* tools (ones
  with a local `handler`, logged to `activity_log`) — see below for the
  one server-executed tool.
- `lib/db.ts` — SQLite (`better-sqlite3`), local-first: `conversations`,
  `activity_log`, `memories`, and `reminders` tables in `data/pattson.db`
  (gitignored).

### Memory

Pat can save durable facts about you that persist across every future
conversation, not just the last ~50 messages of raw history. Two tools in
`lib/tools/memory.ts`: `remember_fact` (called unprompted whenever you
share something worth knowing long-term — name, preferences, ongoing
projects) and `forget_fact` (deletes anything matching a substring, for
corrections). All remembered facts (capped at the most recent 60, same
defensive limit as conversation history) are injected into every system
prompt as a `## KNOWN CONTEXT ABOUT THE USER` section — see
`buildSystemPrompt` in `lib/persona.ts`. Click "Memory · N facts" in the
sidebar to open a panel listing everything remembered, each with its own
delete button (`DELETE /api/memory/[id]`) — no need to ask Pat to forget
something, you can just remove it directly.

### Weather and reminders

- `lib/tools/weather.ts` — `get_weather`, backed by Open-Meteo (free,
  keyless: a geocoding call to resolve a place name, then a forecast call
  for current conditions). No API key to configure.
- `lib/tools/reminders.ts` — `add_reminder`, `list_reminders`,
  `complete_reminder`, backed by the `reminders` table. Relative phrasing
  ("tomorrow at 9am") is resolved to an absolute ISO datetime by Claude
  itself using the current-date context already in the system prompt (see
  Performance below), not parsed locally.

### Code execution

Anthropic's hosted `code_execution_20260521` server tool (declared next to
web search in `lib/assistant.ts`, same no-local-handler pattern) gives Pat
real calculation and data-processing ability — closing a gap where
`persona.ts`'s own response-style examples already described it "running a
math tool" that didn't actually exist yet. Billed free when paired with
web search, which is already in the tools list.

### Web search

Pat has real-time web access via Anthropic's hosted `web_search_20250305`
server tool (declared directly in `lib/assistant.ts`, not in the
`lib/tools/` registry — it runs entirely on Anthropic's infrastructure,
with no local handler). This is the same mechanism claude.ai itself uses
for current-events answers — the base model has no live data on its own,
only whatever it can look up. Capped at 3 searches per reply
(`max_uses: 3`) as a cost/runaway guard. Because it's server-executed, web
searches don't produce `activity_log` entries the way the posting tools
do — the ledger is for Pat's own actions, not its research.

### Voice interface

Speech-to-text and text-to-speech both run entirely in the browser via the
Web Speech API (`SpeechRecognition` + `speechSynthesis`) — no server-side
STT/TTS provider, no added cost or latency, no audio ever leaves the
device except to your own Anthropic API calls for the text turn itself.

- Click the mic to dictate; on a final transcript it auto-sends.
- Toggle "Voice" mode in the sidebar to have replies read aloud and to
  switch the persona into its shorter, spoken-sentence style. Toggling it
  on doesn't start listening immediately — it starts a passive, continuous
  background listener for the wake phrase "hello Pat" (or "hey Pat").
  Saying it opens the voice overlay, plays an instant canned greeting
  ("Hello, sir — at your service.", spoken with no API round-trip), then
  starts a real listening turn. After Pat replies, it keeps listening
  hands-free for a follow-up; if you go quiet, it drops back to the
  passive wake-word listener instead of leaving the mic hot indefinitely.
  The mic button (both in the input bar and inside the overlay) bypasses
  the wake word for an immediate one-off listen.
- The orb's glow tracks your actual mic volume while listening (a second
  `getUserMedia` stream feeds a Web Audio `AnalyserNode`; not just a canned
  animation).
- Voice selection prefers higher-quality system voices automatically
  (anything with "natural"/"neural"/"premium"/"enhanced" in its name, e.g.
  Windows 11's cloud-backed "Online (Natural)" voices) over legacy
  robotic-sounding ones, with a slightly slower rate/lower pitch tuned for
  a more natural cadence — see `pickBritishVoice` in `app/page.tsx`. Free,
  no added latency: it's still just ranking the browser's own voice list.
- **Interrupting a reply**: tap the mic (or just start talking) while Pat
  is still thinking/streaming, and your follow-up is folded into the
  original request and sent as a fresh turn — the abandoned turn's
  in-flight server request is aborted (`AbortSignal` threaded through to
  the Anthropic SDK call) and its orphaned DB row is cleaned up, not left
  as an unanswered message.
- **Barge-in while Pat is speaking**: a background recognizer runs for the
  whole time Pat is talking, so you can cut in mid-sentence like a real
  conversation instead of waiting or tapping Stop first. It reuses the
  same self-echo guard as hands-free listening so Pat's own voice coming
  back through the mic doesn't trigger it.
- Browser support: `SpeechRecognition` is Chrome/Edge only as of 2026
  (no Firefox, partial Safari) — the mic control and Voice mode pill
  hide themselves automatically when unsupported.

## Performance

`lib/assistant.ts` sets `thinking`/`effort` per output mode rather than
globally. Claude Sonnet 5 runs adaptive extended thinking and "high"
effort by default unless told otherwise — good for hard reasoning, but it
adds a real reasoning phase before any text streams back. Voice replies
are spoken aloud, so speed to first token matters more than reasoning
depth there: `thinking: "disabled"` + `effort: "low"`. Text mode has no
TTS wait, so it trades some latency for real reasoning: `thinking:
"adaptive"` + `effort: "medium"`.

## Known limitations

- No confirmation gate before publishing (see Persona above) — a
  misjudged or hallucinated post goes live with no pre-publish safety net,
  by explicit design choice.
- Voice input/output only works in Chromium browsers (Web Speech API
  support), and requires mic permission — the wake-word listener means the
  mic stays passively active (locally, in-browser) for as long as Voice
  mode is on, not just during an active turn.
- No multi-user/auth — this is a single-user personal assistant.
- No deployment/hosting story yet — runs locally.
