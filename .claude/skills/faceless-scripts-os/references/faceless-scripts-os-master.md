---
name: faceless-scripts-os
description: Complete faceless YouTube scriptwriting system from 4,000+ real faceless scripts across 40+ niches. Two output modes - Traditional (with visual cues for editors) and Vidrush AI (clean TTS-ready prose). Workflow runs Research → Brainstorm → Structure → Write → Greenlight: a five-field research brief in at STEP 0, proven hook patterns and structure templates in the middle, and the greenlight audit loop as the final gate before output.
---

# Faceless Scripts OS - Master System

Transform Claude into a faceless YouTube scriptwriter using patterns extracted from 4,000+ real faceless scripts.

## Core Philosophy

**Without a face, the script IS the content.**

You can't charm your way through a weak script. You can't rely on personality. The words carry everything.

---

## WHAT'S NEW IN V5

v5 wires a research front-end and a craft layer into the workflow. Six additions:

→ **Research front-end** (`research-and-ideation-skill.md`). Angle mining, verify-or-cut sourcing, cold-niche research. Produces the five-field brief that STEP 0 reads before anything else runs.
→ **Greenlight self-audit** (`greenlight-audit-skill.md`). The final gate. Five groups (Hook, Retention, Red-Tape, Voice + Anti-slop, Authenticity), a fenced verdict block, and a loop that re-runs the whole audit until a fully clean pass. Replaces the v4 one-run re-audit and absorbs the v4 authenticity audit as Group E.
→ **Humanizer** (`humanizer-skill.md`). The H1-H17 catalog of AI-writing tells, judged in clusters, plus the sweep procedure that closes QA.
→ **Spoken-register gate** (`voice-anchoring-skill.md` + `trailer-voice-scan.py`). Anchor every script to a real spoken sample, run the shape test on every sentence, hunt the four written-not-spoken tells by name. The scanner sits one level above this skills folder and machine-checks the draft before recording.
→ **Two-tier ban system.** Machine-tier phrases never get written, no adjudication. Judgment-tier patterns get judged in clusters. Defined in `humanizer-skill.md`, enforced by the scanner and the greenlight audit.
→ **Packaging** (`packaging-skill.md`). Say "package it" on a passed script and the upload kit comes back: titles, description, tags, pinned comment, thumbnail prompts, in your channel's voice, nothing invented.

The workflow now runs **Research → Brainstorm → Structure → Write → Greenlight**. Research is the front, greenlight is the end, and neither is optional. Packaging rides behind greenlight as an optional final step.

---

## OUTPUT MODE (Specify Before Writing)

**Choose your output target. If not specified, default to Traditional.**

### Mode A: Traditional Editing (Default)
Use when editing manually or handing off to a video editor.

**Output includes:**
- `[VISUAL:]`, `[B-ROLL:]`, `[CLIP:]` notation
- Timestamps for structure guidance
- Stage directions where helpful

### Mode B: Vidrush AI
Use when outputting to Vidrush for AI video generation.

**Output includes:**
- Clean TTS-ready prose ONLY (Vidrush reads everything aloud)
- Four Pillars header (see VIDRUSH MODE section below)
- Visual keywords embedded naturally in sentences

**Vidrush hard rules:**
- ❌ NEVER: `[B-ROLL: city skyline]` → TTS reads brackets aloud
- ✅ INSTEAD: "the Manhattan skyline at dusk" → Footage Agent finds visuals
- ❌ NEVER: Timestamps `(0:00-1:30)`
- ❌ NEVER: Stage directions `[PAUSE]`, `[MUSIC SWELLS]`
- ❌ NEVER: Speaker labels `NARRATOR:`
- ❌ NEVER: URLs (TTS reads "h-t-t-p-colon-slash-slash")

**Triggering Vidrush mode** (any of these work):
- "Output Mode: Vidrush"
- "for Vidrush"
- "Vidrush mode"
- "Vidrush format"
- "clean TTS prose"

---

### Mode Conversion

**Converting Traditional → Vidrush:**
```
Convert this script to Vidrush format. Remove all visual cues and embed
keywords naturally in the prose.
```

**TTS Cleaning (for any script going to Vidrush):**
```
Clean this script for Text-to-Speech. Remove all non-narration text including
speaker labels, timestamps, stage directions, notes, and URLs.
```

**Converting Vidrush → Traditional:**
```
Convert this script to Traditional format. Add [B-ROLL:], [CLIP:], and
[TEXT ON SCREEN:] cues throughout.
```

---

### Vidrush Format Recommendations

**Best formats for Vidrush:**
- ✅ Listicles (numbered items work great)
- ✅ Documentaries (narrative flow)
- ✅ Exposés (investigation style)
- ✅ Explainers (educational content)

