import express from 'express';
import { fal } from '@fal-ai/client';
import Replicate from 'replicate';
import { GoogleGenAI } from '@google/genai';
import { spawn } from 'child_process';
import {
  buildMotionPromptSystem,
  buildMotionPromptUserContent,
  coerceVideoPromptArray,
  composeMotionPromptBatch,
  createFallbackMotionPromptBatch,
  validateMotionPromptBatch,
} from '../lib/motionPrompts.js';
import {
  auditNarrationContinuity,
  buildNarrationSkillPrompt,
} from '../lib/narrationSkills.js';
import {
  buildCharacterSceneContext,
  buildCharacterStoryContext,
  normalizeExtractedCharacters,
} from '../lib/characterContinuity.js';
import { hardenImagePromptScenes } from '../lib/imagePromptQuality.js';
const router = express.Router();

// Local Claude Code CLI (`claude -p`) — runs on the same machine as the backend,
// uses the user's existing Claude subscription. Model must be a known alias.
const CLAUDE_CLI_MODELS = new Set(['haiku', 'sonnet', 'opus']);
export const PROMPT_AUTHOR_PROVIDER = 'claude-cli';
export const PROMPT_AUTHOR_MODEL = 'sonnet';

const enforceSonnetPromptAuthor = (req) => {
  req.body.provider = PROMPT_AUTHOR_PROVIDER;
  req.body.model = PROMPT_AUTHOR_MODEL;
};

// Claude's stream-json envelope is intentionally normalized here so callers
// never need to understand CLI transport events. Partial text is emitted once;
// the final `result` is kept separately to avoid duplicating assistant blocks.
export const parseClaudeStreamEvent = (event) => {
  if (!event || typeof event !== 'object') return { delta: '', result: '' };
  const delta = event.type === 'stream_event'
    && event.event?.type === 'content_block_delta'
    && event.event?.delta?.type === 'text_delta'
    ? String(event.event.delta.text || '')
    : '';
  const result = event.type === 'result' && typeof event.result === 'string'
    ? event.result
    : '';
  return { delta, result };
};

export const callClaudeCli = (model, systemPrompt, userContent, options = {}) => {
  const selectedModel = CLAUDE_CLI_MODELS.has(model) ? model : 'sonnet';
  const timeoutMs = Math.max(10_000, Number(options.timeoutMs) || 15 * 60_000);
  return new Promise((resolve, reject) => {
    // NOTE: do NOT pass --bare — it skips settings loading, which is where this
    // profile's CLI auth lives ("Not logged in" otherwise). Instead,
    // --exclude-dynamic-system-prompt-sections strips CLAUDE.md/env/agent
    // sections so --system-prompt fully replaces the system prompt and the
    // model answers as a raw LLM instead of acting agentically.
    // User content goes via stdin — scene-plan payloads can exceed argv limits.
    const streaming = options.stream === true;
    const args = [
      '-p',
      '--model', selectedModel,
      '--system-prompt', systemPrompt,
      '--exclude-dynamic-system-prompt-sections',
      '--tools', Array.isArray(options.tools) ? options.tools.join(',') : (options.tools ?? ''),
      '--output-format', streaming ? 'stream-json' : 'text',
    ];
    if (['low', 'medium', 'high'].includes(options.effort)) {
      args.push('--effort', options.effort);
    }
    if (options.safeMode) args.push('--safe-mode');
    if (options.noSessionPersistence) args.push('--no-session-persistence');
    if (streaming) args.push('--verbose', '--include-partial-messages');
    for (const dir of options.addDirs || []) args.push('--add-dir', dir);
    const child = spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      // Equivalent of the user's `claudejoshua` shell alias
      // (CLAUDE_CONFIG_DIR=~/.claudejoshua claude): CLAUDE_CONFIG_DIR is set in
      // backend/.env and inherited here, selecting the logged-in profile.
      env: process.env,
    });

    let stdout = '';
    let stderr = '';
    let streamBuffer = '';
    let streamedText = '';
    let finalResult = '';
    const consumeStreamLine = (line) => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line);
        options.onEvent?.(event);
        const parsed = parseClaudeStreamEvent(event);
        if (parsed.delta) {
          streamedText += parsed.delta;
          options.onText?.(parsed.delta, streamedText);
        }
        if (parsed.result) finalResult = parsed.result;
      } catch {
        // Retain malformed transport output for diagnostics without treating it
        // as authored map JSON.
        stdout += `${line}\n`;
      }
    };
    const onAbort = () => {
      child.kill('SIGKILL');
      reject(new Error('Claude CLI request was canceled'));
    };
    if (options.signal?.aborted) return onAbort();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const cleanup = () => {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', onAbort);
    };
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Claude CLI timed out after ${Math.round(timeoutMs / 1000)} seconds`));
    }, timeoutMs);

    child.stdout.on('data', (d) => {
      const chunk = d.toString();
      if (!streaming) {
        stdout += chunk;
        options.onText?.(chunk, stdout);
        return;
      }
      streamBuffer += chunk;
      const lines = streamBuffer.split(/\r?\n/);
      streamBuffer = lines.pop() || '';
      for (const line of lines) consumeStreamLine(line);
    });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => {
      cleanup();
      reject(err.code === 'ENOENT'
        ? new Error('Claude CLI not found — install Claude Code or use another provider')
        : err);
    });
    child.on('close', (code) => {
      cleanup();
      if (streaming && streamBuffer.trim()) consumeStreamLine(streamBuffer);
      const responseText = finalResult || streamedText || stdout;
      if (code !== 0) {
        reject(new Error(`Claude CLI exited with code ${code}: ${stderr.slice(0, 500) || responseText.slice(0, 500)}`));
      } else if (!responseText.trim()) {
        reject(new Error('Claude CLI returned empty output'));
      } else {
        resolve(responseText);
      }
    });

    child.stdin.write(userContent);
    child.stdin.end();
  });
};

// Recursively replace N/A-like sentinel values with a fallback
const sanitizeNAValues = (obj) => {
  if (Array.isArray(obj)) return obj.map(sanitizeNAValues);
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'string' && /^(n\/a|none|unknown|tbd|n\.a\.)$/i.test(v.trim())) {
        // Replace with field-specific sensible defaults
        if (k === 'clothing') out[k] = 'period-appropriate attire';
        else if (k === 'weather') out[k] = 'clear';
        else if (k === 'time_of_day') out[k] = 'midday';
        else if (k === 'action') out[k] = 'stands in scene';
        else out[k] = '';
      } else {
        out[k] = sanitizeNAValues(v);
      }
    }
    return out;
  }
  return obj;
};

// Models sometimes wrap the JSON in prose ("Here is the plan... ```json ... ``` Hope this helps").
// Pull out the fenced block if present, otherwise the first balanced {...}/[...] span.
export const extractJsonBlock = (text) => {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    const inner = fence[1].trim();
    if (inner.startsWith('{') || inner.startsWith('[')) return inner;
  }
  const start = text.search(/[[{]/);
  if (start === -1) return text;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (esc) { esc = false; continue; }
    if (c === '\\' && inStr) { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return text.slice(start); // unbalanced — downstream repair logic will close it
};

export const safeParseJSON = (text) => {
  const cleaned = text.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();

  try {
    return sanitizeNAValues(JSON.parse(cleaned));
  } catch (firstErr) {
    // Second chance: strip surrounding prose, then parse
    const extracted = extractJsonBlock(cleaned);
    try {
      return sanitizeNAValues(JSON.parse(extracted));
    } catch {
      // fall through to truncation repair on the extracted block
    }
    // Attempt to repair truncated JSON by closing open structures
    let repaired = extracted;
    
    // Count open braces/brackets to determine what needs closing
    let braceDepth = 0;
    let bracketDepth = 0;
    let inString = false;
    let escaped = false;
    
    for (let i = 0; i < repaired.length; i++) {
      const ch = repaired[i];
      if (escaped) { escaped = false; continue; }
      if (ch === '\\' && inString) { escaped = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') braceDepth++;
      else if (ch === '}') braceDepth--;
      else if (ch === '[') bracketDepth++;
      else if (ch === ']') bracketDepth--;
    }
    
    // If we're mid-string, close the string first so depth counts below are valid
    if (inString) repaired += '"';

    // Remove trailing incomplete key-value pairs safely.
    // Strategy: strip from the last top-level comma that is NOT inside a string,
    // object, or array — this avoids greedy regexes that corrupt prompt strings
    // containing brackets or quotes (e.g. "holding a [torch]...").
    // We walk backwards to find the last safe truncation point.
    {
      let depth = 0;
      let inStr = false;
      let esc = false;
      let lastSafeComma = -1;
      for (let i = 0; i < repaired.length; i++) {
        const c = repaired[i];
        if (esc) { esc = false; continue; }
        if (c === '\\' && inStr) { esc = true; continue; }
        if (c === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (c === '{' || c === '[') depth++;
        else if (c === '}' || c === ']') depth--;
        else if (c === ',' && depth === 1) lastSafeComma = i;
      }
      // If the JSON is clearly truncated mid-value at the top level, prune to last safe comma
      if (lastSafeComma > 0 && (inString || repaired.trimEnd().endsWith(':'))) {
        repaired = repaired.slice(0, lastSafeComma);
      }
    }

    repaired = repaired.replace(/,\s*$/, '');
    
    // Re-count after cleanup
    braceDepth = 0;
    bracketDepth = 0;
    inString = false;
    escaped = false;
    for (let i = 0; i < repaired.length; i++) {
      const ch = repaired[i];
      if (escaped) { escaped = false; continue; }
      if (ch === '\\' && inString) { escaped = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') braceDepth++;
      else if (ch === '}') braceDepth--;
      else if (ch === '[') bracketDepth++;
      else if (ch === ']') bracketDepth--;
    }
    
    // Close open brackets then braces
    repaired += ']'.repeat(Math.max(0, bracketDepth));
    repaired += '}'.repeat(Math.max(0, braceDepth));
    
    try {
      const result = sanitizeNAValues(JSON.parse(repaired));
      console.warn('safeParseJSON: repaired truncated JSON successfully');
      return result;
    } catch {
      console.error('safeParseJSON: repair failed. Original error:', firstErr.message);
      throw firstErr;
    }
  }
};

const callClaudeViaFal = async (keys, systemPrompt, userContent) => {
  fal.config({ credentials: keys.fal });
  
  const result = await fal.subscribe('fal-ai/claude-3-5-sonnet', {
    input: {
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }],
      max_tokens: 16000
    }
  });
  
  const text = result.content?.[0]?.text
    || result.message?.content?.[0]?.text
    || (typeof result.output === 'string' ? result.output : null)
  if (!text) throw new Error('No text content in fal Claude response')
  return text
};

const withReplicateRetry = async (fn, maxRetries = 3) => {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isInterrupted = err.message?.includes('interrupted') || err.message?.includes('code: PA');
      if (isInterrupted && attempt < maxRetries) {
        const delay = attempt * 2000;
        console.warn(`Replicate interrupted (attempt ${attempt}/${maxRetries}), retrying in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
};

const callClaudeViaReplicate = async (keys, model, systemPrompt, userContent) => {
  const replicate = new Replicate({ auth: keys.replicate });
  
  // Normalise model identifier: 'claude-3.5-sonnet' → 'anthropic/claude-3.5-sonnet'
  const replicateModel = model?.startsWith('anthropic/')
    ? model
    : model
      ? `anthropic/${model}`
      : 'anthropic/claude-3.5-sonnet';

  const output = await withReplicateRetry(() => replicate.run(replicateModel, {
    input: {
      system: systemPrompt,
      prompt: userContent,
      max_tokens: 16000
    }
  }));
  
  return Array.isArray(output) ? output.join('') : output;
};

const callGeminiViaReplicate = async (keys, model, systemPrompt, userContent) => {
  const replicate = new Replicate({ auth: keys.replicate });
  
  const modelMap = {
    'gemini-2.5-flash': 'google/gemini-2.5-flash',
    'gemini-3-flash': 'google/gemini-3-flash',
    'gemini-3.1-pro': 'google/gemini-3.1-pro',
    // Also accept full model names
    'google/gemini-2.5-flash': 'google/gemini-2.5-flash',
    'google/gemini-3-flash': 'google/gemini-3-flash',
    'google/gemini-3.1-pro': 'google/gemini-3.1-pro',
    // Note: Claude models are routed via callClaudeViaReplicate, never reach here
  };
  
  const replicateModel = modelMap[model] || 'google/gemini-2.5-flash';
  
  const output = await withReplicateRetry(() => replicate.run(replicateModel, {
    input: {
      prompt: userContent,
      system_instruction: systemPrompt,
      max_output_tokens: 16000
    }
  }));
  
  return Array.isArray(output) ? output.join('') : output;
};

const callGemini = async (keys, model, systemPrompt, userContent) => {
  const ai = new GoogleGenAI({ apiKey: keys.gemini });
  
  // Gemini model IDs — pass through as-is, with short aliases for convenience
  const modelMap = {
    'gemini-3.1-pro':        'gemini-3.1-pro-preview',
    'gemini-3-flash':        'gemini-3-flash-preview',
    'gemini-3-pro':          'gemini-3-pro-preview',
    'gemini-2.5-flash':      'gemini-2.5-flash',
    'gemini-2.5-pro':        'gemini-2.5-pro',
    'gemini-2.5-flash-lite': 'gemini-2.5-flash-lite',
  };
  
  const selectedModel = modelMap[model] || model || 'gemini-2.5-flash';

  // Retry on 429 — preview models have per-minute quota limits
  const maxRetries = 4;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model: selectedModel,
        contents: userContent,
        config: { systemInstruction: systemPrompt }
      });
      return response.text;
    } catch (err) {
      const is429 = err.status === 429
        || err.message?.includes('429')
        || err.message?.includes('RESOURCE_EXHAUSTED')
        || err.message?.includes('quota');

      if (is429 && attempt < maxRetries) {
        // Parse retryDelay from error if present, otherwise exponential backoff
        const retryMatch = err.message?.match(/retryDelay[^0-9]*([0-9]+)s/);
        const waitMs = retryMatch
          ? parseInt(retryMatch[1]) * 1000 + 1000
          : Math.min(attempt * 15000, 60000);
        console.warn(`Gemini 429 (attempt ${attempt}/${maxRetries}), waiting ${waitMs}ms...`);
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }
      throw err;
    }
  }
  // Safety net: should be unreachable (last attempt always throws above)
  throw new Error('Gemini: max retries exhausted');
};

