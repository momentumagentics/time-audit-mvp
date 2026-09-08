# Time Audit — MVP

Voice-based, hands-free time audit tool, built to Colin's Aug 25 spec plus the
Sept follow-up that the interactive click-through version was too much work: he
taps **Start** once, then just talks. Everything else — segmenting his day into
blocks, asking a follow-up when needed, logging each block, and finishing the
session — happens by voice, with zero further clicks.

Built config-driven like Damon — client #2 is a new file in `config/`, not new code.

## How it works (hands-free)

1. **Start** — the one required tap (browsers require a click to grant mic access;
   there's no way around this). The app speaks the opening prompt, then starts
   listening automatically.
2. **Colin talks** — he describes one activity, then just stops talking. The app
   detects the pause (1.8s of silence, configurable) and sends the transcript to
   Claude — no button to press to "submit."
3. **Claude decides**, per block: activity, category, duration, delegable,
   automatable, and whether it's worth asking one short clarifying question
   (capped at `maxQuestionsPerBlock`, default 5). If it needs to ask, the app
   speaks the question out loud and automatically starts listening again for the
   answer — Colin never touches the screen.
4. **Auto-logged, no confirm click** — once a block is resolved, the app logs it
   immediately, speaks a one-line confirmation ("Got it — client prep, about 45
   minutes. What's next?"), and starts listening for the next block on its own.
5. **Voice commands, not buttons**:
   - Saying anything matching `finishPhrases` ("that's it", "I'm done", etc.)
     ends the session and pulls the report together.
   - Saying anything matching `undoPhrases` ("scratch that", "undo that") removes
     the last logged block and picks listening back up.
   - A quiet "Or tap here to finish" text link is the only fallback button, for
     when voice detection doesn't catch the finish phrase.
6. **Report** — Claude synthesizes all blocks into category totals, the single
   biggest time drain, and a prioritized automate/delegate list with estimated
   minutes/week recovered.
7. Sessions save as flat JSON files under `data/` — no DB needed at this volume.
   History is browsable from the intro screen.

No manual approval steps anywhere in the flow — matches Colin's standing "full
autonomy" preference from the Follow-Up Engine build, now extended to the audit
UI itself.

### A hard browser limit, not a design choice
Web pages cannot start listening to the microphone without a user gesture, and
cannot legally record without asking permission once. That's the one tap. After
it, the mic stays live for the whole session — there is no technical way to make
even that first tap disappear in a browser.

## Local setup

```bash
cd time-audit
npm install
cp .env.example .env   # then fill in ANTHROPIC_API_KEY
npm start
```

Open `http://localhost:8790`. Voice capture needs a Chromium-based browser
(Web Speech API); anything else automatically falls back to a text box so the
audit still works, just typed instead of spoken.

## Config

`.env`:
```
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-sonnet-5   # override if you're pinning a different model
PORT=8790
```

`config/colin.json` — categories, max questions per block, and the opening prompt
are all editable without touching code. Add `config/<newclient>.json` for anyone
else; pass `?client=<id>` in the URL (defaults to `colin`).

## Deploy (same pattern as Damon)

1. Push this repo to GitHub.
2. On the droplet: `git clone`, `npm install --production`, drop in `.env` with the
   real key, run behind the same reverse proxy / login you're already using for
   `colin.momentumagentics.com` (e.g. mount at `timeaudit.momentumagentics.com` or
   as a path under the existing hub, whichever's less config).
3. Process manager: same as whatever you're running Damon under (pm2 / systemd) —
   `node server.js`, restart on deploy.

## What's intentionally left for after Colin uses it once

- No auth on the app itself yet — put it behind the same login wall as the rest
  of the hub before it's reachable outside your own use.
- Report/session data is local JSON files, not synced anywhere — fine for one
  user, worth revisiting before client #2.
- Only the last logged block can be undone by voice ("scratch that"); there's no
  way to go back and fix block #2 once you're on block #5. Add a "review before
  finishing" screen if that turns out to matter.
- Speech recognition (Web Speech API) is Chrome/Edge only. Safari and Firefox
  fall back to a typed text box automatically — still hands-off in spirit (no
  clicking through per-block confirms) but not voice.
- Category list is fixed per client config; if Colin's real activities don't map
  cleanly to the 9 defaults after a session or two, that's the first thing to
  tune — it's a one-line edit in `config/colin.json`, not a code change.
- If the room is noisy or Colin's mic picks up background sound, the 1.8s
  silence threshold (`silenceMs` in config) may fire too early or too late —
  that's the first dial to turn if segmenting feels off.