**Challenging for Vidrush:**
- ⚠️ True Crime (may need specific crime scene footage that's hard to match)
- ⚠️ Celebrity deep-dives (needs specific person footage)
- ⚠️ Breaking news (footage may not exist yet)

**Before writing for Vidrush, verify:**
1. Is there enough stock footage for this topic?
2. Are there specific people/places that MUST be shown?
3. If footage is limited, can you write around it with more conceptual visuals?

**If footage is limited:** Focus on conceptual keywords (emotions, actions, objects) rather than specific people/locations. Write "a woman checking her phone in a coffee shop" instead of "Sarah checking her phone at Starbucks."

---

## CRITICAL FORMATTING RULE

**NEVER use em dashes in any script output.**

Use these alternatives instead:
- Periods for breaks between thoughts
- Commas for lighter pauses
- Colons for explanations (sparingly, max 2-3 per script)
- "But" or "However" for contrasts
- Ellipses (...) sparingly for dramatic pauses

This applies to ALL script content: hooks, body copy, transitions, CTAs, and visual cues.

---

## ANTI-AI SLOP CHECKLIST

**Your audience can smell AI writing from a mile away. Avoid these 8 patterns:**

### Pattern 1: Short Period Sentences
❌ **AI Pattern:** "No jargon. No fluff. No excuses." / "Simple. Powerful. Effective."
✅ **Human Alternative:** Use commas like a normal person. Vary your rhythm. Write how you actually talk.

### Pattern 2: Colon Abuse
❌ **AI Crutches:** "This is why it matters:" / "Here's how we implemented it:" / "The bottom line:" / "Here's the thing:"
✅ **Human Alternative:** Just say the thing. Don't set up every point like a lesson plan. Max 2-3 colons per entire script.

**Important:** The problem isn't the colon itself. It's the AI setup phrase before it. "Here's the thing:" and "The bottom line:" are AI crutches. "In 2019:" and "His response:" are fine. Check for the PHRASE, not the punctuation.

### Pattern 3: The "Most" Angle
❌ **AI Slop:** "Most founders think..." / "Most people believe..." / "Most CEOs don't realize..."
✅ **Human Alternative:** Use a hot take, tell a story, or speak from direct experience. Never start with "Most xyz."

### Pattern 4: "It's Not X, It's Y"
❌ **Overused:** "It's not about AI, it's about humans" / "The threat is not AI itself, it's..."
✅ **Human Alternative:** Make a direct statement. One contrast max per script. Show, don't explain.

### Pattern 5: Suspiciously Specific Numbers
❌ **AI Fingerprints:** "47% of founders..." / "73% more effective..." / "In just 37 days..."
✅ **Human Alternative:** Use real numbers from real sources. "$18K mistake" not "significant loss." "March 2024" not "recently."

### Pattern 6: Empty Emphasis Words
❌ **Kill These:** "Powerful" / "Game-changing" / "Transformational" / "Revolutionary" / "Unlock your potential"
✅ **Show Instead:** Replace with specific outcomes. If you can't replace it with a specific result, delete it.

### Pattern 7: The Guru Voice
❌ **AI Guru Voice:** "Here's the truth no one talks about..." / "What most people fail to realize..." / "Let that sink in."
✅ **Human Voice:** "I didn't get this until I screwed up twice" / "Took me 2 years to figure this out" / Speak from experience, not authority.

*(Naming note: this is the guru-authority tell, speaking from a pedestal. The separate "Wise Narrator" trailer-voice tell, prophetic narration shaped for the page, lives in `voice-anchoring-skill.md` and the scanner. Different tell, different fix.)*

### Pattern 8: Robotic Data Statements
❌ **Robotic:** "1,000 orders from desktop. 40+ female demo. 3:1 ratio outperformance."
✅ **Conversational:** "My friend's brand crushed it on desktop, 3:1 over mobile. Turns out women in their 40s just prefer shopping on bigger screens."

### The 60-Second Pre-Publish Check

Before finalizing ANY script:
- [ ] Check for AI setup phrases before colons ("Here's the thing:", "The bottom line:", "This is why it matters:"). The colon isn't the problem. The crutch phrase is.
- [ ] Any "No X. No Y. No Z." patterns? Rewrite with commas.
- [ ] Does anything start with "Most [people/founders]"? Delete it.
- [ ] Count "It's not X, it's Y" structures. More than one? Cut them.
- [ ] Any suspicious numbers (47, 73%, 37)? Replace with real data or remove.
- [ ] Kill "powerful," "game-changing," "transformational."
- [ ] Read it out loud. Would you say this at a coffee shop?
- [ ] Is there anything that would make a commenter disagree? (Good. AI avoids friction, humans don't.)

### Pacing & Emotional Arc Check

**Your script needs rhythm variation and emotional movement, not just facts.**

- [ ] **Sentence length varies:** Mix punchy (5-10 words) with flowing (20-30 words). Three short sentences in a row = AI pattern.
- [ ] **Energy ebbs and flows:** After intense moments, add a beat: "And that was just the beginning."
- [ ] **Emotional arc exists:** Identify the emotional journey (curiosity → shock → understanding). Label each section's intended emotion.
- [ ] **Stakes escalate:** Each section should feel higher stakes than the last.
- [ ] **Breather moments:** After big reveals, give viewers 1-2 sentences to process before moving on.

### Fiction / Creative Mode

When the user explicitly enables Fiction Mode, disable fact-verification. Allow narrative invention, fictional characters, and creative scenarios. Still apply all scriptwriting mechanics (hooks, retention, pacing, structure, visual keywords). Just don't block creative content with fact-checking.

**Activation:** User must explicitly say "Enable Fiction Mode" or "This is a fiction script." Do NOT auto-activate based on casual use of words like "what if" in otherwise factual prompts.

### Claude Research Mode

The research method for this system is `research-and-ideation-skill.md`: angle mining, verify-or-cut sourcing, and the five-field brief that STEP 0 reads. Run it before writing. If Claude's built-in research feature is available, use it inside that process to open and verify sources faster. It supplements the skill, it does not replace it. Research produces the brief, FacelessOS builds the script from it.

---

## STEP 0: Research (The Brief Comes First)

The workflow starts from a research brief, not a blank topic. `research-and-ideation-skill.md` produces it: angle mining, verify-or-cut sourcing, and cold-niche research end in a brief with five exact fields. The field names are the interface between that file and this workflow. Do not rename them.

```
TOPIC: [the subject, in words a viewer would actually search]
ANGLE: [one sentence: the winning frame + the non-obvious take]
PROOF BANK:
→ [verified item + the source that was opened]
→ [5-8 items total, every one carrying its source]
HOOK DIRECTION: [which proof item leads + the tension it plants]
STRUCTURE HINT: [the format the material wants + one clause on why]
```

**How the brief maps into the steps below:**

→ **TOPIC + STRUCTURE HINT feed STEP 1 (Identify Format).** STRUCTURE HINT names one of the templated formats (documentary, listicle, exposé, true crime) directly, or names a borrowed spine for the formats without their own template here, as in "explainer with a documentary spine." Take the hint unless the material clearly disagrees.
→ **ANGLE + HOOK DIRECTION feed STEP 2 (Hook Construction).** The hook patterns expect specific names and numbers. HOOK DIRECTION hands over the strongest proof item and the tension it plants, so hook construction starts from that line, not from new research.
→ **PROOF BANK feeds the body writing** throughout. Every stat in the script traces to a PROOF BANK item with its source, which is why the anti-slop scan's suspicious-numbers hunt and the greenlight audit's numbers ledger (D5) pass instead of fail.

**If no brief was provided:** ask the user to run `research-and-ideation-skill.md` first, or to hand in the five fields directly. Do not invent a brief. Writing without one is how consensus topics, unsourced numbers, and skipped angles get into scripts. A marked placeholder in the PROOF BANK (like `[stat + where to verify it]`) is acceptable. An unverified number is not.

**Length is specified in WORDS, not minutes.** Minutes are a moving target; words are what actually get written. Minutes only convert through the channel's own words-per-minute rate:

→ Calibrate once per channel: paste 2-3 of your past scripts with their final video timestamps and ask for your average wpm.
→ No past uploads yet: use 145 wpm as the starting default and calibrate after your first video.
→ The formula: target words = minutes × your wpm.

If the request arrives in minutes, convert it to a word target before writing, and hold the script to that word target. (Vidrush scripts skip the wpm formula; their word targets come from the Talking Point Density table in the VIDRUSH MODE section.)

---

## STEP 1: Identify Format

Before writing, identify which format you're writing:

| Format | Best For | Hook Style |
|--------|----------|------------|
| Documentary | Person/event deep dive | In Media Res |
| Listicle | Rankings, "X times when..." | Teaser + extreme examples |
| Exposé | Scandals, dark truths | "What if you found out..." |
| True Crime | Cases, mysteries | Legendary outsmarting |
| Video Essay | Analysis, arguments | Thesis statement |
| Explainer | How-to, tutorials | Result proof first |

**The table is not the whole library.** `script-structures-skill.md` ships SEVEN full structure templates. The four formats templated in this master (Documentary, Listicle, Exposé, True Crime) stay primary; the full template bodies for all seven live in that file. All seven, each with its best-for:

→ **Listicle** (Structure 1): "X things you didn't know," Top 10, rankings, collections
→ **Documentary** (Structure 2): stories, histories, biographies, case studies, investigations
→ **Video Essay** (Structure 3): arguments, analysis, opinion pieces, contrarian takes, frameworks
→ **Explainer** (Structure 4): how-to, tutorials, processes, frameworks, systems
→ **Comparison** (Structure 5): versus videos, reviews, decision guides, rankings
→ **Framework Reveal** (Structure 6): sharing your unique methodology, intellectual property, systems
→ **Conceptual Explainer** (Structure 7): "how X works," "why X happens," educational breakdowns, concept explanations, science/tech deep dives

If the material fits Comparison, Framework Reveal, or Conceptual Explainer better than anything in the table, pull that template from `script-structures-skill.md` and run the same workflow on it.

---

## STEP 2: Hook Construction

### CRITICAL: Conversational Flow

**Hooks must sound like someone telling a story, not a copywriter writing ad copy.**

Avoid:
- Choppy sentence fragments ("10,000 feet. Freezing rain. Stakes.")
- Syncopated "punchy" rhythms that feel artificial
- Over-stylized language that sounds written, not spoken

Instead:
- Write like you're explaining the story to a friend
- Let sentences flow naturally with proper connectors
- Build stakes through narrative, not isolated facts
- Read it out loud. If it sounds weird, rewrite it.

---

### Documentary Hook (In Media Res)

**Pattern:** Rapid controversy list + Fame context + "However" turn

**Real Example:**
```
Cheating allegations, inappropriate content, and using minors to promote
her content. McKinley Richardson has made quite a career out of all of
these things. She started dating YouTuber and Kick streamer Jack Doherty
not so long ago, catapulting her to celebrity status. Today, she has
millions of followers on her socials. However, with fame comes
controversy, and Richardson is surrounded by it right now.
```

**Template:**
```
[Rapid-fire controversy/achievement list - 3-4 items].
[SUBJECT NAME] has [made a career/become famous] from all of these things.
[Brief context of how they got here].
Today, [current status - followers, fame, position].
However, [tension point that opens the story].
```

### Listicle Hook

**Pattern:** Most extreme example first + Promise of more

**Real Example:**
```
From pulling a gun on the interviewer, to squaring up, rappers nowadays
are willing to do anything they can to check on people who are trying to
ask them too many personal questions. These are 10 rappers who
disrespected interviewers.
```

**Template:**
```
From [MOST EXTREME EXAMPLE], to [SECOND EXTREME EXAMPLE],
[SUBJECT GROUP] are willing to [what they do].
These are [NUMBER] [SUBJECT] who [DID THE THING].
```

### Exposé Hook

**Pattern:** Build trust through credibility → Flip it → Rapid-fire collapse

**CRITICAL: Emotional Investment Before Betrayal**

The key to a powerful exposé hook is making viewers CARE before you reveal the betrayal. Don't just list facts about someone's success. Make viewers feel what it was like to believe in them first.

**Real Example (FTX):**
```
Tom Brady told you to trust them. So did Steph Curry, Larry David, and
Shaq. FTX spent hundreds of millions convincing the world they were the
future of finance.

And for a while, everyone believed it. The company was worth $32 billion.
Sam Bankman-Fried was on the cover of Forbes.

Then one tweet changed everything. Within 72 hours, FTX was bankrupt,
customer funds had vanished, and Sam was in handcuffs.
```

**Why it works:**
- Celebrity names build instant credibility, then betray it
- "Everyone believed it" makes viewer feel included in the deception
- Final line lands three punches (bankrupt, vanished, handcuffs)
- Conversational flow, not choppy fragments

**Advanced Example (Viral Sensation Exposé):**
```
For three glorious weeks, she was everywhere. The interview clip got 50
million views. She was on every podcast. Brands were begging to work with
her. Everyone wanted a piece of what seemed like overnight fame.

But here's what those same people don't want you to know. Behind the viral
moment was a carefully orchestrated strategy. And the person benefiting
most? It wasn't her.
```

**Why this works better than listing controversies:**
- Builds emotional investment first ("glorious weeks," "everyone wanted")
- Creates complicity ("what those same people don't want you to know")
- The betrayal lands harder because we cared first

**Template:**
```
[Trusted voices] told you to trust [SUBJECT]. [More names].
[SUBJECT] spent [effort] convincing the world [promise].

And for a while, everyone believed it. [Peak status].

Then [trigger event]. Within [timeframe], [rapid collapse sequence].
```

**Emotional Investment Template (Alternative):**
```
For [timeframe], [SUBJECT] was [positive experience]. [Evidence of success].
[Everyone's reaction - positive].

But here's what [those same people/nobody] [wants you to know/realized].
[The twist that reframes everything].
```

### True Crime Hook

**Pattern:** Tell the story conversationally + Stack the mystery + End on what we don't know

**Real Example (DB Cooper):**
```
In 1971, a man walked onto a plane, handed a flight attendant a note, and
told her there was a bomb in his briefcase.

Four hours later, he jumped out the back with $200,000 in cash... into a
freezing thunderstorm... and was never seen again.

The FBI spent 45 years hunting him. They interviewed thousands of suspects,
tested DNA, chased every lead. And to this day, nobody knows who he was,
whether he survived, or where the money went.
```

**Why it works:**
- Flows like someone telling you a story at a bar
- No choppy fragments or "copywriter voice"
- Stakes build naturally through the narrative
- Ends on triple mystery (who, survival, money)

### Biographical Documentary Hook

**Pattern:** Peak dominance → Fall from grace → "However" turn to present day

**Real Example (Mike Tyson):**
```
At 20 years old, Mike Tyson became the youngest heavyweight champion in
history. His opponents weren't just losing. They were being carried out
on stretchers.

By the time he was 25, he'd made $300 million and scared an entire
generation of fighters into retirement.

But then came the rape conviction, the bankruptcy, and the night he bit
off Evander Holyfield's ear on pay-per-view. Everyone wrote him off.

So why, at 58 years old, did 60 million people just pay to watch him
fight again?
```

**Why it works:**
- Reads like a documentary narrator, not a copywriter
- "However" turn built naturally into the narrative
- Ends on a question that pulls viewers in
- Specific numbers (20 years old, $300M, 60 million) add weight

### Business/How-To Hook

**Pattern:** Specific result + Credibility + Promise

**Real Example:**
```
My eCommerce brand made a record 2.5 million dollars in revenue in the
last 30 days. And today, I'm gonna share the ten eCom apps that played a
crucial role helping me make that happen. From SEO and email marketing,
to handling store operations and returns, here's everything you need to
know.

By the way, I'm Dario Markovic, the founder of Eric Javitz, a designer
women's hat brand that has seen tremendous success, making over 50
million dollars in the last three years alone.
```

---

## STEP 3: Structure Templates

Four formats carry a full template here: Documentary, Listicle, Exposé, True Crime. Video Essay and Explainer briefs ride a named spine borrowed from these four. The research brief's STRUCTURE HINT names it, as in "explainer with a documentary spine." Full Video Essay and Explainer templates live in `script-structures-skill.md`.

### Documentary Structure (12-20 min)

```
HOOK (0:00-1:00) [75-100 words]
[In Media Res - rapid-fire controversy/fame + "However" turn]

EARLY LIFE/ORIGIN (1:00-4:00)
[Born where, childhood context]
[Key formative events]
[What shaped them]

RISE (4:00-8:00)
[How they got started]
[Early success/failures]
[Key turning points]
[Each section connected by BUT/THEREFORE]

PEAK/CONTROVERSY (8:00-14:00)
[Height of fame/success]
[The incident/controversy]
[Fallout and reactions]
[Multiple sub-events if needed]

AFTERMATH/CURRENT (14:00-18:00)
[What happened after]
[Where they are now]
[What we can learn]

CTA (Final 30-60 seconds)
```

### Listicle Structure (10-15 min)

```
HOOK (0:00-0:30) [40-60 words]
[Most extreme examples + format promise]

ITEM [NUMBER] (Each: 60-90 seconds)

[NUMBER on screen]
[Who/what this is about]
[Setup: The situation]
[The incident/event - specific details]
[Outcome/aftermath]
[Clip/source references]
[Transition to next: "But this wasn't the only time..." or "However, this next one..."]

[REPEAT for each item]

OUTRO (Final 60 seconds)
[Quick recap of wildest moments]
[CTA]
```

**Point Ordering for Listicles:**
- Start with a STRONG example (not the best)
- Put BEST example in the MIDDLE (retention peak)
- End with THIRD-BEST (solid finish)

### Exposé Structure (15-20 min)

```
HOOK (0:00-1:00)
[Build their public image + "What if you found out..."]

THE PUBLIC IMAGE (1:00-3:00)
[What everyone believes]
[Their success, fame, achievements]
[Why people trust/admire them]

THE FIRST CRACKS (3:00-6:00)
[Initial allegations or questions]
[Who brought them up]
[Initial reactions]

THE EVIDENCE (6:00-12:00)
[Specific claims with sources]
[Screenshots, quotes, proof]
[Each piece of evidence as its own mini-section]
[Build from smaller to bigger revelations]

THE RESPONSE (12:00-15:00)
[How subject responded]
[What defenders say]
[What critics say]

THE BIGGER PICTURE (15:00-18:00)
[What this means]
[Similar cases or patterns]
[Where things stand now]

CTA
```

### True Crime Structure (15-25 min)

```
COLD OPEN (0:00-1:00)
[The most dramatic moment - arrest, discovery, escape]

SETUP (1:00-4:00)
[Who is the criminal/victim]
[Normal life before]
[What changed]

THE CRIME (4:00-10:00)
[How it happened - chronological]
[Specific details]
[Evidence and clues]

THE INVESTIGATION (10:00-16:00)
[What police found]
[Obstacles and dead ends]
[Key breakthroughs - OR - why they failed]

RESOLUTION (16:00-20:00)
[Capture and trial - OR - how they got away]
[Aftermath]
[Where they are now]

CTA
```

---

## STEP 4: Transitions & Rehooks

### Out of the Hook (the first transition)

The first sentence after the hook must PAY or ESCALATE, never orient. Deliver the first promised item, land a payoff beat, or push the tension further. Openers like "To understand why...", "First, let's go back...", "Before we get into that...", and "To see how we got here..." pay the hook's tension with homework, and viewers leave. The flashback bridge is legal only AFTER a payoff beat has landed. Drip context right before the beat that needs it, never front-loaded. Watch this hardest on trending and news topics, where there is always a backstory to reach for.

### Between Sections

**Documentary transitions:**
- "But this was just the beginning."
- "However, things were about to get much worse."
- "What happened next changed everything."
- "And that's when everything fell apart."

**Listicle transitions:**
- "But this wasn't the only time..."
- "However, this next one takes it even further."
- "If you thought that was crazy, wait until you see..."
- "But [SUBJECT] wasn't done there."

**Exposé transitions:**
- "But the allegations didn't stop there."
- "And that's when more victims came forward."
- "However, the evidence runs even deeper."

### Maintaining Tension

Every 60-90 seconds, drop a line that opens a new loop:

- "But we'll get to that in a second."
- "What happened next shocked everyone."
- "However, this was only the tip of the iceberg."
- "And this is where things get really interesting."

### Ending the Video

CTAs live mid-content, woven in at a natural rise around 30% and/or 70% of the script, never parked after the final payoff. (Vidrush mode keeps its own tested 55-65% mid-roll spec; see VIDRUSH MODE.) Kill outro scent: no "so that wraps up," no summary tone shift, no wind-down the viewer can smell before the last payoff lands. Deliver the final payoff, hand off to the next video in a sentence, stop. Full rule: `outro-psychology-skill.md`, The Ending Architecture.

---

## STEP 5: Visual Scripting

For faceless content, visuals ARE the content. **Method depends on your output mode.**

---

### MODE A: Traditional Editing Notation

Use explicit cues that editors can follow:

```
[CLIP: Source (Timestamp)]
Example: [CLIP: Joe Rogan Podcast (14:32-14:45)]

[B-ROLL: Description]
Example: [B-ROLL: Dubai skyline at night]

[IMAGE: Description]
Example: [IMAGE: Screenshot of tweet from @user]

[TEXT ON SCREEN: "Exact text"]
Example: [TEXT ON SCREEN: "3 months later"]

[SPLIT SCREEN: Left | Right]
Example: [SPLIT SCREEN: Before photo | After photo]
```

**Pacing:** Visual change every 1.5-3 seconds. Never hold same visual 5+ seconds.

---

### MODE B: Vidrush Visual Keywords

**No brackets. Embed searchable keywords naturally in prose.**

Vidrush's Footage Agent scans your text and matches stock footage to keywords.

| Instead of This | Write This |
|-----------------|------------|
| `[B-ROLL: bank exterior]` | "the First National Bank in downtown Chicago" |
| `[B-ROLL: courtroom]` | "inside the federal courthouse where the trial took place" |
| `[B-ROLL: tech office]` | "the open-plan office in Silicon Valley" |
| `[IMAGE: person]` | "Sam Bankman-Fried in his signature cargo shorts" |
| `[B-ROLL: money]` | "stacks of hundred dollar bills on the table" |
| `[B-ROLL: city]` | "the Las Vegas Strip at midnight" |

**Keyword categories that work:**
- **Locations:** "downtown Miami," "Wall Street," "the Oval Office"
- **People:** Full names, descriptions, roles
- **Objects:** "the diagnostic screen," "a stack of documents," "the getaway car"
- **Time periods:** "in 1971," "during the 2008 crash," "last Tuesday"
- **Events:** "the FTX collapse," "the Super Bowl halftime show"

**The more specific, the better the footage match.**

**AVOID UNSEARCHABLE TRANSITIONS:**
Some common transitions contain NO visual keywords, causing Vidrush to repeat footage:

❌ "Here's the thing..." → ✅ "The reality inside the courtroom was different..."
❌ "But it gets worse..." → ✅ "The investigation took a darker turn..."
❌ "And that's when..." → ✅ "That's when the FBI's surveillance footage captured..."
❌ "So what happened?" → ✅ "What happened next in the boardroom shocked everyone..."

**Rule:** Every sentence should contain at least one searchable keyword (person, place, object, or event).

---

## STEP 6: Writing Style for Faceless

### Voice Guidelines:

**Conversational, not formal:**
- "Look" or "The reality is" not "It is important to note"
- "Basically" not "Fundamentally"
- "crazy" not "remarkable"

**Direct address:**
- Use "you" to pull viewer in
- "Imagine this:" to set scenes
- "Think about it:" for emphasis

**Rhythm variation:**
Short sentences punch.
But then you need longer sentences that flow and give the viewer a moment to breathe and process what you just told them.
Then punch again.

### Faceless Personality Techniques:

Since there's no face, personality comes from:

1. **Commentary/Reaction lines:**
```
"Absolute shocker, right?"
"Who would've guessed?"
"Yeah, you read that right."
"Wait until you hear the rest."
```

2. **Rhetorical questions:**
```
"But here's the question - how did he get away with it?"
"So what happened next?"
"Sound crazy? It gets worse."
```

3. **Dark humor (when appropriate):**
```
"Founded by George Went Hensly who died of old age in 1955...
just kidding. He died to a rattlesnake bite."
```

---

## STEP 7: Word Count Targets

**Write to the Word Count column, not the minutes.** The minute ranges below assume an average delivery pace. Your channel's real pace comes from the one-time wpm calibration in STEP 0 (target words = minutes × your wpm; 145 wpm default until calibrated); Vidrush scripts take their word targets from the Talking Point Density table instead.

**Traditional Mode** (visual cues take up screen time, so fewer spoken words needed):

| Video Length | Word Count | Hook | Body | Outro |
|--------------|------------|------|------|-------|
| 8-10 min | 1,200-1,500 | 75 | 1,000 | 100 |
| 10-12 min | 1,500-1,800 | 100 | 1,300 | 100 |
| 12-15 min | 1,800-2,200 | 100 | 1,700 | 150 |
| 15-20 min | 2,200-3,000 | 100 | 2,500 | 150 |
| 20-25 min | 3,000-3,800 | 120 | 3,300 | 200 |

**Vidrush Mode** (all words are spoken, needs more content - see Vidrush section below for density table)

---

## VIDRUSH MODE: Additional Requirements

**Only applies when Output Mode = Vidrush AI**

### The Four Pillars Header

Every Vidrush script starts with this structure:

```
🎥 What the Video Is About
[2-3 sentences: core thesis, central conflict, what viewers will learn]

🗣️ Style of Talking
[Tone description: conversational expert, investigative documentary, etc.]
[Emotional arc: building tension, mounting evidence, satisfying reveals]

🎯 Who This Video Is For
[Audience description + 2-3 example YouTube titles they'd click]

📌 Key Facts Covered
1. [Main point with visual keywords]
   - Supporting detail
   - Another detail
2. [Next main point]
   - Details...
[Continue for all sections]
```

### Talking Point Density

Match content density to video length:

| Video Length | Main Points | Words |
|--------------|-------------|-------|
| 6-8 min | 4-5 | 1,500-2,000 |
| 10-12 min | 7-8 | 2,500-3,500 |
| 18-20 min | 12-15 | 4,000-5,500 |
| 30-40 min | 20-30 | 7,000-10,000 |

**Golden ratio:** ~0.5 talking points per minute. This ratio prevents both padding and rushing.

**Too few points:** AI pads with repetition
**Too many points:** Content feels rushed

### Listicle Number Format (Vidrush)

Write numbers as words for natural TTS:

✅ "Number eight. The diagnostic fee shakedown."
❌ "Number 8: The diagnostic fee shakedown"
❌ "#8 - The diagnostic fee"

### Numbered-Chapter Markers (Vidrush)

Vidrush's numbered-chapter title animation has changed behavior over time, and [Number X] style markers may no longer trigger it. Do not rely on a marker to announce the chapter. State the number IN the narration itself so the chapter lands in audio regardless:

✅ "Number seven. The warranty clause nobody reads."
❌ A [Number 7] marker with narration that never says "number seven"

Verify against your first render whether Vidrush's current syntax needs anything extra on top of the spoken number. Check their current docs before a big batch. This moves.

### Introduce Each Person ONCE (Vidrush)

Vidrush fires its character-introduction animation every time a name appears in an introductory frame (any "a [role] named [Full Name]"-style framing, or a full-name first-mention repeated later in the script), and it frequently mangles the render. Introduce each person by full name ONCE, at first mention. Every mention after that uses a pronoun, the surname alone, or a role descriptor ("the biologist," "she").

✅ First mention: "Marie Curie discovered radium in 1898." Later mentions: "Curie refused to patent it." / "the physicist"
❌ "A scientist named Marie Curie..." then later "a scientist named Marie Curie" again = two intro animations, two chances at a mangled render

### Mid-Roll CTA (55-65% through)

Place subscribe CTA after delivering most value:

```
If you're finding this helpful, hit subscribe. I cover [topic area] every week.

Now let's talk about [next section].
```

### Reference Video Technique (Advanced)

To teach Vidrush a specific narration style, include a YouTube URL of a video with narration you want to emulate:

```
🎥 What the Video Is About
[Your description]

🗣️ Style of Talking
Match the narration style of this video: [YouTube URL]
[Additional style notes if needed]

🎯 Who This Video Is For
[Your audience]

📌 Key Facts Covered
[Your outline]
```

Vidrush analyzes the reference video's pacing, tone, and delivery, then applies similar patterns to your script. Works best with human-narrated videos (not AI voices).

### Vidrush Limitations (What It CAN'T Do)

**Technical impossibilities:**
- ❌ Compilations ("Funniest TikTok Fails") - cannot aggregate clips with original audio
- ❌ Reaction/Commentary - no picture-in-picture capability
- ❌ Software tutorials - no screen recording
- ❌ Vlog-style content - system creates narration-over-B-roll only
- ❌ Gaming content - cannot capture gameplay footage
- ❌ Custom 3D animation or complex motion graphics
- ❌ Green screen compositing
- ❌ Diagrams or labeled infographics from scratch

**Content that struggles:**
- ⚠️ Hyper-local events without documentation (the small-town murder with three photos)
- ⚠️ Pre-camera historical events (medieval battles = same five paintings on repeat)
- ⚠️ Private or unfilmed events
- ⚠️ Niche fiction without mainstream coverage
- ⚠️ Topics requiring original audio clips (Vidrush cannot use actual speeches)

### B-Roll Availability Test (Ask Before EVERY Video)

1. Is there **20+ minutes** of footage available online for this topic?
2. Is the footage **copyright-free or fair use**?
3. Can you find fresh footage for **50+ videos** in this niche?
4. Does the footage **match viewer expectations**?

**If ANY answer is "no"** → The topic will struggle on Vidrush.

### Listicle Item Counts (Vidrush)

| Video Length | Item Count |
|--------------|------------|
| 6-8 min | 3-8 items |
| 10-12 min | 5-10 items |
| 18-20 min | 7-20 items |
| 30-40 min | 15-40 items |

### Hierarchical Structure Requirement

Vidrush requires strict hierarchical formatting in Key Facts:

```
1. First Main Point
   - Supporting detail with visual keywords
   - Another supporting detail
   - Sub-detail if needed

2. Second Main Point
   - Supporting detail
   - Another detail
```

**"Fake Depth" Warning:** Multiple bullets that rephrase the same idea trigger internal validation warnings. Each bullet must add NEW information.

### Voice Selection Tips

- ✅ Use standard, conversational voices
- ❌ Avoid "upbeat" or "special" voices (glitch more during long generations)
- ❌ Avoid known unstable voices like "Broadcast News Brian"
- 💡 Slightly imperfect "bedroom recorder" voices often build more trust than polished corporate announcers

### VidRush Word Count Rule

When calculating word count for VidRush custom script mode, count ONLY the TTS-ready prose. Exclude the Four Pillars header section (Director's Brief, Style Guide, Target Audience, Key Facts outline). A "2,000 word script" means 2,000 words of narration, not 2,000 words total including the header.

### Custom VO vs Script-Only Workflow

Two VidRush workflows exist:

1. **Custom VO (Higher quality):** Write script in FacelessOS → record your own voiceover → upload both script and audio to VidRush. More control over delivery. Safer for monetization since the voice is uniquely yours.

2. **Script-only (Faster):** Write script in FacelessOS → paste directly into VidRush for AI narration. Same credit cost as custom VO. Faster production but uses shared AI voices.

Both work. Custom VO is recommended if monetization safety is a priority.

### VidRush Visual Models

VidRush offers two visual generation options:

- **Pro Model:** Stock video B-roll with full motion. Best for topics with abundant footage.
- **Mini Model:** Real images with Ken Burns effects. Cheaper credits but static visuals. Use when stock video is limited for your topic.

---

## STEP 8: Quality Checklist

Before finalizing:

### Hook:
- [ ] Under 100 words
- [ ] "However" or "But" turn present
- [ ] Specific names/numbers (not vague)
- [ ] Opens a clear curiosity gap

### Structure:
- [ ] Transition/rehook every 60-90 seconds
- [ ] Each section connected by BUT/THEREFORE (not AND THEN)
- [ ] Strongest content in middle (not end)
- [ ] Clear resolution or current status

### Style:
- [ ] Conversational tone throughout
- [ ] Commentary lines for personality
- [ ] Varied sentence rhythm
- [ ] Read aloud sounds natural
- [ ] **NO em dashes used anywhere**

### Anti-AI Slop Check:
- [ ] No "No X. No Y. No Z." sentence fragments
- [ ] No "Most people/founders think..." openings
- [ ] Max ONE "It's not X, it's Y" contrast per script
- [ ] Max 2-3 colons in entire script
- [ ] No suspicious percentages (47%, 73%, etc.)
- [ ] Zero empty words: powerful, game-changing, transformational
- [ ] No "Let that sink in" or "Here's what no one tells you"
- [ ] Would you say this at a coffee shop? If no, rewrite.

### Production (Traditional Mode):
- [ ] Visual cues every 3-5 lines
- [ ] Clip sources noted with timestamps
- [ ] Text on screen for key facts/names

### Production (Vidrush Mode):
- [ ] Zero brackets `[VISUAL:]`, `[B-ROLL:]`, `[CLIP:]`
- [ ] Zero timestamps
- [ ] Zero stage directions or speaker labels
- [ ] Four Pillars header present
- [ ] Visual keywords embedded naturally in prose
- [ ] Numbers written as words ("Number eight" not "Number 8")
- [ ] Read aloud test: Does every word sound natural spoken?

---

## STEP 9: Greenlight Audit (MANDATORY)

**After generating any script, Claude MUST run the full greenlight audit from `greenlight-audit-skill.md` before the script is called final. Run it from the open file, never from memory. This is the single final gate. The v4 one-run re-audit is retired: a run that applies fixes and then ships is self-certification, and self-certification is how tells survive.**

### The Audit

1. **Generate** the complete script draft
2. **STOP.** Do not present it yet
3. **Run all five groups, A through E, in order:** Hook, Retention, Red-Tape, Voice + Anti-slop, Authenticity. No partial passes. A skipped group is a failed group
4. **Fold in the mode scan.** While Group D runs, verify mode compliance and enter every miss as a numbered fix in the verdict block:
   → *Traditional:* `[VISUAL:]` or `[B-ROLL:]` cues every 3-5 lines, timestamps present in structure
   → *Vidrush:* zero brackets, zero timestamps, zero stage directions, Four Pillars header present, listicle numbers written as words ("Number eight")
   → *Both:* total word count within ±20% of the target range for the video length, zero em dashes anywhere in spoken copy
5. **Append the fenced verdict block** defined in `greenlight-audit-skill.md` to the script: `VERDICT: PASS | FIX-THEN-PASS | HOLD`, one line per group with its mandatory artifacts, fixes numbered consecutively across all groups

### The Convergence Rule

→ **FIX-THEN-PASS:** apply the numbered fixes, then re-run the ENTIRE audit, all five groups, on the fixed script. Loop until a run comes back with zero fixes. A run that applied fixes cannot award its own pass; the pass comes from the next full run. "Fixed the flagged lines" is not a pass, because fixes create new problems often enough that skipping the re-run defeats the loop.
→ **HOLD:** a structural problem that editing cannot patch (bait-and-switch hook, an invented fact the video leans on, a reference clone, no spine). Go back to the outline or back to research, re-enter the workflow at the step that failed, and the new draft takes the full audit from the top.
→ **PASS:** every group clean on a single fresh run. Strip the verdict block and any inline audit notes before delivering the final script. The viewer-facing output carries no audit text, no flags, no brackets.

If a finding cannot be fixed by editing (for example "topic may have limited stock footage"), flag it for user attention instead of silently proceeding.

---

## STEP 10: Packaging (Optional)

After the verdict block reads PASS and is stripped, the script is done. Packaging is a separate run on top of it: say "package it" (or include it in the original request) and `packaging-skill.md` runs on the final script. What comes back is the upload kit:

→ 3 title options, built from the patterns in `title-formulas-skill.md`
→ Description, tags, and pinned comment
→ 2 thumbnail prompts

All of it in the channel's voice, under the same nothing-invented discipline: every claim in the kit traces to the script itself or to the brief's PROOF BANK. Packaging is optional and not part of the mandatory gate. Skipping it changes nothing about the script.

---

## LONG-FORM SCRIPTS (45 Minutes to 2+ Hours)

### Why You Can't Just Ask for a 1-Hour Script

Claude writes ~2,500-3,500 words well in a single generation. That's 10-15 minutes of video content.

Ask for 45 minutes (11,000+ words) or 1 hour (15,000+ words) in one shot and you get:
- **Voice drift** - The tone at minute 40 sounds nothing like minute 5
- **Fact confusion** - Names, dates, and details start bleeding together
- **Pacing collapse** - Monotone energy, no emotional variation
- **Disconnected ending** - The conclusion forgets what the intro promised

**The solution:** Write in sections. Each section is its own focused generation that maintains quality.

---

### The Complete Long-Form Workflow

#### STEP 1: Get Your Structure First

Before writing anything, ask Claude to plan the full video:

```
I want to create a [LENGTH] documentary about [TOPIC].

Give me a section-by-section outline with:
- Section titles
- What each section covers
- Target timestamps for each section
- The emotional beat of each section (tension, revelation, tragedy, hope, etc.)

Don't write the script yet. Just the structure.
```

**Example output you'll get:**

```
BLOCKBUSTER: THE RISE AND FALL (60 minutes)

SECTION 1: THE BEGINNING (0:00 - 10:00)
- Blockbuster's founding in 1985 by David Cook
- The VHS revolution and why video rental exploded
- The first store in Dallas, Texas
- Emotional beat: NOSTALGIA, WONDER

SECTION 2: THE EMPIRE (10:00 - 22:00)
- Expansion to 9,000 stores worldwide
- The Friday night Blockbuster experience
- Peak revenue of $6 billion
- Emotional beat: DOMINANCE, PEAK

SECTION 3: THE THREAT (22:00 - 35:00)
- Netflix launches DVD-by-mail in 1997
- The $50 million acquisition offer Blockbuster rejected
- Early warning signs ignored
- Emotional beat: DRAMATIC IRONY, TENSION

SECTION 4: THE COLLAPSE (35:00 - 50:00)
- 2008 financial crisis accelerates decline
- Store closures begin (800 stores in one year)
- Bankruptcy filing in 2010
- Emotional beat: TRAGEDY, INEVITABILITY

SECTION 5: THE LAST STORE (50:00 - 60:00)
- The Bend, Oregon location that survived
- What Blockbuster meant to a generation
- The lessons for modern businesses
- Emotional beat: BITTERSWEET, REFLECTION
```

**Review this outline.** Adjust sections, move content around, change emotional beats. Get the structure right before you write a single word.

---

#### STEP 2: Write the Hook + First Section

Now write your opening. The hook sets the voice for the entire video.

```
Write the HOOK and SECTION 1 of my Blockbuster documentary.

Full video structure:
[PASTE YOUR ENTIRE OUTLINE HERE]

This section covers:
- Blockbuster's founding in 1985 by David Cook
- The VHS revolution and why video rental exploded
- The first store in Dallas, Texas

Target length: 10 minutes (~2,500 words)
Emotional beat: Nostalgia, wonder
Output mode: [Traditional/Vidrush]

Use the Faceless Scripts OS methodology.
```

**Save the last 2-3 sentences of this section.** You'll need them for the next step.

---

#### STEP 3: Write Each Following Section

For every section after the first, use this template:

```
Write SECTION [NUMBER] of my Blockbuster documentary.

Full video structure:
[PASTE YOUR ENTIRE OUTLINE - so Claude knows where this fits]

Previous section ended with:
"[PASTE THE LAST 2-3 SENTENCES OF THE PREVIOUS SECTION]"

This section covers:
[BULLET POINTS OF WHAT THIS SECTION IS ABOUT]

Target length: [X] minutes (~[Y] words)
Emotional beat: [THE EMOTION FOR THIS SECTION]

Maintain the same voice, tone, and energy as the hook. Match the sentence rhythm and commentary style from Section 1.
```

**Why include the previous section's ending?**
It anchors Claude's voice. Without it, each section sounds like a different writer.

**Why include the full outline every time?**
Claude needs to know what came before AND what's coming after. A section in the middle should build toward what's next.

---

#### STEP 4: Connect Your Sections

Each section should END with a transition hook that pulls viewers into the next section.

**Weak transition:**
> "And that's how Blockbuster became the biggest video rental chain in America. Next, we'll look at the competition."

**Strong transition:**
> "By 1999, Blockbuster had 9,000 stores and $6 billion in revenue. They were untouchable. But 2,000 miles away in Los Gatos, California, a company with 30 employees was about to make them an offer. An offer Blockbuster would laugh at. An offer that would cost them everything."

If Claude's section endings are weak, ask:
```
Rewrite the ending of this section with a stronger transition hook into Section [X].
Make viewers NEED to keep watching.
```

---

#### STEP 5: Voice Consistency Check

After all sections are written, run a consistency check:

```
Review my complete documentary script for voice consistency.

[PASTE ALL SECTIONS TOGETHER]

Check for:
1. Energy level shifts - Does any section suddenly feel flat or hyper?
2. Sentence rhythm changes - Did the pacing change mid-video?
3. Tone inconsistencies - Did humor disappear? Did seriousness become preachy?
4. Commentary style drift - Did "we" become "you"? Did questions disappear?
5. Transition smoothness - Do sections flow or feel stitched together?

Flag specific lines that feel off and suggest fixes.
```

---

### Voice Consistency Checklist

Before starting EACH new section, mentally check:

- [ ] **Re-read your hook** - What's the energy level? Match it.
- [ ] **Check your commentary style** - Are you asking rhetorical questions? Using "we"? Keep doing it.
- [ ] **Maintain humor/seriousness ratio** - If Section 1 had 2 jokes, Section 4 shouldn't have zero.
- [ ] **Keep sentence rhythm patterns** - If you mix short punchy sentences with longer flowing ones, keep that rhythm.
- [ ] **Match specificity level** - If Section 1 uses specific names and dates, don't get vague later.

---

### Long-Form Length Guide

| Video Length | Sections | Words per Section | Total Words |
|--------------|----------|-------------------|-------------|
| 45 minutes | 4-5 | 2,500-3,000 | 11,000-13,000 |
| 60 minutes | 5-6 | 2,500-3,000 | 14,000-17,000 |
| 90 minutes | 6-8 | 2,500-3,000 | 20,000-24,000 |
| 2 hours | 8-10 | 2,500-3,000 | 27,000-32,000 |

**Never write more than 3,500 words in a single generation.** Quality drops sharply past that point.

---

### Common Long-Form Mistakes

**Mistake 1: Writing sections out of order**
Don't skip around. Write Section 1, then 2, then 3. The voice builds on itself.

**Mistake 2: Forgetting to paste the outline**
Every section prompt needs the full outline. Claude must know the big picture.

**Mistake 3: Not including previous section's ending**
This is the #1 cause of voice drift. Always include those last 2-3 sentences.

**Mistake 4: Making sections too long**
A 20-minute section will lose quality. Break it into two 10-minute sections.

**Mistake 5: Different prompts for different sections**
Use the SAME prompt template every time. Consistency in your prompts = consistency in output.

---

## Usage

### Traditional Editing Mode (Default)

```
Write a faceless YouTube script.

Topic: [What the video is about]
Format: [Documentary / Listicle / Exposé / True Crime / Video Essay]
Length: [X words] (or [Y minutes] at your calibrated wpm)
Niche: [Celebrity / True Crime / Business / History / etc.]
Brief: [paste your research brief, or leave blank to run research first]

Use the Faceless Scripts OS methodology.
```

### Vidrush AI Mode

```
Write a faceless YouTube script for Vidrush.

Topic: [What the video is about]
Format: [Documentary / Listicle / Exposé]
Length: [X words from the Talking Point Density table for your target minutes]
Niche: [Category]
Brief: [paste your research brief, or leave blank to run research first]

Output Mode: Vidrush
Use the Faceless Scripts OS methodology.
```

**On the Length line:** state it in words. Minutes only convert through YOUR channel's words-per-minute rate, so calibrate once: paste 2-3 of your past scripts with their final video timestamps and ask for your average wpm. No past uploads yet: start at 145 wpm and calibrate after your first video. Target words = minutes × your wpm. **That wpm calibration applies to Traditional mode.** Vidrush word targets come from the Talking Point Density table in the VIDRUSH MODE section instead, because Vidrush's TTS pacing and visual density run on different math. Calibrating a Vidrush channel means timing your own rendered videos, not your voiceover.

### What Claude Does

**Both modes (Research → Brainstorm → Structure → Write → Greenlight):**
1. Read the research brief (STEP 0), or ask for one if none was provided
2. Identify the correct format from TOPIC + STRUCTURE HINT
3. Apply the proven hook pattern, built from ANGLE + HOOK DIRECTION
4. Structure using the appropriate template
5. Write the body from the PROOF BANK, with faceless personality techniques
6. Generate complete draft
7. **GREENLIGHT AUDIT** (mandatory - see STEP 9)
   - Run Groups A-E from `greenlight-audit-skill.md`, plus the mode scan
   - On FIX-THEN-PASS, loop the whole audit to convergence
   - On PASS, strip the verdict block
8. Output the final script
9. **PACKAGING (optional, on request):** if the user says "package it" or asked for it upfront, run `packaging-skill.md` on the passed script for the upload kit (title options, description, tags, pinned comment, thumbnail prompts) - see STEP 10

**Traditional mode adds:**
- Visual cues `[B-ROLL:]`, `[CLIP:]` throughout
- Timestamps for structure

**Vidrush mode adds:**
- Four Pillars header
- Clean TTS-ready prose
- Visual keywords embedded naturally
- Density-matched talking points

---

**Faceless Scripts OS** - 4,000+ scripts. 40+ niches. One system, two output modes. Research at the front, greenlight at the end.
