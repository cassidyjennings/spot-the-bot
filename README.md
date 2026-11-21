# Spot the Bot

A live Turing-test game for the MIT Splash class. Student groups ask questions and judge two anonymous answers, one from another group and one from an AI. Then the groups swap roles.

- **Web app** (`web/`): Preact + Vite, static, hosted on GitHub Pages. About 17 KB gzipped.
- **Game server** (`worker/`): one Cloudflare Worker plus one Durable Object per section, on the free tier. It holds the state, WebSockets, timers and the Gemini key.
- **Game rules** (`shared/`): pure TypeScript. Covers matching, scoring, the exchange state machine, and `views.ts`, which builds everything a phone is allowed to see (the anti-leak boundary).

Routes: `#/` students · `#/instructor` dashboard · `#/display?s=s1` projector (open it from the dashboard).

## Run locally

```bash
npm install
cp worker/.dev.vars.example worker/.dev.vars   # test passwords, LLM_MODE=mock
npm run dev:worker                             # http://127.0.0.1:8787
npm run dev:web                                # http://localhost:5173
```

Test logins from `.dev.vars.example`: instructor password `teach`; section passwords `alpha` / `bravo` / `charlie` / `delta`.

Phones on the same Wi-Fi can open `http://<your-laptop-ip>:5173`. Run the worker with `--ip 0.0.0.0` so they can reach it.

> **Windows:** if `/ws` returns a 500 error, the local Durable Object storage path is too long for Windows. Add `--persist-to C:/Temp/stb` to the `dev:worker` command.

Mock-mode test hooks: a question containing `mockdecline` is auto-blocked, and one containing `mockfail` is voided as an AI error.

## Tests and the bot simulator

```bash
npm test             # matching n=1..12, scoring, exchange states, no-leak checks
npm run typecheck
npx tsx scripts/bots.ts --n 9 --drive --round-min 0.5 --speed 2   # full 2-round game, prints summary
npx tsx scripts/bots.ts --session s2 --password bravo --n 3       # bots only; you drive from the dashboard
```

Add `--url wss://spot-the-bot.<you>.workers.dev` to run against the deployed server.

## Deploy

### 1. Game server (Cloudflare, free)

```bash
npx wrangler login
npx wrangler secret put INSTRUCTOR_PASSWORD --config worker/wrangler.toml
npx wrangler secret put SESSION_PASSWORDS --config worker/wrangler.toml   # {"s1":"...","s2":"...","s3":"...","s4":"..."}
npx wrangler secret put LLM_API_KEY --config worker/wrangler.toml         # Gemini key from Google AI Studio
npm run deploy:worker
```

This prints `https://spot-the-bot.<you>.workers.dev`. Then edit `worker/wrangler.toml`:
- set `ALLOWED_ORIGINS = "https://<github-user>.github.io"` and redeploy;
- check `LLM_MODEL` (see the Gemini section below).

### 2. Web app (GitHub Pages, free)

1. Push this repo to GitHub (default branch `main`).
2. Go to Settings > Pages > Source and pick **GitHub Actions**.
3. Go to Settings > Secrets and variables > Actions > **Variables** and add `WORKER_URL = https://spot-the-bot.<you>.workers.dev`.
4. Push. The workflow runs the tests, builds, and publishes to `https://<github-user>.github.io/<repo>/`.

## Gemini: enable billing before the event

- Every question costs 1 Gemini call for the AI answer, and every student answer costs 1 more for the safety check. That is about 12 calls per group per game, which is more than the free tier (about 500 requests/day, per third-party reports) allows for 4 full sections. Turn on billing for the Gemini project in Google AI Studio.
- Set a budget alert in Google Cloud Console (Billing > Budgets & alerts) so a bug or abuse can't run up a bill unnoticed.
- Safety check: a student answer is held until Gemini replies OK. If Gemini flags it, the answering group is asked to write a different answer (the AI answer is kept) and the asker sees "Just a few more seconds". After 3 flags on one question it is voided. If the check fails (error, timeout, unclear reply), the question is voided, so a Gemini outage stops questions rather than letting unchecked text through. Instructor answers skip the check.
- Mock-mode test hooks for the safety check: an answer containing `mockflag` is blocked, and one containing `mockmodfail` voids the question.
- Set `LLM_MODEL` to the exact model ID shown in AI Studio. If it's wrong, every question gets voided and the dashboard shows "AI error ... HTTP 404".
- Free-tier terms let Google use the content you submit. The server sends only the persona prompt and the question text (no names or ids), and the join screen warns students.

Edit the AI's personality in `worker/prompts/persona.md`, then run `npm run deploy:worker`.

## Live smoke test (real Gemini, deployed server)

Run this from your own terminal after any deploy. Uses about 20 Gemini requests and resets the section when done. Use a section you aren't about to teach in.

```bash
npx tsx scripts/bots.ts --url wss://spot-the-bot.cassidyj.workers.dev --session s4 --password <section 4 password> --instructor-password <instructor password> --n 3 --drive --round-min 0.5
```

Healthy output: `void 0`, `blocked 0`, `unexpected: 0`. Any voided question means Gemini failed (wrong `LLM_MODEL`, bad key, or rate limit); the dashboard alert shows the HTTP code.

## How it behaves (quick reference)

- The server holds both answers and releases them together, putting the human answer on a random side. Phones never learn which side is human until the reveal.
- The slider is locked in (the grey "ghost" marker) when the group asks its next question or the round ends. Later moves are shown but not scored.
- When the timer ends, a pending question gets a 60 s grace period. Once nothing is pending, the reveal happens 15 s after the last answer, so the group has time to set its slider.
- Odd group count: one group interrogates an instructor in both rounds. Late joiners can be matched with an instructor ("Match with me"); otherwise they play an instructor in Round 2.
- Block (from an instructor, an AI `[[DECLINE]]`, or a Gemini safety filter) discards both answers. The asker sees "That question isn't allowed."
- Lost phone: the instructor presses **Release name**, then the group rejoins with the same password and name and gets its history back.
- Data: **Delete session data** wipes a section immediately. Sections auto-delete 7 days after their game ends.

## Rehearsal checklist

- [ ] 6-8 real phones join one section; a duplicate name is rejected
- [ ] Full 2-round game; roles swap; the odd group plays an instructor
- [ ] Lock a phone mid-round, unlock: it reconnects to the same screen
- [ ] Release name on one phone; rejoin from another phone with the same name
- [ ] Take over a stalled responder from the dashboard and answer as the instructor
- [ ] Block a question; type something rude to see the AI auto-block
- [ ] Pause, +1 min, End round early
- [ ] Projector view on the second screen; final stats look right
- [ ] Delete session data afterwards
