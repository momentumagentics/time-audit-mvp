require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 8790;
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- config loading (config-driven, one file per client) ----------
function loadConfig(clientId) {
  const p = path.join(__dirname, 'config', `${clientId}.json`);
  if (!fs.existsSync(p)) throw new Error(`No config for client "${clientId}"`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// ---------- session persistence (flat JSON file per session; fine for MVP volume) ----------
function sessionPath(id) {
  return path.join(DATA_DIR, `${id}.json`);
}
function saveSession(session) {
  fs.writeFileSync(sessionPath(session.id), JSON.stringify(session, null, 2));
}
function loadSession(id) {
  const p = sessionPath(id);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// ---------- Claude helpers ----------
async function callClaude(system, userContent, maxTokens = 1024) {
  const resp = await anthropic.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: userContent }],
  });
  const textBlock = resp.content.find((b) => b.type === 'text');
  return textBlock ? textBlock.text : '';
}

function extractJson(text) {
  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('No JSON object found in model output');
  return JSON.parse(cleaned.slice(start, end + 1));
}

const BLOCK_ANALYSIS_SYSTEM = (config) => `You are the analysis engine behind a spoken time audit tool for ${config.displayName}, who runs ${config.businessName}. ${config.displayName} talks through one block of their day at a time. Your job, for each block, is to:

1. Extract a short activity label (a few words).
2. Assign exactly one category from this fixed list: ${config.categories.join(', ')}.
3. Estimate duration in minutes if it was stated or can be reasonably inferred; otherwise null.
4. Judge whether you have enough information to finalize this block, or whether you need to ask a short clarifying question. You may ask at most ${config.maxQuestionsPerBlock} questions total per block (a running count is provided to you) — once that count is reached, you must finalize using your best judgment even if some detail is missing.
5. Note whether the activity looks delegable (could be handed to a person) and/or automatable (could be handled by software/AI), with a one-sentence reason for each judgment.

Ask a clarifying question only when it would materially change the category, duration, or delegability/automatability judgment — not out of general thoroughness. Good reasons to ask: duration wasn't mentioned at all, it's genuinely ambiguous which category fits, or it's unclear whether the task requires ${config.displayName}'s personal expertise versus being routine. Keep any question short, specific, and conversational — the kind of question a sharp assistant would ask out loud, never a form field.

Respond with ONLY a JSON object, no other text, in this exact shape:
{
  "activity": "string",
  "category": "one of the fixed categories",
  "durationMinutes": number or null,
  "delegable": {"value": true|false|null, "reason": "string"},
  "automatable": {"value": true|false|null, "reason": "string"},
  "needsClarification": true|false,
  "clarifyingQuestion": "string or null",
  "confidence": "high"|"medium"|"low"
}`;

const REPORT_SYSTEM = (config) => `You are synthesizing the results of a completed spoken time audit for ${config.displayName} of ${config.businessName}. You will be given a list of finalized time blocks, each with an activity, category, duration in minutes, and delegable/automatable judgments with reasons.

Produce a synthesis with:
1. Total minutes per category (only categories that appear).
2. The single biggest time drain — the category or specific recurring activity consuming the most time relative to its value, with a one-sentence rationale.
3. A prioritized list (highest time-savings first) of concrete automation or delegation candidates drawn from the blocks. For each: what it is, whether it's "automate" or "delegate", the estimated minutes/week it could recover (assume the audited day/period is representative and note that assumption), and a one-sentence reason.
4. A short, plain-spoken summary paragraph (3-4 sentences) written to ${config.displayName} directly, in a dry, matter-of-fact tone — no hype, no exclamation points.

Respond with ONLY a JSON object, no other text, in this exact shape:
{
  "categoryTotals": [{"category": "string", "minutes": number}],
  "biggestDrain": {"label": "string", "rationale": "string"},
  "candidates": [{"title": "string", "type": "automate"|"delegate", "estimatedMinutesPerWeek": number, "reason": "string"}],
  "summary": "string"
}`;

// ---------- routes ----------