export const callClaude = async (req, systemPrompt, userContent, options = {}) => {
  const keys = req.app.get('apiKeys');
  const provider = req.body.provider || 'fal';
  const model = req.body.model;
  // Allow frontend to override the system prompt for this call
  const effectiveSystemPrompt = options.ignoreSystemOverride
    ? systemPrompt
    : req.body.systemPrompt?.trim() || systemPrompt;
  
  if (provider === 'claude-cli') {
    return await callClaudeCli(model, effectiveSystemPrompt, userContent, options);
  } else if (provider === 'gemini') {
    if (!keys.gemini) throw new Error('Gemini API key not configured');
    return await callGemini(keys, model, effectiveSystemPrompt, userContent);
  } else if (provider === 'replicate') {
    if (!keys.replicate) throw new Error('Replicate API key not configured');
    if (model && (model.startsWith('gemini') || model.startsWith('google/gemini'))) {
      return await callGeminiViaReplicate(keys, model, effectiveSystemPrompt, userContent);
    }
    if (model && (model.startsWith('anthropic/') || model.startsWith('claude'))) {
      return await callClaudeViaReplicate(keys, model, effectiveSystemPrompt, userContent);
    }
    // No recognised model prefix — fail fast instead of silently routing to Gemini
    throw new Error(`Unsupported Replicate model: "${model}". Use a model starting with "anthropic/", "claude", "gemini", or "google/gemini".`);
  } else {
    if (!keys.fal) throw new Error('fal.ai API key not configured');
    return await callClaudeViaFal(keys, effectiveSystemPrompt, userContent);
  }
};

const STORY_SYSTEM_PROMPT = `You are an elite documentary filmmaker and investigative historian. You specialize in finding TRUE historical stories that are so dramatic, so unbelievable, and so emotionally powerful that viewers cannot look away.

MISSION: Find REAL historical events that have all the ingredients of a blockbuster film — BUT THEY ACTUALLY HAPPENED.

STORY SELECTION CRITERIA (CRITICAL):
1. HISTORICAL TRUTH: Every story MUST be 100% documented. Names, dates, locations, outcomes — all verifiable. No legends, no myths, no composite characters.
2. CINEMATIC POTENTIAL: Look for stories with:
   - Life-or-death stakes
   - Clear heroes and villains (or moral complexity)
   - Ticking clocks and impossible odds
   - Moments where everything could have gone differently
   - Physical action that can be VISUALLY recreated
3. EMOTIONAL RESONANCE: Stories that make viewers FEEL something — fear, hope, outrage, triumph, heartbreak
4. SURPRISE FACTOR: Stories most people don't know, or reveal shocking new angles on familiar events
5. UNIVERSAL THEMES: Courage, betrayal, survival, sacrifice, justice, the human spirit against impossible odds

DOCUMENTARY STORYTELLING PRINCIPLES:
- Open with a HOOK that grabs viewers in the first 5 seconds
- Build TENSION progressively — each scene should raise questions
- Use REVELATIONS strategically — save the biggest surprises for maximum impact
- Create EMPATHY quickly — viewers must care what happens
- End with RESONANCE — the final image/line should linger

AVOID:
- Dry academic topics
- Stories without clear narrative arcs
- Events that are too recent (need historical perspective)
- Stories that require extensive political context to understand
- Anything that feels like a lecture

PREFERRED STORY TYPES:
- Survival against impossible odds
- Daring escapes, rescues, or heists
- Unsung heroes whose deeds were forgotten
- Disasters and how people faced them
- Moments that changed history but few remember
- True crime with historical distance
- Exploration and discovery gone wrong
- Acts of extraordinary courage or sacrifice

OUTPUT FORMAT:
Return ONLY valid JSON. No markdown. Each story must be a page-turner.`;

router.post('/stories', async (req, res) => {
  try {
    const { topic, maxMinutes, mode = 'discover', title, context } = req.body;

    if (mode === 'guided') {
      if (!String(title || '').trim() || !String(context || '').trim()) {
        return res.status(400).json({
          error: true,
          message: 'A title and story context are required for guided research.',
          code: 'GUIDED_STORY_INPUT_REQUIRED',
        });
      }
      const guidedContent = `Research and develop ONE exact documentary story.

User title: ${String(title).trim()}
User's authoritative story context:
${String(context).trim()}

The user is not asking for adjacent story ideas. Research only this concrete story. Preserve the supplied premise, people, chronology, and intended focus. Use research to verify facts, resolve dates and locations, add attributable detail, and identify the strongest truthful narrative structure. If a supplied detail conflicts with reliable evidence, flag the conflict in "research_notes" instead of silently replacing it.

Target video length: ${maxMinutes ? `${maxMinutes} minutes` : 'flexible'}

Return ONLY JSON:
{
  "stories": [{
    "id": "guided-story",
    "input_mode": "guided",
    "title": "${String(title).trim().replace(/"/g, '\\"')}",
    "summary": "A precise 3-5 sentence account of this exact story, enriched by research",
    "why_compelling": "The truthful dramatic and emotional reason this exact story works",
    "era": "Specific date, year, or range",
    "location": "Specific location or locations",
    "estimated_scenes": ${maxMinutes ? Math.round(maxMinutes * 60 / 8) : 45},
    "narrative_beats": ["hook", "context", "inciting_incident", "rising_action", "climax", "resolution"],
    "dramatic_highlights": ["specific documented visual moment"],
    "stakes": "What was at risk",
    "emotional_core": "The human truth",
    "surprise_factor": "The strongest documented revelation",
    "historical_sources": [{"title":"source or archive name","url":"direct source URL","verifies":"specific fact it supports"}],
    "research_notes": ["verification, uncertainty, or contradiction notes"],
    "source_context": "The user's original context, preserved verbatim"
  }]
}`;
      const researchModel = CLAUDE_CLI_MODELS.has(req.body.model) ? req.body.model : 'opus';
      const text = await callClaudeCli(researchModel, STORY_SYSTEM_PROMPT, guidedContent, {
        tools: ['WebSearch', 'WebFetch'],
        noSessionPersistence: true,
        timeoutMs: 15 * 60_000,
      });
      const data = safeParseJSON(text);
      const stories = Array.isArray(data) ? data : data.stories || [];
      const story = stories[0];
      if (!story) throw new Error('Guided research returned no story');
      return res.json([{
        ...story,
        id: story.id || `guided-${Date.now().toString(36)}`,
        input_mode: 'guided',
        title: String(title).trim(),
        source_context: String(context).trim(),
      }]);
    }
    
    const userContent = `Find exactly 4 REAL, DOCUMENTED historical stories about: "${topic}"

CRITICAL REQUIREMENTS:
- Each story MUST be 100% historically accurate with verifiable sources
- Each story MUST have cinematic visual potential (action, drama, stakes)
- Each story MUST be emotionally engaging — make viewers CARE
- Each story should SURPRISE the audience
- Target video length: ${maxMinutes ? `${maxMinutes} minutes` : 'flexible'}

For each story, identify:
- The EXACT hook that will grab viewers in seconds
- The STAKES — what could be lost? What was risked?
- The TENSION POINTS — where did everything almost fall apart?
- The VISUAL MOMENTS — what scenes will look stunning on screen?
- The EMOTIONAL CORE — why will viewers remember this?

Return JSON:
{
  "stories": [
    {
      "id": "uuid-string",
      "title": "A gripping, cinematic title (not academic)",
      "summary": "2-3 sentences that would make someone say 'wait, WHAT?! Tell me more!'",
      "why_compelling": "The emotional hook — why viewers will be glued to their screens",
      "era": "Specific year or decade",
      "location": "Where it happened",
      "estimated_scenes": ${maxMinutes ? Math.round(maxMinutes * 60 / 8) : 45},
      "narrative_beats": ["hook", "context", "inciting_incident", "rising_action_1", "rising_action_2", "climax", "resolution"],
      "dramatic_highlights": ["visual moment 1 that will stun viewers", "visual moment 2"],
      "stakes": "What was at risk — lives, fortunes, nations, souls?",
      "emotional_core": "The universal human truth this story reveals",
      "surprise_factor": "What will viewers not see coming",
      "historical_sources": "Brief note on where this is documented",
      "historical_footage_available": false
    }
  ]
}`;
    
    const text = await callClaude(req, STORY_SYSTEM_PROMPT, userContent);
    const data = safeParseJSON(text);
    const stories = data.stories || data;
    res.json(stories);
  } catch (error) {
    console.error('Stories error:', error);
    res.status(500).json({ error: true, message: error.message, code: 'STORIES_ERROR' });
  }
});

