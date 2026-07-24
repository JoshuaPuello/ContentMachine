# Faceless Scripts OS - Quick Start Guide

> **CLAUDE INSTRUCTION:** When a user prompts "quick start", "help", "how do I use this", or asks about getting started with FacelessOS, display this ENTIRE guide in full detail. Do NOT summarize or condense. Walk through each section completely. New users need all the context below to use the system effectively.

---

## What You Just Bought

A complete scriptwriting system extracted from 4,000+ real faceless scripts across 40+ niches. Upload these files to Claude, and it writes faceless scripts like someone who's written thousands of them.

### Why FacelessOS vs. Just Asking Claude?

| Without FacelessOS | With FacelessOS |
|-------------------|-----------------|
| Generic "AI voice" writing | Patterns from 4,000+ real viral scripts |
| Consensus topic ideas | Research front-end finds the angle and the proof first |
| No structure guidance | Proven hooks, transitions, retention mechanics |
| Random formatting | Editor-ready visual cues OR Vidrush-ready prose |
| Hit-or-miss quality | Greenlight audit loops every script to a clean pass before output |

### What's New in v5

→ **Research front-end** (`research-and-ideation-skill.md`) → runs before every script. Angle mining, verify-or-cut sourcing, cold-niche research, ending in the five-field brief the master workflow reads at STEP 0.
→ **Greenlight self-audit** (`greenlight-audit-skill.md`) → the final gate. Five groups (Hook, Retention, Red-Tape, Voice + Anti-slop, Authenticity) with a verdict block, looped until a fully clean pass. Absorbs the v4 authenticity audit as Group E and replaces the v4 one-run re-audit.
→ **Humanizer** (`humanizer-skill.md`) → the H1-H17 catalog of AI-writing tells plus the two-tier ban system (machine-tier phrases never ship, judgment-tier patterns get judged in clusters).
→ **Voice anchoring** (`voice-anchoring-skill.md`) → anchor every script to a real spoken sample and shape-test every sentence against it. Kills the "reads polished, sounds robotic" failure.
→ **Machine scanner** (`trailer-voice-scan.py`, one level above the skills folder) → run it over your script before recording. Catches trailer voice and hard-banned phrases automatically.
→ **Packaging** (`packaging-skill.md`) → optional post-greenlight step. Say "package it" on a passed script and get the upload kit: 3 title options, description, tags, a pinned comment in your channel voice, and 2 thumbnail prompts. Metadata that doesn't read generic.

The workflow now runs **Research → Brainstorm → Structure → Write → Greenlight**, with Packaging as an optional final step after the pass.

### Two Output Modes

- **Traditional** - For manual editing (includes `[B-ROLL:]`, `[CLIP:]`, timestamps)
- **Vidrush AI** - For Vidrush video generation (clean TTS-ready prose, no brackets)

### What You'll Get

- **Hook** (first 30-60 seconds) with proven retention patterns
- **Structured body** with transitions every 60-90 seconds
- **Visual cues** (Traditional) or **embedded keywords** (Vidrush)
- **Word count** matched to your target video length
- **A script that passed the greenlight audit** (Groups A-E, looped to a clean pass before you see it)

### What This System Does NOT Do

- ❌ **Won't invent facts** - You provide the topic, it structures the script
- ❌ **Won't write talking head scripts** - Faceless narration only
- ❌ **Won't write scripted podcasts/interviews** - Narration-over-footage format
- ❌ **Won't create original research** - Works with publicly available information
- ❌ **Won't guarantee viral success** - Good scripts still need good topics

**Greenlight Audit:** Every script runs the five-group greenlight audit (Hook, Retention, Red-Tape, Voice + Anti-slop, Authenticity) plus a mode-compliance scan before output. If the audit finds fixes, the whole audit re-runs until a fully clean pass. The working verdict block is stripped from the final script you receive.

---

## Setup (2 Minutes)