// Start a session
app.post('/api/session/start', (req, res) => {
  try {
    const clientId = req.body.clientId || 'colin';
    const config = loadConfig(clientId);
    const id = crypto.randomUUID();
    const session = {
      id,
      clientId,
      startedAt: new Date().toISOString(),
      finished: false,
      blocks: [], // finalized blocks
      current: null, // in-progress block: { transcript, questionsAsked: [], analysis }
      report: null,
    };
    saveSession(session);
    res.json({
      sessionId: id,
      openingPrompt: config.openingPrompt,
      voice: config.voice,
      silenceMs: config.silenceMs || 1800,
      finishPhrases: config.finishPhrases || [],
      undoPhrases: config.undoPhrases || [],
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Submit a spoken segment for the current block (either the initial description, or an answer to a clarifying question)
app.post('/api/session/:id/segment', async (req, res) => {
  const { id } = req.params;
  const { transcript } = req.body;
  if (!transcript || !transcript.trim()) {
    return res.status(400).json({ error: 'transcript is required' });
  }
  const session = loadSession(id);
  if (!session) return res.status(404).json({ error: 'session not found' });
  const config = loadConfig(session.clientId);

  if (!session.current) {
    session.current = { transcriptParts: [transcript], questionsAsked: [] };
  } else {
    session.current.transcriptParts.push(transcript);
  }

  const fullTranscript = session.current.transcriptParts.join('\n');
  const questionsAskedCount = session.current.questionsAsked.length;

  const userContent = `Running transcript for this block so far (includes ${config.displayName}'s original description and any answers to follow-up questions):\n"""\n${fullTranscript}\n"""\n\nClarifying questions already asked for this block: ${questionsAskedCount} of ${config.maxQuestionsPerBlock} allowed.`;

  try {
    const raw = await callClaude(BLOCK_ANALYSIS_SYSTEM(config), userContent);
    const analysis = extractJson(raw);

    const canAskMore = questionsAskedCount < config.maxQuestionsPerBlock;
    const shouldAsk = analysis.needsClarification && canAskMore && analysis.clarifyingQuestion;

    session.current.analysis = analysis;
    if (shouldAsk) {
      session.current.questionsAsked.push(analysis.clarifyingQuestion);
    }
    saveSession(session);

    res.json({
      status: shouldAsk ? 'needs_clarification' : 'ready_to_finalize',
      question: shouldAsk ? analysis.clarifyingQuestion : null,
      preview: {
        activity: analysis.activity,
        category: analysis.category,
        durationMinutes: analysis.durationMinutes,
        delegable: analysis.delegable,
        automatable: analysis.automatable,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'analysis failed', detail: err.message });
  }
});

// Finalize the current block (user confirms) and add it to the session
app.post('/api/session/:id/finalize-block', (req, res) => {
  const { id } = req.params;
  const session = loadSession(id);
  if (!session) return res.status(404).json({ error: 'session not found' });
  if (!session.current || !session.current.analysis) {
    return res.status(400).json({ error: 'no in-progress block to finalize' });
  }
  const block = {
    ...session.current.analysis,
    rawTranscript: session.current.transcriptParts.join('\n'),
    questionsAsked: session.current.questionsAsked,
    finalizedAt: new Date().toISOString(),
  };
  session.blocks.push(block);
  session.current = null;
  saveSession(session);
  res.json({ blocks: session.blocks });
});

// Discard the current in-progress block (e.g. user wants to redo it)
app.post('/api/session/:id/discard-block', (req, res) => {
  const session = loadSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'session not found' });
  session.current = null;
  saveSession(session);
  res.json({ ok: true });
});

// Undo the most recently finalized block (voice command: "scratch that" / "undo that")
app.post('/api/session/:id/undo-last-block', (req, res) => {
  const session = loadSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'session not found' });
  if (session.blocks.length === 0) {
    return res.status(400).json({ error: 'no blocks to undo' });
  }
  const removed = session.blocks.pop();
  saveSession(session);
  res.json({ removed, blocks: session.blocks });
});

// Finish the session and synthesize the report
app.post('/api/session/:id/finish', async (req, res) => {
  const { id } = req.params;
  const session = loadSession(id);
  if (!session) return res.status(404).json({ error: 'session not found' });
  if (session.blocks.length === 0) {
    return res.status(400).json({ error: 'no finalized blocks to report on' });
  }
  const config = loadConfig(session.clientId);

  const blocksSummary = session.blocks.map((b, i) => ({
    index: i + 1,
    activity: b.activity,
    category: b.category,
    durationMinutes: b.durationMinutes,
    delegable: b.delegable,
    automatable: b.automatable,
  }));

  try {
    const raw = await callClaude(
      REPORT_SYSTEM(config),
      `Finalized blocks:\n${JSON.stringify(blocksSummary, null, 2)}`,
      2048
    );
    const report = extractJson(raw);
    session.report = report;
    session.finished = true;
    session.finishedAt = new Date().toISOString();
    saveSession(session);
    res.json({ report, blocks: session.blocks });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'report synthesis failed', detail: err.message });
  }
});

// Fetch a session (for report page reload / history)
app.get('/api/session/:id', (req, res) => {
  const session = loadSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'session not found' });
  res.json(session);
});

// List past sessions for a client (simple history)
app.get('/api/sessions', (req, res) => {
  const clientId = req.query.clientId || 'colin';
  const files = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith('.json'));
  const sessions = files
    .map((f) => JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8')))
    .filter((s) => s.clientId === clientId)
    .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt))
    .map((s) => ({
      id: s.id,
      startedAt: s.startedAt,
      finished: s.finished,
      blockCount: s.blocks.length,
    }));
  res.json({ sessions });
});

app.listen(PORT, () => {
  console.log(`Time Audit server running on port ${PORT} (model: ${MODEL})`);
});