export const splitVoiceoverAtSentenceBoundaries = (voiceover, count) => {
  const text = String(voiceover || '').trim();
  const targetCount = Math.max(1, Number(count) || 1);
  if (!text) return Array.from({ length: targetCount }, () => '');
  const sentences = text.match(/[^.!?…]+(?:[.!?…]+["'”’)]*|$)/g)
    ?.map(sentence => sentence.trim())
    .filter(Boolean) || [text];
  const totalWords = sentences.reduce((sum, sentence) => sum + sentence.split(/\s+/).length, 0);
  const targetWords = Math.max(1, totalWords / targetCount);
  const chunks = [];
  let current = [];
  let currentWords = 0;
  for (const sentence of sentences) {
    const words = sentence.split(/\s+/).length;
    if (
      current.length
      && chunks.length < targetCount - 1
      && currentWords >= targetWords * 0.7
    ) {
      chunks.push(current.join(' '));
      current = [];
      currentWords = 0;
    }
    current.push(sentence);
    currentWords += words;
  }
  if (current.length) chunks.push(current.join(' '));

  // A supplied script can contain a few long sentences while the visual plan
  // needs more scenes. Split the longest remaining passage at a natural
  // clause/word boundary instead of manufacturing silent scenes. The words
  // and their order remain untouched.
  while (chunks.length < targetCount) {
    let splitIndex = -1;
    let splitAt = -1;
    let largestWords = 1;
    chunks.forEach((chunk, index) => {
      const words = chunk.trim().split(/\s+/).filter(Boolean);
      if (words.length <= largestWords) return;
      const midpoint = Math.floor(words.length / 2);
      let boundary = -1;
      for (let distance = 0; distance < words.length; distance += 1) {
        for (const candidate of [midpoint + distance, midpoint - distance]) {
          if (
            candidate > 0
            && candidate < words.length
            && /[,;:—–-]$/.test(words[candidate - 1])
          ) {
            boundary = candidate;
            break;
          }
        }
        if (boundary !== -1) break;
      }
      splitIndex = index;
      splitAt = boundary === -1 ? midpoint : boundary;
      largestWords = words.length;
    });
    if (splitIndex === -1 || splitAt <= 0) break;
    const words = chunks[splitIndex].trim().split(/\s+/);
    chunks.splice(
      splitIndex,
      1,
      words.slice(0, splitAt).join(' '),
      words.slice(splitAt).join(' ')
    );
  }
  while (chunks.length < targetCount) chunks.push('');
  while (chunks.length > targetCount) {
    const tail = chunks.pop();
    chunks[chunks.length - 1] = `${chunks[chunks.length - 1]} ${tail}`.trim();
  }
  return chunks;
};

export const buildScenePlanningPrompt = (videoModel) => {
  const isKling      = videoModel === 'kwaivgi/kling-v3-video';
  const isKlingTurbo = videoModel === 'kwaivgi/kling-v2.5-turbo-pro';
  const isFast       = videoModel === 'lightricks/ltx-2-fast';
  const isVeo        = videoModel === 'veo-3.1-fast' || videoModel === 'windows-default';
  const isGrok       = videoModel === 'grok-3';

  const allowedDurations = isVeo
    ? 'exactly 8 (every scene is 8 seconds)'
    : isGrok
    ? '6, 10, or 15'
    : isKlingTurbo
    ? '5 or 10'
    : isKling
      ? 'any integer from 3 to 15'
      : isFast
        ? 'any even number from 6 to 20 (6, 8, 10, 12, 14, 16, 18, 20)'
        : '6, 8, or 10';

  const avgDuration   = isKlingTurbo ? 7 : isKling ? 8 : isFast ? 14 : isGrok ? 10 : 8;
  const climateDur    = isKlingTurbo ? '10s' : isKling ? '12-15s' : isFast ? '18-20s' : isVeo ? '8s' : isGrok ? '15s' : '10s';
  const atmosphereDur = isKlingTurbo ? '10s' : isKling ? '10-12s' : isFast ? '14-16s' : isGrok ? '10s' : '8s';

  const durationGuide = isVeo ? `
- 8 seconds is the SOURCE CLIP generation length, not a requirement to hold one composition in the final edit for eight seconds.
- Author the internal editorial rhythm separately: kinetic scenes normally contain 3 genuinely different visual beats, standard scenes 2, and deliberate scenes 1.
- A later stage may generate one 8-second source clip for each visual beat and trim it to its useful action window. Put the essential action first and do not pad a beat merely to fill the provider output.` : isGrok ? `
- 6 seconds: Quick cuts, reactions, fast action beats
- 10 seconds: Standard beats, dialogue, building tension — prefer this as your baseline
- 15 seconds: Establishing shots, emotional peaks, slow reveals, climax moments` : isKlingTurbo ? `
- 5 seconds: Quick cuts, reactions, action beats, transitions
- 10 seconds: Establishing shots, emotional peaks, slow reveals, climax moments` : isKling ? `
- 3-4 seconds: Very quick cuts, reaction shots
- 5-6 seconds: Fast cuts, action beats
- 7-8 seconds: Standard beats, building tension
- 9-10 seconds: Establishing shots, emotional moments
- 11-13 seconds: Slow reveals, dramatic peaks
- 14-15 seconds: Epic establishing shots, maximum impact climax moments` : isFast ? `
- 6 seconds: ONLY for very fast cuts, sharp reactions, sudden action beats — use sparingly
- 8 seconds: Quick beats, punchy transitions
- 10 seconds: Standard dialogue and character moments
- 12 seconds: Establishing shots, emotional beats — prefer this as your baseline
- 14 seconds: Slow reveals, dramatic tension — use frequently
- 16 seconds: Epic establishing shots, important narrative turns
- 18-20 seconds: Maximum impact sweeping reveals, climax moments — use generously for key scenes
NOTE: The model handles up to 20s natively. Favour 12-20s for most scenes to make full use of the model's capability.` : `
- 6 seconds: Quick cuts, reactions, fast action beats
- 8 seconds: Standard beats, dialogue, building tension
- 10 seconds: Establishing shots, emotional peaks, slow reveals, critical moments`;

  return `You are a Lead Cinematic Director and storyboard architect. Create detailed shot lists with SMART pacing based on story content.

INPUT: Selected story object + maxMinutes constraint.

CRITICAL CONSTRAINT: Video durations can ONLY be ${allowedDurations} seconds. No other values allowed.

JSON FIELD RULES (MANDATORY):
- NEVER use "N/A", "none", "unknown", or empty strings for any field.
- clothing: ALWAYS specify a COMPLETE head-to-toe period-accurate outfit. MANDATORY components: (1) upper body garment, (2) lower body garment, (3) NAMED footwear with type (e.g. "brown leather ankle boots", "iron-buckled black leather oxfords", "worn canvas sandals", "knee-high riding boots", "hobnail leather brogues"). Example: "coarse wool tunic, dark linen breeches, worn brown leather ankle boots". NEVER leave any component unspecified. NEVER omit footwear.
- action: ALWAYS describe a specific physical action (e.g. "raises torch above head", "kneels examining ground").
- weather: ALWAYS use a real condition (e.g. "clear", "overcast", "light rain", "heavy fog", "scorching sun").
- time_of_day: ALWAYS use a real time (e.g. "dawn", "midday", "dusk", "night", "golden hour").
- key_props: ALWAYS list at least one relevant prop from the scene. Never an empty array.

SMART PACING ALGORITHM (FOLLOW EXACTLY):

Step 1: ESTIMATE scene count from duration
- A moment needing 30 seconds = 3-4 scenes with varied angles (wide→medium→close)
- A moment needing 15 seconds = 2 scenes
- ALWAYS break long moments into multiple scenes with camera progression

Step 2: Analyze narrative importance and assign scene count
- HOOK moments: 3-4 scenes (establishing → medium → close-up → reaction)
- CLIMAX/PEAK moments: 4-5 scenes with ${climateDur} durations, slow reveals
- ACTION moments: 5-6 scenes of short duration (rapid cuts, different angles)
- DRAMATIC reveals: 2-3 scenes (setup → hold → payoff)
- TRANSITIONS: Single short scene
- ATMOSPHERIC: 1-2 scenes of ${atmosphereDur}

Step 3: Duration per scene (ONLY USE ${allowedDurations})${durationGuide}

Step 4: Camera progression for multi-scene moments
- Always vary shot_type: wide → medium → close-up OR establishing → detail
- Each scene gets unique visual_description and camera_intent
- Maintain continuity across related scenes

Step 5: Plan the INTERNAL VISUAL BEATS of every scene
- pacing_profile must be exactly "kinetic", "standard", or "deliberate".
- kinetic: normally 3 visual beats inside the scene. Use for physical action, urgent discoveries, reversals, confrontations, procedural work, and hooks with several concrete facts.
- standard: normally 2 visual beats. Use for most documentary exposition: establish the concrete situation, then reveal evidence, consequence, reaction, or a more informative detail.
- deliberate: normally 1 visual beat. Reserve for an earned emotional hold, geography-establishing view, singular reveal, or moment where cutting would weaken comprehension.
- visual_beat_count MUST equal visual_beats.length.
- Every beat must change the viewer's information: a new action phase, evidence, consequence, reaction, spatial relationship, or story-relevant detail. A closer crop of the same unchanged pose is NOT a new beat.
- Do not manufacture constant cuts. Pace follows information density and emotional intent, with deliberate holds used as contrast.
- Narration remains fluent continuous documentary speech. Never create fragmentary narration merely to justify more cuts.

Step 6: Assign scenario identity for visual continuity
- scenario_id is a stable semantic slug for the SAME physical environment and continuity state, such as "rural-roadside-arrest-day".
- Reuse the exact same scenario_id when the story returns to that same setup, even after unrelated scenes in other places. Scenario groups are semantic, never based only on adjacency.
- Use a different scenario_id when location, era, time of day, weather, set dressing, or the relevant continuity state materially changes.
- scenario_continuity must name the fixed environment anchors that should recur: layout, structures, vehicles, vegetation, weather, light direction, surface conditions, and persistent props.
- environment_family_id is the broader connected continuity world used for scene sheets. Reuse it across related zones that can coexist in one coherent spatial model (for example bank corridor + visible vault interior), including non-adjacent returns. Never use it merely because two places share a mood.
- environment_family_continuity must explain their stable spatial relationship plus shared time, light, weather, architecture, persistent props, wardrobe state, and story-time state. Change the family when any of those anchors become incompatible.

Step 7: Verify totals
- Sum of all duration_seconds ≈ maxMinutes × 60
- Expected scenes = total_seconds / ${avgDuration} (roughly)

OUTPUT FORMAT:
Return ONLY valid JSON matching this exact schema. Ensure scene_ids follow s01, s02 format.`;
};

router.post('/scene-planning', async (req, res) => {
  try {
    const { story, maxMinutes, videoModel } = req.body;
    // Derive model-specific values once — reused in both system prompt and user content.
    // buildScenePlanningPrompt() already encodes these; mirror them here for the user message.
    const isKlingTurbo     = videoModel === 'kwaivgi/kling-v2.5-turbo-pro';
    const isKling          = videoModel === 'kwaivgi/kling-v3-video';
    const isFast           = videoModel === 'lightricks/ltx-2-fast';
    const isVeo            = videoModel === 'veo-3.1-fast' || videoModel === 'windows-default';
    const isGrok           = videoModel === 'grok-3';
    const allowedDurations = isVeo ? 'exactly 8 (every scene is 8 seconds)'
      : isGrok ? '6, 10, or 15'
      : isKlingTurbo ? '5 or 10'
      : isKling ? 'any integer from 3 to 15'
      : isFast  ? 'any even number from 6 to 20 (6, 8, 10, 12, 14, 16, 18, 20)'
      : '6, 8, or 10';
    const avgDuration      = isKlingTurbo ? 7 : isKling ? 8 : isFast ? 14 : isGrok ? 10 : 8;
    const maxSceneDuration = isKlingTurbo ? 10 : isKling ? 15 : isFast ? 20 : isVeo ? 8 : isGrok ? 15 : 10;
    const minActionDur     = isFast ? 8 : isVeo ? 8 : isGrok ? 6 : 6;
    const standardBeatDur  = isFast ? '12-14s' : isKling ? '6-10s' : isVeo ? '8s' : isGrok ? '10s' : '6-8s';

    const suppliedVoiceover = story.input_mode === 'script'
      ? String(story.provided_voiceover || '').trim()
      : '';
    const sourceScriptDirection = suppliedVoiceover ? `
SUPPLIED-VOICEOVER CONTRACT:
- The user supplied the complete main voiceover below. It is authoritative.
- Plan visuals around that voiceover; do not invent a replacement narration.
- Do not add, remove, paraphrase, reorder, or polish any of its words.
- The application will mechanically assign exact sentence-boundary spans to the returned scenes after planning.

AUTHORITATIVE MAIN VOICEOVER:
${suppliedVoiceover}
` : '';

    const userContent = `Create a SMART scene plan for this documentary story:

Title: ${story.title}
Summary: ${story.summary}
Era: ${story.era}
Location: ${story.location}
Narrative Beats: ${story.narrative_beats?.join(', ') || 'Not provided'}
Target Duration: ${maxMinutes ? `${maxMinutes} minutes (${maxMinutes * 60} seconds total)` : 'No duration constraint'}
${sourceScriptDirection}

CRITICAL RULES:
- duration_seconds can ONLY be ${allowedDurations}
- Each scene gets its OWN visual_description and shot_type
- Total duration_seconds MUST ≈ ${maxMinutes ? maxMinutes * 60 : 360} seconds
- Expect ~${maxMinutes ? Math.round(maxMinutes * 60 / avgDuration) : Math.round(360 / avgDuration)} scenes

PACING:
- Climax moments: 4-5 scenes × ${maxSceneDuration}s, varied angles (wide→medium→close)
- Action sequences: 5-6 scenes × ${minActionDur}s (rapid cuts)
- Dramatic reveals: 2-3 scenes (setup→hold→payoff)
- Standard beats: 1-2 scenes × ${standardBeatDur}
- Inside each scene, choose a truthful pacing_profile and plan its distinct visual_beats. Kinetic normally means 3 beats, standard 2, and deliberate 1.
- A visual beat must reveal new story information or advance the physical action. Do not repeat the same pose or event at a different crop just to fill time.
- Preserve fluent narration across these picture changes. Faster visual pacing must never produce staccato voiceover.
- Give every scene a semantic scenario_id. Reuse it for later non-adjacent scenes only when they return to the same physical setup and continuity state.
- Give every scene an environment_family_id. Reuse it only for exact or physically connected continuity zones that could be authored together without inventing geography. This is the grouping signal for optional 2–6-shot scene sheets.

Return ONLY this JSON. Every field must have a real, specific value — never "N/A", "none", or vague placeholders:
{
  "scene_plan": {
    "total_scenes": <NUMBER>,
    "total_duration_seconds": <SUM>,
    "scenes": [
      {
        "scene_id": "s01",
        "scene_number": 1,
        "narrative_beat": "hook",
        "importance": "critical",
        "duration_seconds": ${isFast ? 14 : isKling ? 10 : isKlingTurbo ? 10 : isGrok ? 10 : 8},
        "pacing_profile": "kinetic",
        "visual_beat_count": 3,
        "visual_beats": [
          {
            "beat": "establish the immediate obstacle",
            "action": "soldiers brace against the wind while scanning the empty approach",
            "shot_type": "wide"
          },
          {
            "beat": "reveal the first concrete warning",
            "action": "the lead guard spots movement and raises the torch as the formation reacts",
            "shot_type": "medium"
          },
          {
            "beat": "land on the evidence that changes the situation",
            "action": "a gloved hand tightens around the spear as distant silhouettes appear below",
            "shot_type": "detail"
          }
        ],
        "scenario_id": "storm-fortress-battlements-dusk",
        "scenario_continuity": "same western battlement, wet dark stone, iron torch brackets, overcast dusk, cold wind from camera right, warm torchlight from frame left",
        "environment_family_id": "storm-fortress-western-defenses-dusk",
        "environment_family_continuity": "western battlement connects directly to its stone stair and guard corridor; same stormy dusk, wet masonry, torch placement, cold camera-right wind, uniforms, and pre-attack story state",
        "shot_type": "wide",
        "camera_intent": "Slow push-in reveals scale of the fortress walls",
        "visual_description": "Torchlit stone ramparts at dusk, soldiers in formation on the battlements",
        "mannequin_details": {
          "count": 2,
          "action": "stands at attention gripping spear, scanning the horizon",
          "clothing": "iron chainmail hauberk over linen gambeson with iron helmet, rough wool breeches, iron-buckled brown leather knee boots",
          "porcelain_tone": "off-white"
        },
        "environment": {
          "time_of_day": "dusk",
          "weather": "overcast with distant lightning",
          "key_props": ["iron spears", "burning torch brackets", "stone battlements"]
        }
      }
    ]
  }
}`;
    
    const text = await callClaude(req, buildScenePlanningPrompt(videoModel), userContent);
    const data = safeParseJSON(text);
    const plan = data.scene_plan || data;
    if (suppliedVoiceover && Array.isArray(plan.scenes)) {
      const chunks = splitVoiceoverAtSentenceBoundaries(suppliedVoiceover, plan.scenes.length);
      plan.scenes = plan.scenes.map((scene, index) => ({
        ...scene,
        source_narration: chunks[index] || '',
        narration_locked: true,
      }));
      plan.source_voiceover_locked = true;
    }
    res.json(plan);
  } catch (error) {
    console.error('Scene planning error:', error);
    res.status(500).json({ error: true, message: error.message, code: 'SCENE_PLANNING_ERROR' });
  }
});

const IMAGE_PROMPT_SYSTEM = `You are a cinematic concept artist specializing in photorealistic previsualization for documentary recreations.

INPUT: Scene objects from the Scene Plan, each containing visual_description, shot_type, mannequin_details, and environment.

VISUAL STYLE MANDATE (NON-NEGOTIABLE):
- Figures: Seamless glossy porcelain mannequins with perfectly smooth finish - like high-quality ceramic figurines or museum display mannequins.
- Surface: Smooth glossy porcelain, pristine and unblemished - NO cracks, NO texture, NO weathering on the mannequin itself.
- NO doll joints, NO visible articulation points, NO seams.
- Hands and limbs bend with correct underlying human joint anatomy beneath an uninterrupted porcelain surface; never show finger-segment lines, wrist seams, ball joints, hinges, or panel lines.
- NO visible stands, rods, or support structures attached to the mannequins. Mannequins appear free-standing or naturally posed.
- Faces: Featureless smooth porcelain surface (no eyes, nose, mouth details carved in).
- Skin tone: Off-white/cream porcelain OR warm brown porcelain depending on character ethnicity. NEVER realistic human skin colors.
- Hair: Mannequins CAN have painted or sculpted hair appropriate to the character and era.
- WARDROBE CONTINUITY RULE: Mannequins wear complete, period-accurate outfits. For wide or full-body shots, explicitly name the upper garment, lower garment, and footwear. For medium shots and close-ups, describe ONLY the garments naturally visible in the requested crop; keep the remaining outfit consistent but off-frame. NEVER force trousers, skirts, legs, or footwear into a close-up that does not naturally show them.
- SCENARIO CONTINUITY RULE: scenario_id identifies the same physical setup even when matching scenes are not adjacent. For every scene sharing a scenario_id, preserve the supplied scenario_continuity anchors exactly: geography/layout, recurring structures and vehicles, vegetation, weather, time-of-day light direction, surface conditions, and persistent props. A changed camera position may reveal another side of the set but must not redesign it.
- Pose: Body language and gestures convey emotion despite featureless faces.
- ANATOMY: Every mannequin uses life-size, age-appropriate realistic human proportions and physically plausible joints, hands, fingers, posture, balance, and limb lengths. Never render toy-like, chibi, doll, bobblehead, miniature, compressed, fused, duplicated, or malformed anatomy.
- STYLE AT EVERY IMAGE PLANE: Every visible person is a porcelain mannequin even when unnamed, blurred, distant, reflected, photographed, or shown inside a monitor, television, phone, projection, bodycam recording, or archival footage. A nested image or screen is NEVER permission to render photorealistic humans.
- COUNT ZERO DOES NOT OVERRIDE STYLE: mannequin_details.count=0 means no direct foreground cast member is staged. If the scene description still includes people in a crowd, background, reflection, screen, photograph, or recording, those people remain anatomically correct porcelain mannequins.
- MATERIAL SEPARATION: Porcelain applies only to people. Props and environments retain their real materials, weight, and texture—wood stays natural wood, metal stays metal, fabric stays fabric, glass stays glass. Never turn a gavel, weapon, furniture, vehicle, tool, or other prop into a glossy porcelain toy or fuse it into the mannequin.

CRITICAL: Do NOT include "Unreal Engine 5" or any engine names as text in the image.

VISUAL-NARRATION SYNC:
The image MUST directly illustrate what the narrator is saying in this scene. If narrator says "Keeper Walsh fought to close the iron door", the image shows a mannequin in full period clothing fighting to close an iron door. The visual matches the spoken words.

CINEMATOGRAPHY VOCABULARY TO USE:

Shot types — pick the most dramatically appropriate for the variation:
- Extreme wide / aerial establishing: Subject tiny, vast environment dominates
- Wide establishing: Full environment context, subject readable in frame
- Medium shot: Subject waist-up, environment visible as context
- Medium close-up: Chest-up, face/expression body language readable
- Close-up: Head and shoulders or single object, emotional weight
- Extreme close-up / macro: Texture detail — fingers, fabric weave, sweat on porcelain, droplets
- Two-shot: Two figures in frame, spatial relationship conveyed
- Over-the-shoulder: One figure seen from behind, looking toward subject or horizon
- POV shot: Camera placed at subject eye-level looking outward

Camera angles — layer onto shot type:
- Eye-level: Neutral, observational, documentary feel
- Low angle (worm's eye): Power, dominance, looming threat, heroism
- High angle (bird's eye): Vulnerability, isolation, God's-eye overview
- Dutch angle (canted frame, 15–30°): Psychological unease, disorientation, tension
- Overhead / top-down: Patterns, scale, entrapment
- Canted extreme (45°+): Chaos, collapse, extreme psychological disturbance

Lens character — inject as texture into the prompt:
- 14mm ultra-wide: Extreme environmental scale, slight barrel distortion, claustrophobia in tight spaces
- 24mm wide: Classic cinematic wide, clean perspective, documentary feel
- 35mm: Natural field of view, intimate without distortion
- 50mm: Neutral "human eye" perspective, objective clarity
- 85mm portrait: Compressed background, subject isolation, emotional intimacy
- 135–200mm telephoto: Heavy background compression, subject extracted from environment, voyeuristic distance
- Fisheye (full-frame or circular): Extreme distortion, paranoia, dreamlike or supernatural feel, curved horizon
- Anamorphic widescreen: Oval bokeh, lens flares on highlights, cinematic 2.39:1 feel, horizontal streaks

Depth of field:
- Razor-thin DOF (f/1.4–f/2): Subject razor-sharp, background melts into abstract colour
- Shallow DOF (f/2.8–f/4): Subject sharp, background soft and painterly
- Deep focus (f/8–f/16): Both foreground and background sharp, everything in play
- Split focus diopter: Two planes in simultaneous focus, foreground object AND distant subject both sharp

LIGHTING VOCABULARY — choose specifically, never use "studio lighting" as a catch-all:

Natural / atmospheric:
- Golden hour: Warm amber-orange raking light, long shadows stretching across ground
- Magic hour / blue hour: Cool blue twilight, soft shadowless illumination, melancholic
- Harsh midday sun: Hard overhead light, deep black shadows, bleached highlights
- Overcast diffused: Flat even grey light, no shadows, quiet and sombre
- Moonlight: Cool blue-silver, sharp hard shadows, high contrast silver highlights
- Firelight / torchlight: Flickering amber-orange, dancing shadows, hot bright centre with deep surrounding darkness
- Candlelight: Intimate warm point-source, very low key, pools of orange in darkness
- Lightning flash: Instant harsh white illumination, freezes motion, creates stark shadows
- Foggy diffusion: Light scatters through mist, halos around sources, flat and eerie
- Underwater caustics: Rippling light patterns on surfaces, shifting blue-green

Cinematic / artificial:
- Chiaroscuro (Rembrandt): Strong single-source light carving one side of subject, deep shadow opposite
- Hard rim / kicker light: Bright edge light separating subject from dark background, hair and shoulder highlighted
- God rays / crepuscular rays: Shafts of volumetric light through fog, smoke, or gaps in architecture
- Practical lights in frame: Lanterns, fires, windows — light source visible and driving the scene
- Neon / coloured gel: Saturated coloured light casting, red/blue/green toned shadows
- High-key: Bright, low contrast, flat — clinical, oppressive brightness
- Low-key / noir: Predominantly dark, small pools of light, heavy shadows dominate
- Three-point lighting: Key + fill + rim, controlled and balanced
- Silhouette: Subject backlit, front completely dark, form only
- Contre-jour (shooting into light): Subject lit from behind, glowing edges, foreground in shadow
- Bioluminescence / practical glow: Objects emit their own eerie blue-green or amber light

Atmospheric / rendering texture:
- Volumetric fog / god rays: Visible light shafts, atmospheric depth
- Lens flare: Deliberate flare from bright source — add "anamorphic lens flare" for horizontal streaks
- Motion blur on environment: Background slightly blurred, suggests speed or wind
- Chromatic aberration: Slight colour fringing at edges, adds photographic realism
- Film grain overlay: 35mm grain texture, analogue feel
- Heat haze / atmospheric distortion: Shimmering air above hot surfaces

COMPOSITION FRAMEWORK:
"Photorealistic render, ray tracing, Octane render, [lens + camera angle + shot type], [environment/weather], [only the porcelain mannequin anatomy and clothing naturally visible inside this crop] showing EXACTLY what narrator describes, [specific lighting setup], [atmospheric texture], [props], 8K resolution, [DOF specification], no visible stands or supports, hyperrealistic"

MANDATORY RULES FOR EVERY PROMPT (ALL 4 VARIATIONS PER SCENE):
- EVERY prompt containing any visible person must contain "seamless glossy porcelain mannequin"; this includes people visible only inside screens, photos, reflections, or recordings
- WIDE/FULL-BODY shots must specify the complete outfit: upper garment, lower garment, and named footwear
- MEDIUM/CLOSE-UP/DETAIL shots must specify only the clothing and anatomy visible inside the crop. Never mention a face when the frame is on hands; never mention trousers or footwear when legs and feet are outside frame
- Include "featureless smooth porcelain face, no eyes/nose/mouth" only when a face is actually visible. For hand/object inserts, explicitly state that head, face, torso, legs, and footwear are outside frame
- EVERY prompt must include the specific action from mannequin_details.action
- EVERY prompt must include "8K resolution, no visible stands or supports, hyperrealistic"
- Do not invent a foreground mannequin in a truly figure-free environment or object insert. If a person or human body part is visible anywhere, the porcelain style is mandatory
- Every visible figure must have life-size realistic human anatomy and proportions, natural limb lengths and joints, and exactly five proportional fingers per visible hand. Explicitly reject toy, chibi, doll, bobblehead, miniature, compressed, fused, extra-limbed, or malformed anatomy
- EVERY prompt must specify a NAMED lighting setup (e.g. "chiaroscuro single-source torchlight", "golden hour raking backlight", "moonlit rim light with deep shadow fill") — never just "dramatic lighting" or "cinematic lighting"
- EVERY prompt must specify a LENS CHARACTER (e.g. "14mm ultra-wide", "85mm portrait lens", "anamorphic widescreen", "fisheye") matched to the emotional intent of the variation
- EVERY prompt must specify a DEPTH OF FIELD (e.g. "razor-thin DOF f/1.8, background dissolves to amber bokeh", "deep focus f/11, every plane sharp")
- Use varied lighting and lens choices ACROSS the 4 variations — do not repeat the same lens or lighting setup twice in one scene

OUTPUT FORMAT:
Return ONLY valid JSON. Generate 4 distinct variations per scene (Establishing, Intimate, Detail, Atmospheric).

EXAMPLE OUTPUT (follow this structure and level of detail exactly — note the varied lens, lighting, and DOF across all 4 variations):
{
  "scenes": [
    {
      "scene_id": "s01",
      "scene_number": 1,
      "variations": [
        {
          "variation_id": "s01_v1_establishing",
          "type": "establishing",
          "prompt": "Photorealistic render, ray tracing, Octane render, 14mm ultra-wide extreme establishing shot looking up at storm-lashed fortress on rocky cliff, seamless glossy porcelain mannequin in iron chainmail hauberk over linen gambeson with iron helmet stands at attention gripping spear on the battlements, featureless smooth porcelain face, off-white porcelain skin tone, massive waves crashing below, dark storm clouds with crepuscular god rays breaking through, practical torchlight bracketing the frame with warm amber against cold storm grey, volumetric fog rolling across the cliff face, deep focus f/11 every plane sharp from foreground rocks to distant horizon, anamorphic widescreen lens flare on torch bracket, iron spears and burning torch brackets visible, 8K resolution, no visible stands or supports, hyperrealistic"
        },
        {
          "variation_id": "s01_v2_intimate",
          "type": "intimate",
          "prompt": "Photorealistic render, ray tracing, Octane render, 85mm portrait lens medium shot waist-up, seamless glossy porcelain mannequin in iron chainmail hauberk over linen gambeson with iron helmet scanning the horizon with hand raised to brow, featureless smooth porcelain face, off-white porcelain skin tone, chiaroscuro single-source torchlight carving the left side of the mannequin in warm amber while the right side falls into deep blue-grey storm shadow, shallow DOF f/2.8 — stone battlements behind dissolve into soft grey bokeh, rain streaking past catching the torchlight as bright silver streaks, iron spear gripped in other hand, 8K resolution, no visible stands or supports, hyperrealistic"
        },
        {
          "variation_id": "s01_v3_detail",
          "type": "detail",
          "prompt": "Photorealistic render, ray tracing, Octane render, 135mm telephoto extreme close-up on hands of seamless glossy porcelain mannequin gripping iron spear shaft, iron chainmail hauberk sleeves visible, off-white porcelain fingers wrapped tight around worn iron, razor-thin DOF f/1.4 — spear grip tack-sharp, chainmail rings dissolve into warm amber bokeh behind, practical torchlight reflecting as a hot white specular highlight off smooth glossy porcelain knuckle surface, individual raindrops on chainmail rings caught mid-fall, chromatic aberration fringing at frame edges, stone battlement edge barely visible in soft focus background, 8K resolution, no visible stands or supports, hyperrealistic"
        },
        {
          "variation_id": "s01_v4_atmospheric",
          "type": "atmospheric",
          "prompt": "Photorealistic render, ray tracing, Octane render, fisheye lens low Dutch angle 25° canted frame, seamless glossy porcelain mannequin in iron chainmail hauberk and iron helmet silhouetted contre-jour against lightning-lit storm clouds, featureless smooth porcelain face turned skyward catching a single lightning flash as cold white rim light along helmet edge and shoulder pauldrons, surrounding scene drops into near-black low-key darkness, off-white porcelain surface catching lightning specular, curved fisheye horizon warps the battlement walls inward, rain streaking horizontally across distorted frame, burning torch brackets visible as small warm amber points in the deep black, deep focus f/8 everything distorted but sharp, 8K resolution, no visible stands or supports, hyperrealistic"
        }
      ],
      "continuity_checklist": ["Mannequin in all 4 variations", "Iron chainmail consistent across shots", "Storm weather consistent", "Torch practical lighting present in all shots", "Off-white porcelain tone consistent"]
    }
  ]
}`;

// Addendum applied when scenes are split into sequential segments (the scene's
// narration audio outlasts a single video clip, so multiple shots are needed).
export const buildSegmentAddendum = (variationsPerSegment) => `

SEQUENTIAL SEGMENTS (CRITICAL — READ CAREFULLY):
Each scene now contains a "segments" array. Each segment is a SEPARATE SEQUENTIAL SHOT of the same scene — together they play back-to-back to cover the scene's narration audio.
- visual_beats is the authored editorial progression. When visual_beats.length equals segments.length, segment_index N MUST execute visual_beats[N] exactly, including its action and shot_type.
- When there are more segments than visual_beats, subdivide the matching beat into genuine sequential action phases without inventing a new event. When there are fewer segments, combine adjacent beats in causal order while preserving their most informative visual change.
- Segment 1 does not always need to be a wide establishing shot. Follow the assigned authored beat. Establish context only when the viewer genuinely needs it.
- Each following segment must ADVANCE information — a later action phase, evidence, consequence, reaction, spatial relationship, or story-relevant detail. A different crop of the same unchanged pose is a duplicate and is forbidden.
- Keep hard continuity across segments: same mannequin(s), same clothing (exact outfit), same environment, same weather and time of day, same key props. Only the action, framing, and camera evolve.
- Think like a film editor cutting on meaning. Vary shot scale when it strengthens the beat, but never force a mechanical wide → medium → close pattern onto an event that does not earn it.
- Generate exactly ${variationsPerSegment} distinct variation(s) per segment (vary lens/lighting/angle across variations of the SAME beat — variations are alternatives for the same shot, segments are different sequential shots).

OUTPUT FORMAT OVERRIDE (MANDATORY WHEN SEGMENTS ARE PRESENT):
Return ONLY valid JSON in this exact shape:
{
  "scenes": [
    {
      "scene_id": "s01",
      "scene_number": 1,
      "segments": [
        {
          "segment_index": 0,
          "variations": [ { "variation_id": "s01_seg0_v1", "type": "establishing", "prompt": "..." } ]
        },
        {
          "segment_index": 1,
          "variations": [ { "variation_id": "s01_seg1_v1", "type": "continuation", "prompt": "..." } ]
        }
      ],
      "continuity_checklist": ["..."]
    }
  ]
}`;

export const buildImagePromptScenesData = (sourceScenes = [], useSegments = false) => (
  sourceScenes.map(scene => ({
    scene_id: scene.scene_id,
    scene_number: scene.scene_number,
    visual_description: scene.visual_description,
    shot_type: scene.shot_type,
    camera_intent: scene.camera_intent,
    mannequin_details: scene.mannequin_details,
    environment: scene.environment,
    pacing_profile: scene.pacing_profile,
    visual_beat_count: scene.visual_beat_count,
    visual_beats: scene.visual_beats,
    scenario_id: scene.scenario_id,
    scenario_continuity: scene.scenario_continuity,
    environment_family_id: scene.environment_family_id,
    environment_family_continuity: scene.environment_family_continuity,
    ...(useSegments ? {
      segments: (scene.segments?.length ? scene.segments : [{ segment_index: 0 }]).map(seg => ({
        segment_index: seg.segment_index ?? 0,
        covers_seconds: seg.target_duration || undefined,
        narration: seg.narration || undefined,
      }))
    } : {})
  }))
);

router.post('/image-prompts', async (req, res) => {
  try {
    enforceSonnetPromptAuthor(req);
    const { scenePlan, scenes: scenesOverride, variationsPerSegment } = req.body;

    // Accept either a full scenePlan or a pre-sliced scenes array (for batching)
    const sourceScenes = scenesOverride || scenePlan?.scenes || [];

    if (sourceScenes.length === 0) {
      return res.status(400).json({
        error: true,
        message: 'No scenes provided — pass either a scenePlan with scenes or a scenes array override.',
        code: 'NO_SCENES'
      });
    }

    const useSegments = sourceScenes.some(s => Array.isArray(s.segments) && s.segments.length > 0);
    const variations = Math.min(4, Math.max(1, parseInt(variationsPerSegment) || 4));

    const scenesData = buildImagePromptScenesData(sourceScenes, useSegments);

    const systemPrompt = useSegments
      ? IMAGE_PROMPT_SYSTEM + buildSegmentAddendum(variations)
      : IMAGE_PROMPT_SYSTEM;
    // A user-supplied custom prompt overrides the default inside callClaude —
    // make sure the segment contract survives the override too
    if (useSegments && req.body.systemPrompt?.trim()) {
      req.body.systemPrompt = req.body.systemPrompt + buildSegmentAddendum(variations);
    }

    const userContent = `Create image prompts for these scenes following all rules and the example format in your instructions:

${JSON.stringify(scenesData, null, 2)}`;

    const text = await callClaude(req, systemPrompt, userContent, {
      noSessionPersistence: true,
    });
    const parsed = safeParseJSON(text);

    // Normalise to array — Claude sometimes returns { scenes: [...] } or a plain object
    let scenes;
    if (Array.isArray(parsed)) {
      scenes = parsed;
    } else if (parsed && typeof parsed === 'object') {
      const candidate = parsed.scenes || parsed.image_prompts || parsed.variations;
      if (Array.isArray(candidate)) {
        scenes = candidate;
      } else {
        const vals = Object.values(parsed);
        if (vals.length > 0 && vals.every(v => v && typeof v === 'object')) {
          scenes = vals;
        } else {
          return res.status(500).json({
            error: true,
            message: 'LLM returned an object instead of an array for image prompts — could not coerce to array',
            code: 'IMAGE_PROMPTS_NOT_ARRAY',
            raw: parsed
          });
        }
      }
    } else {
      return res.status(500).json({
        error: true,
        message: 'LLM returned unexpected type for image prompts',
        code: 'IMAGE_PROMPTS_NOT_ARRAY'
      });
    }

    // When segments were requested, guarantee every scene comes back with a
    // segments array — wrap legacy flat variations as a single segment 0.
    if (useSegments) {
      scenes = scenes.map(scene => {
        if (Array.isArray(scene.segments) && scene.segments.length > 0) return scene;
        return {
          ...scene,
          segments: [{ segment_index: 0, variations: scene.variations || [] }]
        };
      });
    }

    scenes = hardenImagePromptScenes(scenes, sourceScenes);
    res.json(scenes);
  } catch (error) {
    console.error('Image prompts error:', error);
    res.status(500).json({ error: true, message: error.message, code: 'IMAGE_PROMPTS_ERROR' });
  }
});

const VIDEO_PROMPT_SYSTEM = `Direct restrained, cinematic documentary motion from each selected still frame.

Use the scene narration and visual description to choose the single most important visible action. Prefer a near-locked frame, slow push, gentle pullback, subtle pan, slight tilt, lateral track, small orbit, or rack focus. Environmental motion must be physically motivated and secondary to the story beat. Preserve the project's glossy porcelain mannequin visual language and period detail. End every clip on a composed, stable frame that can cut cleanly to the next shot.`;

router.post('/video-prompts', async (req, res) => {
  try {
    enforceSonnetPromptAuthor(req);
    const { scenePlan, scenes: scenesOverride, selectedImages } = req.body;

    // Accept either a full scenePlan or a pre-sliced scenes array (for batching)
    const sourceScenes = scenesOverride || scenePlan?.scenes || [];

    if (sourceScenes.length === 0) {
      return res.status(400).json({
        error: true,
        message: 'No scenes provided — pass either a scenePlan with scenes or a scenes array override.',
        code: 'NO_SCENES'
      });
    }

    // Segment-aware requests send one entry per (scene, segment) with a
    // segment_index; legacy requests have one entry per scene (no segment_index)
    const useSegments = sourceScenes.some(s => s.segment_index !== undefined && s.segment_index !== null);

    const sceneData = sourceScenes.map(scene => {
      const selected = (selectedImages || []).find(img =>
        img.scene_number === scene.scene_number &&
        (!useSegments || (img.segment_index ?? 0) === (scene.segment_index ?? 0))
      );
      return {
        scene_id: scene.scene_id,
        scene_number: scene.scene_number,
        segment_index: scene.segment_index ?? 0,
        segment_count: scene.segment_count || 1,
        duration_seconds: scene.duration_seconds,
        target_duration: scene.target_duration,
        action_duration_seconds: scene.action_duration_seconds,
        usable_duration_seconds: scene.usable_duration_seconds,
        editorial_duration_seconds: scene.editorial_duration_seconds,
        clip_duration: scene.clip_duration,
        playback_rate: scene.playback_rate,
        narration: scene.narration || undefined,
        full_scene_narration: scene.full_scene_narration || undefined,
        visual_description: scene.visual_description,
        camera_intent: scene.camera_intent,
        mannequin_details: scene.mannequin_details,
        environment: scene.environment,
        selected_prompt: selected?.prompt || scene.selected_prompt || '',
        continuity_context: scene.continuity_context || undefined,
        previous_selected_prompt: scene.previous_selected_prompt || undefined,
        previous_ending_state: scene.previous_ending_state || undefined,
      };
    });

    const customDirection = req.body.systemPrompt?.trim();
    const isLegacyUnsafeVideoSystem = customDirection
      && /CAMERA MOVEMENT VOCABULARY|VIDEO STYLE MANDATE|Motion Format:\s*"\[camera motion\]/i.test(customDirection);
    const creativeDirection = customDirection
      && customDirection !== VIDEO_PROMPT_SYSTEM.trim()
      && !isLegacyUnsafeVideoSystem
      ? customDirection
      : VIDEO_PROMPT_SYSTEM;
    const protectedSystemPrompt = buildMotionPromptSystem(creativeDirection);

    const authorBatch = async (repairIssues = []) => {
      const userContent = buildMotionPromptUserContent(sceneData, { useSegments, repairIssues });
      const text = await callClaude(req, protectedSystemPrompt, userContent, {
        ignoreSystemOverride: true,
        noSessionPersistence: true,
      });
      const parsed = safeParseJSON(text);
      const prompts = coerceVideoPromptArray(parsed);
      if (!prompts) throw new Error('LLM returned an invalid motion-prompt collection.');
      return prompts;
    };

    let videoPrompts;
    try {
      videoPrompts = await authorBatch();
      let validationIssues = validateMotionPromptBatch(videoPrompts, sceneData);
      if (validationIssues.length > 0) {
        console.warn(`[video-prompts] Structured response failed validation; retrying once: ${validationIssues.join(' | ')}`);
        videoPrompts = await authorBatch(validationIssues);
        validationIssues = validateMotionPromptBatch(videoPrompts, sceneData);
      }
      if (validationIssues.length > 0) {
        const reason = `AI response remained incomplete after repair: ${validationIssues.join(' ')}`;
        console.warn(`[video-prompts] ${reason} Using protected local fallback.`);
        videoPrompts = createFallbackMotionPromptBatch(sceneData, reason);
      }
    } catch (authoringError) {
      const reason = `AI motion authoring failed: ${authoringError.message}`;
      console.warn(`[video-prompts] ${reason} Using protected local fallback.`);
      videoPrompts = createFallbackMotionPromptBatch(sceneData, reason);
    }

    const fallbackIssues = validateMotionPromptBatch(videoPrompts, sceneData);
    if (fallbackIssues.length > 0) {
      throw new Error(`Protected motion prompt fallback failed validation: ${fallbackIssues.join(' ')}`);
    }

    res.json(composeMotionPromptBatch(videoPrompts, sceneData));
  } catch (error) {
    console.error('Video prompts error:', error);
    res.status(500).json({ error: true, message: error.message, code: 'VIDEO_PROMPTS_ERROR' });
  }
});

const TTS_SCRIPT_SYSTEM = `You are an elite documentary narrator and audio director writing for text-to-speech synthesis and final video timeline assembly.
INPUT: story object + scene_plans array (with exact durations).

VOICE & TONE:
- Begin in motion with the story's strongest concrete tension. Use an exact date or place when it helps the listener enter the scene, not as a mandatory template.
- Present tense throughout — past events narrated as if happening now.
- Numbers are ALWAYS specific. Never "millions" — always "$400 million". Never "many days" — always "six hours". Exact figures create authority.
- Build emphasis through specific facts, consequences, and sentence rhythm. Do not repeat phrases, force parallelism, or stack fragments merely to sound dramatic.
- Open curiosity loops only where the story earns them. Vary questions, discoveries, consequences, and time shifts instead of ending every section with the same cliffhanger shape.
- Use second person sparingly and only when it sounds natural in the established documentary voice.
- Use contractions and spoken syntax. Do not use em dashes, en dashes, or double-hyphen substitutes in spoken lines.
- NO visual references ("as we can see here"). Audio must stand alone.
- Never tabloid. The style is cold, precise, urgent — not sensationalist.

FLOW ACROSS SCENES (the most common failure — read carefully):
- The scene list is a camera plan, NOT a sentence plan. Write the narration first as ONE continuous piece of prose in your head, then distribute complete sentences across the scenes. A viewer must never be able to hear where one scene ends and the next begins.
- Each scene's lines CONTINUE the running thought: pick up the previous scene's sentence rhythm, use connective tissue ("But", "By morning", "Three hundred miles away", "What Walsh doesn't know is…").
- Favor full, flowing sentences with subordinate clauses that carry the story forward. A short fragment ("It simply arrived.") is a spice — at most one per three scenes, and only at a genuine dramatic beat. A run of consecutive short phrases reads as random words and is forbidden.
- A single scene usually carries one fuller sentence or two connected ones — never a pile of clipped statements.
- Trailer, overview, transition, and scene units are one playback sequence. Write that sequence as continuous prose first, then partition it at complete-sentence boundaries.

GEOGRAPHY FOR THE MAP (when the story moves through space):
- When events travel, name the geography concretely: cities, countries, compass directions, distances, borders. "From Sagan they scatter — south toward Czechoslovakia, north to the Baltic ports, three hundred miles to neutral Sweden."
- Concrete narrated geography is what earns the film its map moments; a map is only ever shown for places and movements the narration actually names.
- Never force geography into a story that doesn't move. When it exists, be specific enough that a mapmaker could draw exactly what you said.

TIMING GUIDANCE:
- Target roughly 2.0–2.5 spoken words per planned second across the complete playback sequence, with a hard production ceiling of 2.65. Fluency comes from restructuring fragments, not adding more facts.
- Use scene duration as a pacing reference only — a 6s scene suggests a short punchy moment; a 10s scene can carry a fuller thought.
- A strong line may exceed one unit's estimate because recorded audio controls the final split, but compensate elsewhere so the complete script remains within its production budget.
- Make every word count. Combine fragments with concise connective tissue; do not solve choppiness by bloating the script.
- Do not count bracketed audio/SFX cues toward spoken word estimates.

AUDIO DESIGN & PACING CUES (NEW):
You must act as the audio mixer and video editor. Include bracketed cues on their own separate lines within the lines array to dictate the exact flow of the scene.
- Use [INTENSITY:UP] or [INTENSITY:DOWN] right before a line where the narrator's volume or urgency must shift.
- Use [SFX:... ] for literal sound effects (e.g., [SFX:LOUD_THUNDER_CRACK], [SFX:HEAVY_RAIN_ON_METAL]).
- Use [BGM:... ] to dictate background music shifts (e.g., [BGM:TENSION_RISE], [BGM:DRAMATIC_PAUSE]).
- Use [CUT:HARD] only for a genuinely designed hard cut. Never use it to conceal a broken narration transition.

OUTPUT FORMAT:
Return ONLY valid JSON matching this exact schema. Bracketed cues must be their own separate string items in the lines array (acting as line breaks).`;

const spokenLines = (unit) => (unit?.lines || []).filter(line => !String(line).startsWith('['));
const clampNumber = (value, min, max, fallback) => {
  const number = Number(value);
  return Math.min(max, Math.max(min, Number.isFinite(number) ? number : fallback));
};

export const normalizeCinemaNarration = (rawCinema, scenePlan, options) => {
  const sceneCount = scenePlan.scenes.length;
  const cinema = { options: { ...options } };

  if (options.trailerEnabled && rawCinema?.trailer) {
    const targetSeconds = clampNumber(rawCinema.trailer.target_seconds, 8, 14, 10);
    const candidateScenes = [...new Set(
      (rawCinema.trailer.candidate_scenes || rawCinema.trailer.shots || [])
        .map(item => Number(item?.scene_number ?? item))
        .filter(scene => scene >= 1 && scene <= sceneCount)
    )];
    const narration = {
      unit_id: 'cinema:trailer',
      scene_id: 'cinema:trailer',
      cinema_type: 'trailer',
      duration: targetSeconds,
      lines: rawCinema.trailer.narration?.lines || rawCinema.trailer.lines || [],
      timing_notes: rawCinema.trailer.narration?.timing_notes || 'Cold-open voiceover over the peak-shot montage.',
      delivery_instructions: rawCinema.trailer.narration?.delivery_instructions || 'Controlled urgency; finish on an open loop.',
    };
    if (candidateScenes.length >= 3 && spokenLines(narration).length) {
      cinema.trailer = {
        title: rawCinema.trailer.title || '',
        subtitle: rawCinema.trailer.subtitle || '',
        target_seconds: targetSeconds,
        candidate_scenes: candidateScenes.slice(0, 8),
        narration,
      };
    }
  }

  if (options.chaptersEnabled) {
    const chapters = (rawCinema?.chapters || [])
      .map((chapter) => ({
        title: String(chapter.title || '').trim(),
        start_scene: Number(chapter.start_scene),
        portrait_prompt: String(chapter.portrait_prompt || '').trim(),
        overview_narration: {
          cinema_type: 'chapter-overview',
          duration: clampNumber(chapter.overview_narration?.duration, 2.5, 6, 3.5),
          lines: chapter.overview_narration?.lines || [],
        },
        transition_narration: {
          cinema_type: 'chapter-transition',
          duration: clampNumber(chapter.transition_narration?.duration, 3, 7, 5),
          lines: chapter.transition_narration?.lines || [],
        },
      }))
      .filter(chapter => (
        chapter.title
        && chapter.portrait_prompt
        && chapter.start_scene >= 1
        && chapter.start_scene <= sceneCount
        && spokenLines(chapter.overview_narration).length
        && spokenLines(chapter.transition_narration).length
      ))
      .sort((a, b) => a.start_scene - b.start_scene)
      .slice(0, 5)
      .map((chapter, index) => {
        const chapterNumber = index + 1;
        return {
          ...chapter,
          chapter_number: chapterNumber,
          overview_narration: {
            ...chapter.overview_narration,
            unit_id: `cinema:overview:${chapterNumber}`,
            scene_id: `cinema:overview:${chapterNumber}`,
            chapter_number: chapterNumber,
          },
          transition_narration: {
            ...chapter.transition_narration,
            unit_id: `cinema:transition:${chapterNumber}`,
            scene_id: `cinema:transition:${chapterNumber}`,
            chapter_number: chapterNumber,
          },
        };
      });
    if (chapters.length >= 2 && chapters[0].start_scene === 1) cinema.chapters = chapters;
  }

  return cinema;
};

export const buildNarrationSequence = (sceneBreakdown, cinema) => {
  const sequence = [];
  if (cinema.trailer?.narration) sequence.push(cinema.trailer.narration);
  for (const chapter of cinema.chapters || []) sequence.push(chapter.overview_narration);
  if (cinema.chapters?.[0] && spokenLines(cinema.chapters[0].transition_narration).length) {
    sequence.push(cinema.chapters[0].transition_narration);
  }

  const transitionByScene = new Map(
    (cinema.chapters || [])
      .filter(chapter => chapter.chapter_number > 1 && spokenLines(chapter.transition_narration).length)
      .map(chapter => [chapter.start_scene, chapter.transition_narration])
  );
  for (const scene of sceneBreakdown || []) {
    const sceneNumber = Number(String(scene.scene_id || '').match(/\d+/)?.[0]);
    const transition = transitionByScene.get(sceneNumber);
    if (transition) sequence.push(transition);
    sequence.push({ ...scene, unit_id: scene.scene_id, cinema_type: 'scene' });
  }
  return sequence;
};

const materializeNarrationDraft = (data, scenePlan, options) => {
  const cinema = normalizeCinemaNarration(data.cinema, scenePlan, options);
  const sceneBreakdown = Array.isArray(data.scene_breakdown) ? data.scene_breakdown : [];
  const narrationSequence = buildNarrationSequence(sceneBreakdown, cinema);
  const fullScript = narrationSequence
    .map(unit => spokenLines(unit).join(' '))
    .filter(Boolean)
    .join(' ');
  const contractIssues = [];
  if (sceneBreakdown.length !== scenePlan.scenes.length) {
    contractIssues.push(`Return exactly ${scenePlan.scenes.length} scene_breakdown entries; received ${sceneBreakdown.length}.`);
  }
  if (options.trailerEnabled && !cinema.trailer) {
    contractIssues.push('Return a complete trailer voiceover with at least three valid candidate scenes.');
  }
  if (options.chaptersEnabled && !cinema.chapters) {
    contractIssues.push('Return at least two complete chapters beginning at scene 1, each with overview and transition voiceover.');
  }
  const continuityAudit = auditNarrationContinuity(narrationSequence);
  return {
    data,
    cinema,
    sceneBreakdown,
    narrationSequence,
    fullScript,
    continuityAudit,
    issues: [...contractIssues, ...continuityAudit.violations],
  };
};

const NARRATION_REPAIR_SYSTEM = `You are the final spoken-narration copy chief. Repair the supplied JSON draft without changing facts, scene order, cinema options, or schema. Preserve the hook's jolt, proof, and tension while translating written-cinematic or fragment-heavy language into fluent speech. Rewrite across unit boundaries as one continuous documentary, then repartition only at complete-sentence boundaries. Do not add facts or inflate the script to create flow; use concise connective syntax and remove repetition to meet the production pacing budget. Fix every listed issue. Return only the complete corrected JSON object.`;

router.post('/tts-script', async (req, res) => {
  try {
    const { story, scenePlan, cinemaOptions = {} } = req.body;

    if (!scenePlan?.scenes) {
      return res.status(400).json({ error: true, message: 'scenePlan.scenes is required', code: 'MISSING_SCENE_PLAN' });
    }
    
    const narrationProfile = buildNarrationSkillPrompt(story, cinemaOptions);
    const protectedSystemPrompt = `${TTS_SCRIPT_SYSTEM}\n\n${narrationProfile.prompt}`;
    const customDirection = req.body.systemPrompt?.trim();
    // Older persisted projects may still carry the former full narration system
    // prompt. Treat it as application code, not user direction: appending it here
    // would restore the exact staccato/forced-cliffhanger rules this protected
    // FacelessOS prompt replaces. Genuine short channel guidance remains supported.
    const isLegacyNarrationSystem = !!customDirection && (
      /You are an elite documentary narrator and audio director/i.test(customDirection)
      || /Repeat key phrases for impact/i.test(customDirection)
      || /End each major section with a cliffhanger question/i.test(customDirection)
      || /Five moments\. One impossible decision/i.test(customDirection)
    );
    const customDirectionSection = customDirection
      && !isLegacyNarrationSystem
      && customDirection !== TTS_SCRIPT_SYSTEM.trim()
      ? `\nChannel-specific direction (apply only when it does not conflict with the FacelessOS continuity and humanization rules):\n${customDirection}\n`
      : '';
    
    const userContent = `Write a narration script for this documentary:

Complete story object:
${JSON.stringify(story, null, 2)}

Complete scene plan:
${JSON.stringify(scenePlan.scenes, null, 2)}

Total Duration: ${scenePlan.total_duration_seconds} seconds
Detected FacelessOS format: ${narrationProfile.format}
The scene narration should remain near the existing production budget. Cinema voiceovers add only the concise words their own requested durations can carry.
${customDirectionSection}

Cinema options:
- Trailer cold open: ${cinemaOptions.trailerEnabled ? 'ENABLED' : 'DISABLED'}
- Chapter system: ${cinemaOptions.chaptersEnabled ? 'ENABLED' : 'DISABLED'}

${cinemaOptions.trailerEnabled ? `TRAILER REQUIREMENTS:
- Write an original 8–14 second spoken hook as one flowing sentence or two naturally connected sentences. It previews the stakes without repeating scene 1 or summarizing the ending.
- At roughly 2.2 spoken words/second, every sentence must earn its place and end on an open loop.
- Never use movie-trailer fragment syntax such as "One tunnel. One night. One chance."
- Select 4–8 distinct candidate scene numbers containing the strongest visual peaks. The editor chooses the exact count after measuring the recorded voiceover.
- The trailer title/subtitle must be elegant and concise.
` : ''}
${cinemaOptions.chaptersEnabled ? `CHAPTER REQUIREMENTS:
- Create 2–5 story chapters. Chapter 1 starts at scene 1; later chapters start only at genuine narrative turns.
- For EACH chapter write one 2.5–6 second overview narration beat that integrates the exact chapter title into a grammatical sentence. The overview beats play consecutively and must sound like one coherent preview paragraph.
- For EACH chapter write a 3–7 second transition narration. Chapter 1 bridges the overview into scene 1; later transitions bridge the preceding scene into the new chapter's first scene. Never announce "Chapter two" mechanically.
- Do not duplicate scene narration. These are connective lines with cinematic momentum.
- Portrait prompts describe one museum-grade vertical character/object portrait without text.
` : ''}

Return JSON:
{
  "script_metadata": {
    "total_spoken_word_count": 35,
    "estimated_duration_seconds": 18,
    "voice_profile": "Serious documentary baritone, moderate pace, dynamic range"
  },
  "scene_breakdown": [
    {
      "scene_id": "s01",
      "duration": 8,
      "spoken_word_count": 24,
      "lines": [
        "[BGM:LOW_RUMBLE]",
        "[SFX:HEAVY_STORM_AMBIENCE]",
        "The storm of 1899 gives the lighthouse keepers no warning, only a horizon turning black before the wind reaches the island."
      ],
      "timing_notes": "First spoken line starts at 2.0s to allow SFX intro",
      "delivery_instructions": "Flat, ominous documentary tone"
    },
    {
      "scene_id": "s02",
      "duration": 10,
      "spoken_word_count": 26,
      "lines": [
        "[SFX:WAVE_CRASH_LOUD]",
        "[INTENSITY:UP]",
        "By four in the morning it is on top of them, and Keeper Walsh is fighting to hold the iron door against an eighty-knot rage."
      ],
      "timing_notes": "The sentence continues the thought from s01, so the seam between scenes must be inaudible.",
      "delivery_instructions": "Vocal urgency spikes, pushing through the loud environment"
    }
  ],
  "cinema": {
    "trailer": ${cinemaOptions.trailerEnabled ? `{
      "title": "The Impossible Choice",
      "subtitle": "TEN DAYS BELOW",
      "target_seconds": 10,
      "candidate_scenes": [1, 3, 5, 7, 4],
      "narration": {
        "lines": ["[BGM:TENSION_RISE]", "Five moments lead to one impossible decision while the clock is already running out."],
        "timing_notes": "Build through the montage and leave the final image hanging.",
        "delivery_instructions": "Low, urgent, restrained."
      }
    }` : 'null'},
    "chapters": ${cinemaOptions.chaptersEnabled ? `[
      {
        "title": "Thirty-Three Below",
        "start_scene": 1,
        "portrait_prompt": "Museum-grade vertical portrait relevant to this chapter...",
        "overview_narration": {
          "duration": 3.5,
          "lines": ["Thirty-Three Below follows the moment when survival becomes a calculation."]
        },
        "transition_narration": {
          "duration": 5,
          "lines": ["Before anyone can reach them, the mountain has to reveal where it buried them."]
        }
      },
      {
        "title": "The Machine From the War",
        "start_scene": 4,
        "portrait_prompt": "Museum-grade vertical portrait relevant to the second chapter...",
        "overview_narration": {
          "duration": 3.5,
          "lines": ["The Machine From the War brings in the stranger willing to drive it."]
        },
        "transition_narration": {
          "duration": 5,
          "lines": ["Now the rescue waits on one machine, and the man flying toward it."]
        }
      }
    ]` : 'null'}
  },
  "phonetic_guides": {
    "Walsh": "WOLSH"
  }
}`;
    
    const options = {
      chaptersEnabled: !!cinemaOptions.chaptersEnabled,
      trailerEnabled: !!cinemaOptions.trailerEnabled,
    };
    let text = await callClaude(req, protectedSystemPrompt, userContent, { ignoreSystemOverride: true });
    const suppliedVoiceover = story?.input_mode === 'script'
      ? String(story.provided_voiceover || '').trim()
      : '';
    const applyLockedNarration = (parsed) => {
      if (!suppliedVoiceover) return parsed;
      const chunks = splitVoiceoverAtSentenceBoundaries(suppliedVoiceover, scenePlan.scenes.length);
      const existing = Array.isArray(parsed.scene_breakdown) ? parsed.scene_breakdown : [];
      parsed.scene_breakdown = scenePlan.scenes.map((scene, index) => {
        const prior = existing.find(item => item.scene_id === scene.scene_id) || existing[index] || {};
        const locked = scene.source_narration || chunks[index] || '';
        return {
          ...prior,
          scene_id: scene.scene_id,
          duration: Number(prior.duration) || Number(scene.duration_seconds) || 8,
          spoken_word_count: locked.split(/\s+/).filter(Boolean).length,
          lines: locked ? [locked] : [],
          narration_locked: true,
        };
      });
      return parsed;
    };
    const preserveLockedDraft = (draft) => {
      if (!suppliedVoiceover) return draft;
      // User-authored main narration is immutable. The continuity copy chief
      // may validate generated cinema additions, but it may never "repair"
      // the supplied words merely because their style differs from FacelessOS.
      return {
        ...draft,
        issues: draft.issues.filter(issue =>
          /^Return exactly|^Return a complete trailer|^Return at least two complete chapters/.test(issue)
        ),
      };
    };
    let draft = preserveLockedDraft(
      materializeNarrationDraft(applyLockedNarration(safeParseJSON(text)), scenePlan, options)
    );

    for (let attempt = 1; draft.issues.length > 0 && attempt <= 2; attempt++) {
      console.warn(`[tts-script] FacelessOS audit failed; repair ${attempt}/2: ${draft.issues.join(' | ')}`);
      const repairContent = `Repair this documentary narration draft.

Detected format: ${narrationProfile.format}
Cinema options: ${JSON.stringify(options)}
Required scene count: ${scenePlan.scenes.length}

Audit issues:
${draft.issues.map((issue, index) => `${index + 1}. ${issue}`).join('\n')}

Complete story:
${JSON.stringify(story, null, 2)}

Complete scene plan:
${JSON.stringify(scenePlan.scenes, null, 2)}

Draft JSON:
${JSON.stringify(draft.data, null, 2)}`;
      text = await callClaude(
        req,
        `${protectedSystemPrompt}\n\n${NARRATION_REPAIR_SYSTEM}`,
        repairContent,
        { ignoreSystemOverride: true }
      );
      draft = preserveLockedDraft(
        materializeNarrationDraft(applyLockedNarration(safeParseJSON(text)), scenePlan, options)
      );
    }

    if (draft.issues.length > 0) {
      throw new Error(`Narration failed the FacelessOS continuity audit after repair: ${draft.issues.join(' ')}`);
    }
    
    res.json({
      script: draft.fullScript,
      scene_breakdown: draft.sceneBreakdown,
      cinema: draft.cinema,
      narration_sequence: draft.narrationSequence,
      cinema_options: options,
      writing_profile: {
        format: narrationProfile.format,
        references: narrationProfile.references,
        continuity_audit: draft.continuityAudit,
      },
      word_count: draft.fullScript.split(/\s+/).filter(Boolean).length,
      estimated_duration_seconds: draft.narrationSequence.reduce((sum, unit) => sum + (Number(unit.duration) || 0), 0),
      phonetic_guides: draft.data.phonetic_guides || {}
    });
  } catch (error) {
    console.error('TTS script error:', error);
    res.status(500).json({ error: true, message: error.message, code: 'TTS_SCRIPT_ERROR' });
  }
});

const CHARACTER_EXTRACTION_SYSTEM = `You are a documentary continuity supervisor performing a cast-completeness audit.

Identify every stable visual identity that needs a reusable reference image across a documentary. Work from BOTH the finalized narration and the visual scene plan. Include:
- every named primary subject, even when only a small number of scenes depict them;
- every named or unnamed person whose same identity must remain recognizable across two or more visual scenes;
- a one-scene person only when that person's identity is narratively central and must be recognizable elsewhere in the film.

Exclude anonymous crowds, generic officers/guards/workers, archival background figures, and genuinely one-shot roles whose identity never needs to recur. Never impose an arbitrary cast-size limit.

Before returning, audit every narration unit and visual scene for named people, role-based recurring people, aliases, and pronouns. Merge aliases for the same person. List every excluded candidate and the exact continuity reason for excluding them. Return only valid JSON.`;

router.post('/characters/extract', async (req, res) => {
  const controller = new AbortController();
  const cancelIfDisconnected = () => {
    if (!res.writableEnded) controller.abort();
  };
  res.once('close', cancelIfDisconnected);
  try {
    const { story, scenePlan, narration } = req.body;
    if (!story || !Array.isArray(scenePlan?.scenes)) {
      return res.status(400).json({ error: true, message: 'story and scenePlan.scenes are required' });
    }
    const storyContext = buildCharacterStoryContext(story);
    const sceneContext = buildCharacterSceneContext(scenePlan, narration);
    const text = await callClaudeCli('sonnet', CHARACTER_EXTRACTION_SYSTEM, `Extract the recurring visual cast for this documentary.

STORY:
${JSON.stringify(storyContext, null, 2)}

SCENES:
${JSON.stringify(sceneContext, null, 2)}

Return:
{
  "characters": [{
    "id": "stable-lowercase-id",
    "name": "display name",
    "role": "narrative role",
    "character_type": "person|animal|personified-object",
    "description": "identity-defining physical traits, approximate age, ethnicity when documented, hair silhouette, build, posture, immutable appearance, and the neutral identity-defining wardrobe",
    "scene_numbers": [1, 3],
    "importance": "primary|supporting"
  }],
  "candidate_audit": {
    "candidate_count": 7,
    "excluded": [{
      "name": "candidate name or stable role",
      "reason": "specific reason this identity is scene-local and needs no reusable reference"
    }],
    "coverage_notes": "brief confirmation of which narration and visual material was checked"
  }
}`, {
      noSessionPersistence: true,
      timeoutMs: 3 * 60_000,
      effort: 'low',
      signal: controller.signal,
    });
    const data = safeParseJSON(text);
    const normalized = normalizeExtractedCharacters(data, scenePlan.scenes.length);
    res.json({ ...normalized, model: 'sonnet' });
  } catch (error) {
    if (controller.signal.aborted && !res.headersSent) return;
    console.error('Character extraction error:', error);
    res.status(500).json({ error: true, message: error.message, code: 'CHARACTER_EXTRACTION_ERROR' });
  } finally {
    res.off('close', cancelIfDisconnected);
  }
});

router.post('/characters/link', async (req, res) => {
  try {
    const { characters, scenePlan, narration } = req.body;
    if (!Array.isArray(characters) || !Array.isArray(scenePlan?.scenes)) {
      return res.status(400).json({ error: true, message: 'characters and scenePlan.scenes are required' });
    }
    if (characters.length === 0) return res.json({ links: {}, model: 'sonnet' });
    const sceneContext = buildCharacterSceneContext(scenePlan, narration);
    const text = await callClaudeCli('sonnet',
      'You are a strict visual continuity editor. Link only characters who must visibly appear in each scene. Narration mentions alone are insufficient when the person is not shown. Return only valid JSON.',
      `AVAILABLE CHARACTERS:
${JSON.stringify(characters.map(({ id, name, role, description }) => ({ id, name, role, description })), null, 2)}

SCENES:
${JSON.stringify(sceneContext.map(scene => ({
  ...scene,
  action: scene.mannequin_details?.action,
})), null, 2)}

Return:
{"links":[{"scene_number":1,"character_ids":["exact-character-id"],"reason":"why each linked character is visibly required"}]}`,
      { noSessionPersistence: true, timeoutMs: 15 * 60_000 }
    );
    const data = safeParseJSON(text);
    const validIds = new Set(characters.map(character => character.id));
    const links = Object.fromEntries((data.links || []).map(link => [
      String(link.scene_number),
      {
        character_ids: [...new Set((link.character_ids || []).filter(id => validIds.has(id)))],
        reason: link.reason || '',
      },
    ]));
    res.json({ links, model: 'sonnet' });
  } catch (error) {
    console.error('Character linking error:', error);
    res.status(500).json({ error: true, message: error.message, code: 'CHARACTER_LINKING_ERROR' });
  }
});

// ─── Expressive (tagged) narration script — ported from Storyforge ──────────
// Rewrites the plain narration with inline audio tags (emotion / delivery /
// pauses / reactions) for expressive TTS engines like ElevenLabs v3.

const EXPRESSIVE_SCENES_PER_CHUNK = 18;
const EXPRESSIVE_CONTEXT_SENTENCES = 5;
const EXPRESSIVE_TAG_PATTERN = /\[([^\]]+)\]/g;
const EXPRESSIVE_SENTENCE_PATTERN = /[^.!?]+(?:[.!?]+["')\]]*|$)/g;

const EXPRESSIVE_ALLOWED_TAGS = new Set([
  'tense', 'calm', 'excited', 'nervous', 'frustrated', 'sorrowful', 'wistful',
  'awe', 'matter-of-fact', 'curious', 'angry', 'happy', 'melancholic',
  'whispers', 'drawn out', 'hesitates', 'rushed', 'stammers',
  'pause', 'short pause',
  'sighs', 'laughs', 'gasps', 'exhales', 'clears throat',
]);
const EXPRESSIVE_DELIVERY_TAGS = new Set(['whispers', 'drawn out', 'hesitates', 'rushed', 'stammers']);
const EXPRESSIVE_PAUSE_TAGS = new Set(['pause', 'short pause', 'sighs', 'laughs', 'gasps', 'exhales', 'clears throat']);
const EXPRESSIVE_EMOTION_TAGS = new Set(
  [...EXPRESSIVE_ALLOWED_TAGS].filter(t => !EXPRESSIVE_DELIVERY_TAGS.has(t) && !EXPRESSIVE_PAUSE_TAGS.has(t))
);

const normalizeExpressiveTag = (rawTag) => {
  const normalized = rawTag.trim().toLowerCase().replace(/\s+/g, ' ');
  if (normalized === 'long pause' || normalized === 'long-pause') return 'pause';
  return EXPRESSIVE_ALLOWED_TAGS.has(normalized) ? normalized : null;
};

const inferDeliveryTag = (sentence, previousTag) => {
  const text = sentence.toLowerCase();
  if (/\?/.test(sentence) || /\b(why|what|where|who|wonder|curious|ask|asked)\b/.test(text)) return 'curious';
  if (/\b(fire|flame|smoke|storm|thunder|lightning|wind|wolves|rifle|danger|terror|panic|heat|burn|burned|ash|ruin|nightmare|roof|dark|gale|cold|scared)\b/.test(text)) return 'tense';
  if (/\b(cried|cry|tears|grief|dead|death|lonely|alone|loss|lost|sorrow|broke|heartbreaking|not enough|couldn't|can't)\b/.test(text)) return 'sorrowful';
  if (/\b(beautiful|dawn|sun|gold|green|miracle|understood|impossibly|honor|love|prairie|sky|stars)\b/.test(text)) return 'awe';
  if (/\b(remembers?|counting|numbers?|list|invoice|rule|because|that was|there was|it was|this is|here is|by the time|instead)\b/.test(text)) return 'matter-of-fact';
  if (/\b(smiled|laugh|happy|married|wedding|thank you)\b/.test(text)) return 'happy';
  if (/\b(quiet|soft|still|steady|peaceful|calm|gentle|silence)\b/.test(text)) return 'calm';
  if (/\b(remembered|porch|old woman|thirty years|used to|watched over|dream)\b/.test(text)) return 'wistful';
  return EXPRESSIVE_EMOTION_TAGS.has(previousTag) ? previousTag : 'matter-of-fact';
};

// Guarantees every sentence carries a delivery tag and only allowed tags survive
const enforceTaggedScriptDensity = (text) => {
  const sanitized = text.replace(/\[long[- ]pause\]/gi, '[pause]');
  const parts = sanitized.split(EXPRESSIVE_TAG_PATTERN);
  const output = [];
  let pendingTags = [];
  let previousDeliveryTag = 'matter-of-fact';

  const hasDeliveryTag = (tags) =>
    tags.some(tag => EXPRESSIVE_EMOTION_TAGS.has(tag) || EXPRESSIVE_DELIVERY_TAGS.has(tag));

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part) continue;

    if (i % 2 === 1) {
      const normalizedTag = normalizeExpressiveTag(part);
      if (!normalizedTag) continue;
      pendingTags.push(normalizedTag);
      if (EXPRESSIVE_EMOTION_TAGS.has(normalizedTag) || EXPRESSIVE_DELIVERY_TAGS.has(normalizedTag)) {
        previousDeliveryTag = normalizedTag;
      }
      continue;
    }

    const sentences = (part.match(EXPRESSIVE_SENTENCE_PATTERN) || []).map(s => s.trim()).filter(Boolean);
    for (const sentence of sentences) {
      if (!hasDeliveryTag(pendingTags)) {
        pendingTags.push(inferDeliveryTag(sentence, previousDeliveryTag));
      }
      const uniqueTags = [...new Set(pendingTags)];
      output.push(`${uniqueTags.map(tag => `[${tag}]`).join(' ')} ${sentence}`.trim());
      const deliveryTag = uniqueTags.find(tag => EXPRESSIVE_EMOTION_TAGS.has(tag) || EXPRESSIVE_DELIVERY_TAGS.has(tag));
      if (deliveryTag) previousDeliveryTag = deliveryTag;
      pendingTags = [];
    }
  }

  if (pendingTags.length > 0) {
    output.push([...new Set(pendingTags)].map(tag => `[${tag}]`).join(' '));
  }

  return output.join('\n\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
};

const EXPRESSIVE_SYSTEM_PROMPT = `You are a seasoned audio director preparing a documentary narration script for expressive text-to-speech engines such as ElevenLabs v3, GenAI Pro, and Gemini TTS.

Your job is to deeply analyze the text — its emotional arc, dramatic beats, and the specific delivery each sentence demands — and embed inline expression tags that will make the narration feel genuinely alive.

AVAILABLE TAGS (use ONLY these, never invent new ones):
  Emotion:  [tense] [calm] [excited] [nervous] [frustrated] [sorrowful] [wistful] [awe] [matter-of-fact] [curious] [angry] [happy] [melancholic]
  Delivery: [whispers] [drawn out] [hesitates] [rushed] [stammers]
  Pauses:   [pause] [short pause]
  Reactions:[sighs] [laughs] [gasps] [exhales] [clears throat]

HOW TO ANALYZE:
- Read each sentence and ask: "What emotion is the narrator carrying right now? How should this land in the listener's ear?"
- Tag every sentence where the emotional delivery is clear and specific. Most sentences should have a tag.
- A sentence that reveals betrayal needs [sorrowful] or [tense]. A sentence that reframes history needs [matter-of-fact] or [curious]. A moment of beauty needs [calm] or [awe]. Tag accordingly.
- Preserve the authored punctuation and use tags to shape delivery. Do not introduce dashes, fragment the sentences, or rewrite the prose while adding expression.
- Insert [pause] or [short pause] between sentences when the weight of what was just said needs a moment to land.
- Reactions like [sighs], [exhales], [gasps] go BETWEEN sentences at emotionally charged turning points.

TRANSITION RULE (critical):
- Never jump directly between opposing extremes: e.g. [chaotic] → [calm], [angry] → [happy], [excited] → [sorrowful].
- Use [matter-of-fact] or [pause] as a bridge when the tone needs to shift dramatically. Let the shift feel like a breath, not a cut.
- Sustain an emotion across consecutive sentences when the content warrants it — don't tag every sentence with a different emotion.

HARD RULES:
- DO NOT modify, reorder, add, or remove any original words or sentences. The text is sacred.
- Tags go BEFORE the sentence they affect, or BETWEEN sentences as reactions/pauses.
- Do NOT place tags mid-sentence (inside a sentence).
- Never use [long pause] or [long-pause]. Use [pause] instead.
- Return ONLY the tagged narration text. No commentary, no markdown, no section headers.`;

const lastNSentences = (text, n) => {
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [];
  return sentences.slice(-n).join(' ').trim();
};
const firstNSentences = (text, n) => {
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [];
  return sentences.slice(0, n).join(' ').trim();
};

router.post('/expressive-script', async (req, res) => {
  try {
    const { sceneBreakdown } = req.body;
    if (!Array.isArray(sceneBreakdown) || sceneBreakdown.length === 0) {
      return res.status(400).json({ error: true, message: 'sceneBreakdown is required', code: 'MISSING_SCENE_BREAKDOWN' });
    }

    // Plain spoken text per chunk of scenes (cue lines stripped)
    const sceneTexts = sceneBreakdown.map(scene => {
      const text = (scene.lines || []).filter(line => !line.startsWith('[')).join(' ').trim();
      if (!text) return '';
      return scene.cinema_type && scene.cinema_type !== 'scene'
        ? `[pause] ${text} [pause]`
        : text;
    }).filter(Boolean);

    const chunks = [];
    for (let i = 0; i < sceneTexts.length; i += EXPRESSIVE_SCENES_PER_CHUNK) {
      chunks.push(sceneTexts.slice(i, i + EXPRESSIVE_SCENES_PER_CHUNK).join(' '));
    }

    // Sequential — chunk order matters for tonal continuity, and the local
    // Claude CLI handles one request at a time anyway
    const taggedChunks = [];
    for (let i = 0; i < chunks.length; i++) {
      const prevContext = i > 0 ? lastNSentences(chunks[i - 1], EXPRESSIVE_CONTEXT_SENTENCES) : '';
      const nextContext = i < chunks.length - 1 ? firstNSentences(chunks[i + 1], EXPRESSIVE_CONTEXT_SENTENCES) : '';

      const prevSection = prevContext
        ? `PRECEDING CONTEXT (DO NOT tag — use only to maintain tonal continuity at the start of your output):\n${prevContext}\n\n`
        : '';
      const nextSection = nextContext
        ? `\n\nUPCOMING CONTEXT (DO NOT tag — ensure your last tag leads smoothly into this):\n${nextContext}`
        : '';

      const userContent = `${prevSection}SCRIPT TO TAG:\n${chunks[i]}${nextSection}`;

      try {
        const result = await callClaude(req, EXPRESSIVE_SYSTEM_PROMPT, userContent);
        taggedChunks.push(enforceTaggedScriptDensity(result.trim()));
      } catch (err) {
        console.error(`expressive-script: chunk ${i + 1}/${chunks.length} failed:`, err.message);
        // Fall back to auto-tagged plain text for this chunk
        taggedChunks.push(enforceTaggedScriptDensity(chunks[i]));
      }
    }

    const script = enforceTaggedScriptDensity(taggedChunks.join(' '));
    res.json({ script });
  } catch (error) {
    console.error('Expressive script error:', error);
    res.status(500).json({ error: true, message: error.message, code: 'EXPRESSIVE_SCRIPT_ERROR' });
  }
});

const METADATA_SYSTEM = `You are a YouTube SEO strategist optimizing documentary content for algorithmic distribution.
INPUT: story object + scene_plans array + TTS script object.

TITLE ARCHITECTURE (4 Hooks):
1. Curiosity Gap: Hint at info without revealing ("The Truth About X...")
2. Specificity: Concrete numbers/dates ("Trapped for 72 Hours...")
3. Emotional Trigger: Stakes/consequences ("How X Led to Tragedy")
4. Contrarian: Challenge assumptions ("Why X Was Actually Y")

DESCRIPTION & CHAPTER RULES:
- First 150 chars of description must be an irresistible hook.
- Chapter timestamps must be calculated mathematically by accumulating the actual duration_seconds of the scenes. Start with "0:00 Introduction".

OUTPUT FORMAT:
Return ONLY valid JSON matching this exact schema.`;

router.post('/metadata', async (req, res) => {
  try {
    const { story, scenePlan, ttsScript } = req.body;

    if (!scenePlan?.scenes) {
      return res.status(400).json({ error: true, message: 'scenePlan.scenes is required', code: 'MISSING_SCENE_PLAN' });
    }

    let cumulativeTime = 0;
    const sceneTiming = scenePlan.scenes.map(s => {
      const start = cumulativeTime;
      const dur = Number(s.duration_seconds) || 0;  // guard against undefined/NaN
      cumulativeTime += dur;
      return { scene_id: s.scene_id, start_seconds: start, duration: dur };
    });
    
    const userContent = `Generate YouTube metadata for this documentary:

Title: ${story.title}
Summary: ${story.summary}
Era: ${story.era}

Total Duration: ${scenePlan.total_duration_seconds} seconds
Scene Count: ${scenePlan.scenes.length}
Script Word Count: ${ttsScript?.word_count || 400}

Scene Timing (for chapters):
${sceneTiming.map(s => `${s.scene_id}: starts at ${s.start_seconds}s`).join('\n')}

Return JSON:
{
  "metadata": {
    "titles": ["Title 1", "Title 2", "Title 3", "Title 4"],
    "description": "Full SEO description with hook in first 150 chars...",
    "tags": ["tag1", "tag2", "tag3"],
    "chapters": [
      {"timestamp": "0:00", "label": "Introduction"},
      {"timestamp": "0:08", "label": "Scene 1 Label"}
    ],
    "thumbnail_prompt": "Base concept for thumbnail with bold text overlay",
    "seo_notes": {
      "primary_keyword": "main keyword"
    }
  }
}`;
    
    const text = await callClaude(req, METADATA_SYSTEM, userContent);
    const data = safeParseJSON(text);
    const metadata = data.metadata || data;
    res.json(metadata);
  } catch (error) {
    console.error('Metadata error:', error);
    res.status(500).json({ error: true, message: error.message, code: 'METADATA_ERROR' });
  }
});

const THUMBNAIL_PROMPT_SYSTEM = `You are a YouTube Thumbnail Creative Director and CTR (Click-Through Rate) Psychologist specializing in viral documentary content.
INPUT: selected_title + story object.

STORY EXTRACTION MANDATE:
Before generating prompts, you MUST analyze the story object to identify the "Peak Dramatic Beat" (the highest-stakes moment, the imminent disaster, the shocking reveal, or the desperate struggle). The thumbnails MUST be built entirely around this specific, high-intensity narrative moment.

YOUTUBE CTR PSYCHOLOGY (NON-NEGOTIABLE):
- The image must show a "fraction of a second before disaster" OR "peak kinetic action".
- Use extreme visual contrast (e.g., tiny subject vs. massive threat, bright light in pitch black).
- Body language must scream urgency, fear, or overwhelming struggle.
- Backgrounds should be clear but secondary to the immediate threat/action.

TECHNICAL AESTHETIC MANDATE:
- Maintain seamless glossy porcelain mannequin aesthetic: smooth off-white or warm brown porcelain finish, NO cracks, NO texture on mannequin, NO doll joints, NO articulation points, featureless faces, period-appropriate hair, detailed realistic clothing.
- Inject high-kinetic visual tags: "flying debris", "motion blur", "particle effects", "sparks", "driving rain".
- Use aggressive lighting tags: "harsh rim lighting", "blinding god rays", "strobe lightning", "high-contrast cinematic grading".
- Use dramatic camera lenses: "14mm ultra-wide angle" (for scale) or "200mm compressed macro" (for claustrophobia).

CRITICAL: Do NOT include "Unreal Engine 5" or any engine names as text in the thumbnail.

COMPOSITION ARCHETYPES (Generate 1 of each):
1. The Imminent Threat: The fraction of a second before the disaster strikes the unaware/trapped subject.
2. The Desperate Action: Subject caught mid-movement, fighting against impossible odds.
3. The Terrifying Scale: Extreme forced perspective showing how massive the danger is compared to the tiny figure.
4. The Shocking Discovery: A blindingly lit, high-contrast reveal of the story's central mystery or climax.

OUTPUT FORMAT:
Return ONLY valid JSON matching this exact schema.`;

router.post('/thumbnail-prompts', async (req, res) => {
  try {
    const { story, selectedTitle } = req.body;
    
    const userContent = `Generate 4 high-intensity thumbnail prompts for this documentary:

Title: ${story.title}
Summary: ${story.summary}
Era: ${story.era}
Location: ${story.location}
Narrative Beats: ${story.narrative_beats?.join(', ') || 'Not provided'}
Dramatic Highlights: ${story.dramatic_highlights?.join(', ') || 'Not provided'}

Selected Video Title: "${selectedTitle}"

CRITICAL: First, identify the PEAK DRAMATIC BEAT of this story. Then build all 4 thumbnails around that exact moment of maximum tension.

Return JSON:
{
  "story_climax_analysis": {
    "peak_moment_identified": "Description of the most intense moment",
    "core_emotion": "The primary emotion viewers should feel",
    "key_visual_elements": ["element1", "element2", "element3"]
  },
  "thumbnail_prompts": [
    {
      "variation": "imminent_threat",
      "target_title": "${selectedTitle}",
      "prompt": "YouTube thumbnail, photorealistic cinematic render, ray tracing, Octane render, [specific peak moment description with kinetic action], seamless glossy porcelain mannequin, extreme visual contrast, harsh rim lighting, bold text reading 'TITLE SNIPPET', 8K, [appropriate lens choice]",
      "design_rationale": "Why this composition drives clicks",
      "color_palette": ["#hex1", "#hex2", "#hex3"],
      "text_treatment": "Position and style of text"
    },
    {
      "variation": "desperate_action",
      "target_title": "${selectedTitle}",
      "prompt": "Full prompt with peak kinetic action..."
    },
    {
      "variation": "terrifying_scale",
      "target_title": "${selectedTitle}",
      "prompt": "Full prompt showing massive threat vs tiny figure..."
    },
    {
      "variation": "shocking_discovery",
      "target_title": "${selectedTitle}",
      "prompt": "Full prompt with high-contrast reveal..."
    }
  ]
}`;
    
    const text = await callClaude(req, THUMBNAIL_PROMPT_SYSTEM, userContent);
    const data = safeParseJSON(text);
    const prompts = data.thumbnail_prompts || data.prompts || data;
    if (!Array.isArray(prompts)) {
      return res.status(500).json({
        error: true,
        message: 'LLM returned an object instead of an array for thumbnail prompts — could not coerce to array',
        code: 'THUMBNAIL_PROMPTS_NOT_ARRAY',
        raw: prompts
      });
    }
    res.json({ 
      prompts: prompts.map(p => typeof p === 'string' ? p : p.prompt),
      story_climax_analysis: data.story_climax_analysis 
    });
  } catch (error) {
    console.error('Thumbnail prompts error:', error);
    res.status(500).json({ error: true, message: error.message, code: 'THUMBNAIL_PROMPTS_ERROR' });
  }
});

// Expose default system prompts so the frontend can pre-fill the Advanced editor
router.get('/default-prompts', (req, res) => {
  res.json({
    story:           STORY_SYSTEM_PROMPT,
    scenePlanning:   buildScenePlanningPrompt('lightricks/ltx-2-pro'),
    imagePrompts:    IMAGE_PROMPT_SYSTEM,
    videoPrompts:    VIDEO_PROMPT_SYSTEM,
    ttsScript:       TTS_SCRIPT_SYSTEM,
    metadata:        METADATA_SYSTEM,
    thumbnailPrompts: THUMBNAIL_PROMPT_SYSTEM,
  })
})

export default router;
