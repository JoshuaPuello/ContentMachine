#!/usr/bin/env python3
# FacelessOS v5 scanner. Run this over your voiceover script before recording.
# Catches "trailer voice" and hard-banned AI-slop phrases before you hit record on the voiceover.
"""
trailer-voice-scan.py: pre-recording voice check for your FacelessOS scripts.

Flags candidate MOVIE TRAILER / WISE NARRATOR / STACCATO-ROBOTIC / READING-NOT-SPEAKING
shapes in the likely-spoken paragraphs of your script files.

DOCTRINE (do not skip): this scanner FLAGS, it does not FAIL. Every hit gets judged by
the shape test: "have you ever actually said a sentence with this shape?"
Expected FALSE POSITIVES that are real speech, leave them alone:
  - enumerations ("Save up. Pay cash. Stay out of debt." / "Number nine. Graz, in Austria.")
  - live-demo narration ("Now listen. This is before." / "Checks done. Now the satisfying part.")
  - natural self-correction ("I'm not. I'm wrong constantly.")
  - a verified verbal tic that's genuinely how you talk
Real POSITIVES look like: "Not smaller. Gone." / "The exhaustion is daily." /
"Monitoring is the thermometer. Execution is the medicine." / "you'll never look at X the same way"

The scanner reads plain text paragraphs and skips bullets, headers, and bold-prefixed
lines. Format your voiceover copy as plain paragraphs when scanning.

Usage: python3 trailer-voice-scan.py your-script.md [more files or globs...]
"""
import re, sys, glob as g

# HARD-BAN SLOP. These are ABSOLUTE in spoken copy. A verified verbal tic NEVER licenses one
# of these. Quirky personal tics stay, but phrases on THIS list never get written even if you
# say them in every recording. The ONLY sanctioned pivot is the literal "Let's get into it",
# max once, where it is your channel's earned convention.
HARD_BAN = [
 (r"\blet'?s dive(?: in| into)?\b|\bdive into it\b", 'HARD-BAN: let\'s dive in/into'),
 (r"\blet'?s break (?:this|it) down\b", 'HARD-BAN: let\'s break this down'),
 (r"\bwithout further ado\b", 'HARD-BAN: without further ado'),
 (r"\blet'?s unpack\b", 'HARD-BAN: let\'s unpack'),
 (r"\blet'?s jump (?:in|into)\b", 'HARD-BAN: let\'s jump in'),
 (r"\bbuckle up\b", 'HARD-BAN: buckle up'),
 (r"\bhere'?s the kicker\b", 'HARD-BAN: here\'s the kicker'),
 (r"\bdelve\b|\btapestry\b|\bunleash\b|\brobust\b", 'HARD-BAN: slop vocab'),
 (r"\bgame.?changer\b", 'HARD-BAN: game-changer'),
 (r"\bin today'?s (?:world|day and age)\b", 'HARD-BAN: dated-opener slop'),
 (r"\b(?:evolving|shifting|changing|ever[- ]changing|current|modern|competitive|digital)\s+landscape\b", 'HARD-BAN: landscape-metaphor slop'),
]
# v5 divergences (deliberate): (A) hard-ban matching is case-insensitive so sentence-initial
# capitals ("Let's dive in.") still fire. The TELLS below stay case-sensitive on purpose.
# The capital "In" of the trailer-open pattern is load-bearing against false positives.
# (D) restored robust / "in today's world" / landscape-metaphor hard-bans that the source
# prose (humanizer H4, greenlist banned-words) declared but the gate scanner omitted; the
# landscape ban is metaphor-only, so bare literal "landscape" (nature/history/travel) passes.
HARD_BAN = [(re.compile(rx, re.IGNORECASE), name) for rx, name in HARD_BAN]

TELLS = HARD_BAN + [
 (r'\bNot [a-z]+\. [A-Z]', 'not-X-period beat'),
 (r'\. Not [a-z][^.]{0,30}\.', 'trailing "Not Y." beat'),
 (r'\btells you everything\b', 'aphoristic "tells you everything"'),
 (r'\bchanges everything\b', 'aphoristic "changes everything"'),
 (r'\bsays everything about\b', 'aphoristic "says everything"'),
 (r'\bnothing would ever be the same\b|\bnever the same again\b', 'narrator prophecy'),
 (r"\byou'?ll never look at\b|\byou will never look at\b", 'second-person prophecy'),
 (r'\bIn a world\b', 'trailer open'),
 (r'\bThis is the story of\b', 'narrator open'),
 (r'\bwhat happens next\b', 'narrator tease'),
 (r'\bone at a time\b', 'parallel-fall cadence (judge in context)'),
 (r'\bThe rest, as they say\b', 'narrator cliche'),
 (r'\bis the (thermometer|medicine|engine|fuel|currency|architecture) of\b|\bis the \w+\. \w+ is the \w+\.', 'clever written pair'),
]

def spoken_paras(text):
    """plain paragraphs = likely word-for-word blocks (not bullets/headers/italic notes)"""
    for para in text.split('\n\n'):
        s = para.strip()
        if not s:
            continue
        first = s.lstrip()[0]
        if first in '-#*(>|`[':
            continue
        if s.startswith('**'):
            continue
        yield s

def short_sents(para):
    sents = [x.strip() for x in re.split(r'(?<=[.!?]) +', para) if x.strip()]
    shorts = [x for x in sents if len(x.split()) <= 4 and x[-1:] in '.!'
              and not x.lower().startswith(('let', 'so', 'ok', 'okay', 'yeah', 'yes', 'no,', 'go.', 'now,'))]
    return shorts, len(sents)

def scan(path):
    text = open(path, encoding='utf8', errors='ignore').read()
    if 'SUPERSEDED' in text[:200]:
        return []
    hits = []
    for para in spoken_paras(text):
        for rx, name in TELLS:
            for m in re.finditer(rx, para):
                ctx = para[max(0, m.start()-40):m.end()+40].replace('\n', ' ')
                hits.append(f"  [{name}] ...{ctx}...")
        shorts, total = short_sents(para)
        if len(shorts) >= 2:
            head = para[:70].replace(chr(10), ' ')
            hits.append(f"  [staccato x{len(shorts)}/{total}] " + " | ".join(f'"{s}"' for s in shorts[:4]) + f"  << {head}...")
    return hits

if __name__ == '__main__':
    args = sys.argv[1:]
    if not args:
        print("Usage: python3 trailer-voice-scan.py your-script.md [more files or globs...]")
        sys.exit(0)
    files = sorted(set(f for a in args for f in (g.glob(a) or [a])))
    total = 0
    for f in files:
        try:
            hits = scan(f)
        except OSError as e:
            print(f"!! {f}: {e}"); continue
        if hits:
            total += len(hits)
            print('=' * 100); print(f)
            for h in hits[:12]:
                print(h)
    print(f"\n{total} candidate flags across {len(files)} files. Judge each flag by the shape test in voice-anchoring-skill.md: have you ever actually said a sentence with this shape? Enumerations are real speech, leave them alone.")