### Step 1: Open Claude
Go to [claude.ai](https://claude.ai) (requires Claude Pro - $20/month)

### Step 2: Create a Project
Click **Projects** → **Create Project** → Name it "Faceless Scripts OS"

### Step 3: Upload the Skills
In your project, click **Add Content** → **Upload Files**

Upload these files (in this order for best results):

**Core (always upload):**
1. `faceless-scripts-os-master.md` (THE CORE - always upload this)
2. `research-and-ideation-skill.md` (Research front-end - the workflow starts here) ← NEW in v5
3. `variety-rotation-skill.md` (Prevents repetitive scripts)
4. `REAL-FACELESS-HOOK-SWIPE.md` (Hook examples)
5. `script-structures-skill.md` (Format templates)
6. `retention-mechanics-skill.md` (Retention psychology)

**Craft layer (upload together) ← NEW in v5:**
7. `greenlight-audit-skill.md` (The five-group self-audit - the final gate on every script)
8. `voice-anchoring-skill.md` (Spoken-register anchor + per-sentence shape test)
9. `humanizer-skill.md` (H1-H17 AI-tell catalog + two-tier bans)
10. `packaging-skill.md` (Optional - the upload kit: titles, description, tags, pinned comment, thumbnail prompts)

**Recommended:**
11. `model-selection-guide-skill.md` (Which AI model to use)
12. `visual-scripting-skill.md` (Production cues - Traditional mode)
13. `heros-journey-skill.md` (For documentaries)
14. `outro-psychology-skill.md` (For endings/CTAs)

**Niche-specific (upload as needed):**
15. `true-crime-skill.md`
16. `celebrity-documentary-skill.md`
17. `NICHE-SPECIFIC-HOOKS.md`
18. `title-formulas-skill.md`
19. `retention-coaching-skill.md` (For analyzing your retention data)

**Also in the package:**
→ **The slop check needs no tools:** type "slop check" on any draft and Claude runs the full anti-slop pass inside your Project (machine-ban list, shape flags, staccato hunt, mechanical sweep) and reports every flag. The greenlight audit also runs this automatically on every script.
→ `trailer-voice-scan.py` sits one level ABOVE the skills folder and is OPTIONAL. Don't upload it to your Claude Project (Projects can't run Python). It's the same check as "slop check" in deterministic script form, for the technical crowd: run it in a terminal to batch-scan files, `python3 trailer-voice-scan.py your-script.md`. If that's not you, skip it; nothing is lost.
→ `authenticity-audit-skill.md` is now a pointer stub: the v4 authenticity checks live in `greenlight-audit-skill.md` as Group E. No need to upload the stub.

**Tip:** The v5 package is 21 files in the skills folder (including this guide) plus the scanner. You don't need them all loaded at once. Start with the 6 Core files and the craft-layer files. Add more as needed.

### Step 4: Start Writing
Open a new conversation in your project and prompt Claude.

---

## Project Starter Kit (new channel setup)

Starting a new channel project from zero, or running one channel after another? This is the piece the Discord keeps asking for: a complete instruction set for spinning up a new channel project, start to finish.

### Official Project Instructions Template

Paste this into your Claude Project's Custom Instructions field, then fill in your niche and voice sample.

```
You are a faceless YouTube scriptwriter with 7,000+ scripts of experience, 4,000+ of them faceless.

When writing scripts:
- Use the FacelessOS methodology from the uploaded skill files
- Start every new video from the research brief (research-and-ideation-skill.md); if none is provided, ask for one before writing
- Default to Traditional output mode unless I specify Vidrush
- Always run the greenlight audit (greenlight-audit-skill.md) before delivering the final script, and loop until it passes
- Match the word count to my target (words, not minutes)

My channel: [niche]
My channel voice: [paste 60-90 seconds of your own voiceover transcript. No uploads yet? Paste transcripts from 2-3 channels you admire in your niche and it anchors to the register they share. It borrows how the lane sounds, never their hooks or content. See voice-anchoring-skill.md.]
```

### Intake Protocol (fill out per script)

```
Topic: 
Format: 
Length in words: 
Niche: 
Output Mode: 
Brief: [paste or "run research first"]
```

### Reference-Transcript Rules

→ Use 3-5 transcripts of ONE style. Never mix styles in the same reference set, a mixed set produces a muddy hybrid voice.
→ Only transcribe genuinely high-performing, clean scripts. A weak transcript teaches the bad along with the good.
→ State the hierarchy in your Project Instructions: "reference transcripts teach style; FacelessOS rules win on any conflict."

### Non-English Channels

If your channel isn't in English, your voice sample (anchor) needs to be in your channel's language. The skill files stay in English, and Claude writes the script in your language. Run the by-hand slop sweep with extra care on these, the machine scanner's ban list is English-only.

---

## Model Selection

Model names change; the principle doesn't. Match the model to the judgment each step needs:

| Tier | Best For |
|------|----------|
| **Top-tier** (the most capable model your plan offers) | Final voice pass, greenlight audit, hard research synthesis |
| **Balanced** (the mid-tier workhorse) | Drafting, structure, most of the writing |
| **Cheap/fast** | Bulk, mechanical, checklist runs |

