---
name: model-selection-guide
description: Choose the right Claude model and workflow for FacelessOS scriptwriting. Covers the model lineup, the judgment-matching principle, plan selection, research workflows, and common mistakes.
---

# Model Selection Guide

Choose the right Claude model for each step of the FacelessOS workflow.

## CRITICAL: HOW CLAUDE WEB WORKS

**In Claude web (claude.ai), each chat is locked to ONE model.**

You cannot switch models mid-conversation. When you start a chat, you pick a model, and that chat stays on that model.

**This means:**
- "Split workflow" = SEPARATE CHATS with different models
- You copy/paste research from one chat into another
- Or use a completely different tool (Perplexity) for research

---

## THE PRINCIPLE: MATCH THE MODEL TO THE JUDGMENT THE STEP NEEDS

Model names change over time. This principle doesn't. Every step in the FacelessOS workflow (Research → Brainstorm → Structure → Write → Greenlight) asks for a different amount of judgment, and the model should match it:

- **Steps where quality is won or lost** (the final voice pass, the greenlight self-audit, hard research synthesis) need the most capable model your plan offers. This is where a small edge in judgment prevents a script that reads polished but robotic, or a flag that should have been caught.
- **Steps that are mostly drafting and structure** (turning an outline into a full script, building the Prepare→Brainstorm→Structure skeleton) do well on a balanced, mid-tier model. Fast enough to iterate, strong enough to hold structure.
- **Steps that are bulk or mechanical** (running a checklist across 20 scripts, reformatting, simple lookups) don't need top-tier judgment. Use the cheapest model that gets it right.

Whatever Anthropic calls the tiers when you're reading this, ask: "is this the step where quality is won, or is this bulk work?" and pick accordingly.

---

## CURRENT CLAUDE MODEL LINEUP

| Tier | Models | What it's for |
|------|--------|---------------|
| **Top-tier** | Fable 5, Opus 4.8 | Highest judgment and quality. Use the most capable model your plan offers. |
| **Balanced** | Sonnet (Sonnet 5) | Speed/quality workhorse. Good for drafting, structure, most of the writing. |
| **Cheap/fast** | Haiku (current Haiku release) | Bulk, mechanical, high-volume, low-judgment steps. |

**Use the most capable model your plan offers for the final voice pass and the greenlight self-audit.** Those two steps are where quality is won or lost, and the cost of a stronger model there is small next to the cost of shipping a script that reads AI-written or misses a flag.

---

## MODEL BY WORKFLOW STEP

The FacelessOS system runs Research → Brainstorm → Structure → Write → Greenlight (see `research-and-ideation-skill.md` and `greenlight-audit-skill.md`). Here's where each tier fits.

### Research (`research-and-ideation-skill.md`)
**Top-tier or balanced**, depending on difficulty.
- Straightforward fact-gathering, pulling a transcript, summarizing a known topic: balanced model is enough.
- Hard research synthesis: reconciling conflicting sources, verifying a claim that matters, building a research base a whole script depends on: use the top-tier model. Bad research here compounds into every downstream step.

### Brainstorm and Structure
**Balanced.**
Turning research into angles, and angles into a Prepare→Brainstorm→Structure skeleton, is mostly organizing material you already have. A balanced model holds structure well, drafts fast, and is cheap enough to iterate on multiple structure options before committing to one.

### Write (full script draft)
**Balanced**, with a top-tier pass at the end.
Draft the full script on the balanced model. It's fast, handles long-form structure, and is the right cost for a first pass you're going to revise anyway.

### Final voice pass (`voice-anchoring-skill.md`)
**Top-tier. Use the most capable model your plan offers.**
This is the step where the draft gets re-voiced into spoken register: the shape test, the four written-not-spoken tells, the register translation that keeps the jolt/proof/tension while fixing the delivery. It is judgment-heavy and it is the single biggest lever on whether a script sounds handwritten or AI-generated. Do not run this step on a cheaper model to save time. It is the wrong place to cut cost.

### Greenlight self-audit (`greenlight-audit-skill.md`)
**Top-tier. Use the most capable model your plan offers.**
The self-audit is the last checkpoint before a script ships. It has to catch what earlier passes missed: slop vocabulary, trailer voice, weak hooks, substance that doesn't trace back to real research. A cheaper model here tends to rubber-stamp its own draft instead of finding the real problems. Spend the top-tier budget on this pass every time.

### Bulk / mechanical work
**Cheap/fast model.**
Running the same checklist across a batch of scripts, reformatting, pulling simple facts, tagging or sorting content: none of this needs top-tier judgment. Use the cheapest model that does the job correctly so you're not paying top-tier prices for mechanical steps.

---

## PLAN SELECTION

| Plan | Best For |
|------|----------|
| **Entry-level plan** (e.g. Claude Pro) | Getting started, 1-2 scripts per day, scripts under 20 minutes |
| **Higher-usage plan** (e.g. Claude Max) | Batch scripting, long-form (45+ min), heavy daily usage |

**When to upgrade to a higher-usage plan:**
- Writing 3+ scripts per day
- Scripts over 30 minutes regularly
- Hitting context or usage limits frequently
- Batch scripting across multiple channels