**Use the most capable model your plan offers for the final voice pass and the greenlight audit.** Those two steps are where quality is won or lost.

**Important:** Each Claude chat is locked to ONE model. You cannot switch models mid-conversation. If you want to use a different model, start a new chat.

**For the current model lineup** and detailed guidance on plans, token management, research workflows, and common mistakes, see `model-selection-guide-skill.md`.

---

## How to Prompt

### Traditional Mode (Default)
For manual editing or handing off to an editor. Includes `[B-ROLL:]`, `[CLIP:]`, timestamps.

```
Write a faceless YouTube script.

Topic: [What the video is about]
Format: [Documentary / Listicle / Exposé / True Crime]
Length: [X words] (minutes only convert through your channel's words-per-minute; calibrate by pasting 2-3 past scripts with timestamps and asking for your average wpm; no uploads yet = start at 145 wpm; the 145 wpm calibration is Traditional mode only, Vidrush lengths come from the Talking Point Density table in the master file)
Niche: [Category]
Brief: [paste your research brief, or leave blank to run research first]
```

### Vidrush Mode
For Vidrush AI video generation. Clean prose only, no brackets or timestamps.

```
Write a faceless YouTube script for Vidrush.

Topic: [What the video is about]
Format: [Documentary / Listicle / Exposé]
Length: [X words] (from the Talking Point Density table in the master file, not wpm math)
Niche: [Category]
Brief: [paste your research brief, or leave blank to run research first]

Output Mode: Vidrush
```

---

### Example Prompts

**Documentary (Traditional):**
```
Write a faceless YouTube script.

Topic: The rise and fall of FTX and Sam Bankman-Fried
Format: Documentary
Length: 2,175 words (~15 min @ 145 wpm default)
Niche: Business/Crypto scandal
```

**Listicle (Vidrush):**
```
Write a faceless YouTube script for Vidrush.

Topic: 10 hidden iPhone features Apple doesn't advertise
Format: Listicle
Length: 2,500-3,500 words (10-12 min Vidrush, from the Talking Point Density table)
Niche: Tech

Output Mode: Vidrush
```

**Exposé (Traditional):**
```
Write a faceless YouTube script.

Topic: The dark truth about Dubai's luxury lifestyle
Format: Exposé
Length: 2,610 words (~18 min @ 145 wpm default)
Niche: Travel/Lifestyle
```

**True Crime (Vidrush):**
```
Write a faceless YouTube script for Vidrush.

Topic: The disappearance of Malaysia Airlines Flight 370
Format: True Crime
Length: 4,000-5,500 words (18-20 min Vidrush, from the Talking Point Density table)
Niche: Mysteries

Output Mode: Vidrush
```

---

## What Each File Does

| File | What It Does | When to Use |
|------|--------------|-------------|
| `faceless-scripts-os-master.md` | Core system - hooks, structures, style, **both output modes** | ALWAYS |
| `research-and-ideation-skill.md` | Angle mining, verify-or-cut sourcing, the STEP 0 brief | **ALWAYS** (the workflow starts here) |
| `variety-rotation-skill.md` | Anti-repetition system - 9 slots, 84 alternatives, rotation log | **ALWAYS** (prevents samey scripts) |
| `greenlight-audit-skill.md` | Five-group self-audit, Groups A-E (Group E = YouTube policy authenticity, formerly `authenticity-audit-skill.md`) | **ALWAYS** (the final gate on every script) |
| `voice-anchoring-skill.md` | Spoken-register anchor + per-sentence shape test | Before writing, and inside the audit's Group D |
| `humanizer-skill.md` | H1-H17 AI-tell catalog + two-tier bans | During QA on every script |
| `packaging-skill.md` | Post-script upload kit in your channel's voice | After a script passes greenlight, say "package it" |
| `REAL-FACELESS-HOOK-SWIPE.md` | 10 hook categories with real examples | When you want stronger hooks |
| `script-structures-skill.md` | Templates for each format (including explainers) | When you need structure help |
| `retention-mechanics-skill.md` | Dopamine Ladder, 4 Deadly Mistakes | When optimizing for retention |
| `model-selection-guide-skill.md` | Which Claude model, plan, and workflow to use | When setting up or hitting limits |
| `visual-scripting-skill.md` | [CLIP], [B-ROLL], [TEXT] notation | Traditional mode production cues |
| `heros-journey-skill.md` | 11-step narrative framework | For biographical documentaries |
| `outro-psychology-skill.md` | CTA psychology, outro templates | When endings need work |
| `retention-coaching-skill.md` | Read retention graphs, diagnose script problems | After publishing, to improve next scripts |
| `true-crime-skill.md` | True-crime structure and pacing | For true-crime cases and mysteries |
| `celebrity-documentary-skill.md` | Celebrity and biographical documentary format | For celebrity deep-dives and biographies |
| `NICHE-SPECIFIC-HOOKS.md` | Hook swipes sorted by niche | When you want a hook proven in your lane |
| `title-formulas-skill.md` | Title and thumbnail-text formulas | When packaging the video |

---

## Pro Tips

### 1. Always Include Format
Claude writes very differently for listicles vs documentaries. Always specify.

### 2. Give Context About Your Channel
```
Write a faceless YouTube script.

Topic: Why the 2008 financial crisis happened
Format: Documentary
Length: 20 minutes
Niche: Finance/History

Channel context: We use a casual, slightly irreverent tone. Think "explaining
complex topics to a smart friend at a bar." We use dark humor when appropriate.
```

### 3. Ask for Hook Variations
```
Give me 3 different hook options for this video before writing the full script.
```

### 4. Request Visual Cues (Traditional Mode)
```
Include detailed visual scripting notation throughout - [CLIP], [B-ROLL],
[TEXT ON SCREEN], etc.
```

### 5. Iterate on Sections
```
The hook is good but the "Rise" section feels flat. Rewrite that section
with more tension using the But/Therefore rule.
```

### 6. Request a Fresh Greenlight Pass
If you edited the script yourself or want a fresh check (edits reintroduce tells, so any revision earns a re-run):
```
Run the full greenlight audit on this script and loop it to a clean pass.
```

### 7. Approve Outline First
For complex scripts, approve structure before full writing:
```
Before writing the full script, show me the outline/structure for approval.
```

### 8. Generate Section by Section
For more control:
```
Write just the hook first. I'll approve before you continue.
```

---

## Power Workflows

These are advanced techniques from FacelessOS power users. Each one unlocks a capability most members don't know exists.

### Research SOP
Don't let Claude research broadly. It burns tokens and wanders. Run `research-and-ideation-skill.md` instead: angle mining, verify-or-cut sourcing, and the five-field brief (TOPIC / ANGLE / PROOF BANK / HOOK DIRECTION / STRUCTURE HINT) the master workflow reads at STEP 0. Open your 5-15 sources yourself, log each one next to the proof item it backs. YOU control the direction, Claude builds the script from the brief.

### Competitor Transcript Analysis
Feed competitor scripts into FacelessOS and ask it to analyse scriptwriting patterns, pacing, and tone. Use that analysis as instructions for your own script. Don't edit the skill files. Feed transcripts directly in the chat.

```
Here's a transcript from a top-performing video in my niche: [paste transcript]

Analyze the scriptwriting patterns. Hook structure, pacing, transitions, tone. 
Create a report I can reference when writing my own scripts.
```

### Channel Link Analysis
Share a channel link with FacelessOS and ask it to identify the best-performing or highest-view videos. Useful for competitor research and niche validation.

### Outlier Transcript Analysis
Copy transcripts from outlier videos (viral or high-performing) in your niche. Have FacelessOS analyze what makes the hook, pacing, and structure work. Apply those patterns to your own scripts. Members using this method consistently hit 70%+ AVD in the first 30 seconds.

### Chat Memory File
For long sessions or projects spanning multiple chats, ask Claude to create a memory file summarizing key decisions, channel context, voice preferences, and style notes. Paste this into your next chat to maintain continuity without re-explaining everything.

```
Create a memory file for this project. Include: my channel context, preferred 
tone, niche details, and any style decisions we made in this chat. I'll paste 
this into future chats to maintain continuity.
```

### YT Transcript Plugin
When using the YouTube Transcript API alongside FacelessOS, Claude may default to its own analysis and ignore the skill files. Fix: explicitly tell Claude to use FacelessOS methodology.

```
Use the FacelessOS methodology to analyze this transcript. Apply the retention 
mechanics, hook patterns, and structure frameworks from the skill files.
```

### Post-publish review
After a video has 48-72 hours of data, paste the retention graph screenshot and the script into the same project chat and ask where viewers dropped against the script's beats. FacelessOS uses `retention-coaching-skill.md` to map the drop-offs to specific lines or sections and tell you what to fix in the next script.

---