**Note:** API access is not recommended for most users. Per-token cost adds up fast for heavy daily scriptwriting. Stick with a standard subscription plan unless you specifically need programmatic access.

---

## RESEARCH WORKFLOWS

### Option A: Claude Research Mode (Recommended)

Claude has a built-in research feature. Enable it at the start of your conversation:

1. Start a new chat in your FacelessOS project
2. Enable Research Mode
3. Ask Claude to research your topic
4. Once research is complete, Claude automatically switches to writing mode
5. Write your script with the research context already loaded

**Why this is best:** No copy-pasting between tools. Research and writing happen in the same context with FacelessOS skills active.

### Option B: Perplexity + Claude

**Step 1: Perplexity (Free)**
- Gather facts, statistics, sources
- Build your research document
- Export key findings

**Step 2: Claude with FacelessOS**
- Paste your research findings
- Write the full script
- No token waste on research

**Why this works:** Perplexity is free and purpose-built for research. You save all your Claude usage for writing.

### Option C: Claude Code Extension

For power users comfortable with VS Code or similar IDEs:

- Install the Claude Code extension in VS Code
- Runs through your Claude subscription (not API billing)
- More efficient usage than the web interface for batch workflows and long sessions

---

## SIMPLE APPROACH (No Split Workflow)

If the workflows above sound complicated:

1. **Open Claude web**
2. **Select the most capable model your plan offers**
3. **Open your FacelessOS project**
4. **Write your script**

That's it. The split workflows save cost but add complexity. Most users get excellent results with the simple approach, especially if they at least switch to the top-tier model for the final voice pass and greenlight audit.

---

## VOICEOVER PACING CUSTOMIZATION

Different TTS voices and narrators speak at different speeds. Customize your word count targets:

**Default:** FacelessOS assumes ~150 words per minute (standard narration pace).

**To customize:** Tell FacelessOS at the start of your session:
```
My voiceover rate is about [X] words per minute. Adjust all script length targets accordingly.
```

Common rates:
- Fast narration (news style): ~170 WPM
- Standard narration: ~150 WPM
- Slow, dramatic narration: ~130 WPM
- Vidrush ElevenLabs voices: varies by voice, test and measure

---

## TOKEN MANAGEMENT

### Hitting Context Limits?

1. **Start a fresh chat** for each new script (most impactful)
2. **Use Research Mode** instead of manually feeding long documents
3. **Consider a higher-usage plan** if hitting limits more than twice per day
4. **Use Perplexity** for research-heavy topics to save Claude usage

### Approximate Length by Script Length

Rough guide for how much a chat will need to hold as your script grows. Exact token counts vary by model and content, so treat this as a planning heuristic, not a hard limit.

| Script Length | Relative Context Load |
|--------------|-------------------|
| 5-10 min | Light |
| 15-30 min | Moderate |
| 45-60 min | Heavy |
| 1-2 hours | Very heavy: expect to hit context limits on longer chats; consider a fresh chat per major section |

---

## COMMON MISTAKES

### Mistake #1: Thinking you can switch models mid-chat
Each Claude web chat is locked to one model. Start a new chat to use a different model.

### Mistake #2: Using the cheap/fast model for full scripts
The cheap/fast tier is fast and inexpensive but produces noticeably lower quality scripts. Use a balanced or top-tier model for anything you plan to publish, and always use the top-tier model for the final voice pass and greenlight audit.

### Mistake #3: Using a non-Claude model instead of Claude with FacelessOS
Other assistants can get you partway there, but the combination of a capable Claude model plus the FacelessOS skills (voice anchoring, greenlight audit, research standards) is what closes the gap to a publishable script. The time saved on revisions is worth staying in Claude.

### Mistake #4: Staying on an entry-level plan when you're hitting limits
If you're constantly hitting context or usage limits, a higher-usage plan saves frustration and improves output quality.

### Mistake #5: Using API access thinking it's cheaper
API billing is per-token. For heavy scriptwriting, a standard subscription plan with generous usage is almost always cheaper than paying per token through the API.

### Mistake #6: Running the greenlight audit on the same tier as the draft
The greenlight audit exists to catch what the draft missed. Running it on the same model that wrote the draft, at the same effort level, means it's checking its own work with no fresh judgment. Bump to the top-tier model for this step even if you drafted on balanced.

---

## QUICK DECISION

**Just starting?**
→ Entry-level plan + top-tier model for final passes, balanced model for drafting

**Doing 3+ scripts/day?**
→ Higher-usage plan + balanced model for drafting, top-tier for voice pass and greenlight

**Want to save cost?**
→ Perplexity (research) + balanced model (drafting) + top-tier model (final voice pass and greenlight only)

**Scripts over 45 minutes?**
→ Higher-usage plan + balanced model for the draft, top-tier for the final pass (recommended)

---

**Bottom line:** Match the model to the judgment each step needs. Draft on a balanced model. Always run the final voice pass and the greenlight audit on the most capable model your plan offers, that's where quality is won. Use the cheap/fast tier only for bulk, mechanical work. Upgrade your plan if you're a heavy user. Enable Research Mode for research-heavy topics. The split workflow is optional.