## Batch Workflow (Multiple Scripts Per Day)

### The Fresh Context Rule

**Start a NEW chat for each script.** Don't write multiple scripts in the same conversation.

**Why this matters:**
- Research from Script A bleeds into Script B
- You'll get cross-contamination of facts, names, and topics
- Claude's "memory" of the previous script affects the new one
- Voice and tone get muddy after 2-3 scripts

### For High-Volume Production (10+ Scripts/Day)

1. **Create a Claude Project** with your FacelessOS skill files
2. **Open a new chat** for each script (the skill files carry over, the conversation doesn't)
3. **Keep a running doc** of topics you've completed (avoid duplicates)
4. **Use the same prompt template** for every script - consistency in prompts = consistency in output

### Quick Prompt Template for Batch Production

```
Write a faceless YouTube script.

Topic: [TOPIC]
Format: [Documentary / Listicle / Exposé / True Crime / Video Essay]
Length: [X words] (see the Length note above)
Output Mode: [Traditional / Vidrush]
Brief: [paste the research brief for THIS topic]

Use the Faceless Scripts OS methodology.
```

Each script gets its own brief. Reusing a brief across topics is how facts bleed between scripts.

### Batch Quality Control

After every 5 scripts, spot-check for:
- [ ] Are hooks still varied? (Not falling into patterns)
- [ ] Is the Anti-AI Slop checklist still passing?
- [ ] Are structures appropriate for each format?
- [ ] Is voice distinct for each video?

If quality drops, take a break. Claude's outputs are only as good as your prompts - fatigue in your instructions shows in the scripts.

---

## Vidrush-Specific Tips

### 1. B-Roll Availability Test (Critical!)
Before writing, ask these 4 questions:
- Is there 20+ minutes of footage online for this topic?
- Is it copyright-free or fair use?
- Can you find footage for 50+ videos in this niche?
- Does the footage match viewer expectations?

**If ANY answer is "no"** → Topic will struggle on Vidrush.

### 2. Embed Visual Keywords
Instead of `[B-ROLL: bank]`, write "the First National Bank in downtown Chicago" - Vidrush's Footage Agent matches keywords automatically.

### 3. Use the Four Pillars
Vidrush scripts start with: Director's Brief, Style Guide, Target Audience, Key Facts. The master file includes the full template.

### 4. Match Talking Point Density
- 6-8 min video = 4-5 main points
- 10-12 min video = 7-8 main points
- 18-20 min video = 12-15 main points

Too few = AI pads with repetition. Too many = rushed content.

### 5. Number Format for Listicles
Write "Number eight." not "Number 8:" - TTS reads it more naturally.

### 6. Best Formats for Vidrush
- ✅ Listicles, Documentaries, Exposés, Explainers
- ⚠️ True Crime, Celebrity deep-dives (may need specific footage that's hard to match)

### 7. Convert Between Modes
```
Convert this script to Vidrush format.
```
```
Convert this script to Traditional format with visual cues.
```

### 8. Reference Video for Style
Include a YouTube URL in your Style of Talking section to teach Vidrush a specific narration style. **Must be human-narrated** (not AI voices).

### 9. What Vidrush CAN'T Do
- ❌ Compilations, Reactions, Tutorials, Gaming, Vlogs
- ❌ Content requiring original audio clips (speeches, interviews)
- ⚠️ Hyper-local events, pre-camera history, private events

See master file for full limitations list.

---

## Formats Covered

- **Documentaries** (biographical, event-based, historical)
- **Listicles** (top 10, rankings, "X times when...")
- **Exposés** (scandals, dark truths, "what they don't tell you")
- **True Crime** (cases, mysteries, investigations)
- **Video Essays** (analysis, arguments, hot takes)
- **Explainers** (how-to, tutorials, breakdowns)

---

## Niches This Works For

The system was built from scripts across 40+ niches including:

- True Crime & Serial Killers
- Celebrity Scandals & Drama
- Business & Money
- History & Generations
- Sports (all types)
- Hip-Hop & Rap
- Tech & Business Giants
- Mysteries & Disappearances
- Gaming & Esports
- Movies & Film
- Military & Special Operations
- Food & Restaurants
- Paranormal & Supernatural
- And 30+ more

---

## Need Help?

Post your question in the FacelessOS Discord. The community and Haris are active there.

Follow on X: [@fyreinteractive](https://twitter.com/fyreinteractive)

---

**Faceless Scripts OS** - Scripts that don't sound like AI wrote them. Traditional editing or Vidrush-ready.
