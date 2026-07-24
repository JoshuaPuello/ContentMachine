import { readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const backendDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const skillDir = resolve(backendDir, '..', '.claude', 'skills', 'faceless-scripts-os');
const referencesDir = join(skillDir, 'references');

const readReference = (name) => readFileSync(join(referencesDir, name), 'utf8');
const runtimeGuide = readReference('contentmachine-documentary-runtime.md');

const ALWAYS_REFERENCES = [
  'faceless-scripts-os-master.md',
  'voice-anchoring-skill.md',
  'humanizer-skill.md',
  'retention-mechanics-skill.md',
  'script-structures-skill.md',
  'variety-rotation-skill.md',
  'greenlight-audit-skill.md',
];

const storyText = (story = {}) => JSON.stringify(story).toLowerCase();

export const routeNarrationSkills = (story = {}, cinemaOptions = {}) => {
  const text = storyText(story);
  let format = 'documentary';
  let specialtyReference = null;

  if (/\b(murder|crime|criminal|prison|escape|heist|kidnap|investigation|police|fbi|trial|serial killer|disappearance|robbery|fraud|alcatraz)\b/.test(text)) {
    format = 'true-crime';
    specialtyReference = 'true-crime-skill.md';
  } else if (/\b(celebrity|actor|actress|singer|rapper|influencer|hollywood|fame|scandal)\b/.test(text)) {
    format = 'celebrity-documentary';
    specialtyReference = 'celebrity-documentary-skill.md';
  } else if (/\b(biograph|surviv|rescue|transformation|rise and fall|soldier|explorer|inventor|athlete|leader|journey)\b/.test(text)) {
    format = 'hero-journey-documentary';
    specialtyReference = 'heros-journey-skill.md';
  }

  const references = [...ALWAYS_REFERENCES];
  if (specialtyReference) references.push(specialtyReference);
  if (cinemaOptions.trailerEnabled) {
    references.push('REAL-FACELESS-HOOK-SWIPE.md', 'NICHE-SPECIFIC-HOOKS.md');
  }
  references.push('outro-psychology-skill.md');

  return { format, specialtyReference, references: [...new Set(references)] };
};

export const buildNarrationSkillPrompt = (story = {}, cinemaOptions = {}) => {
  const routing = routeNarrationSkills(story, cinemaOptions);
  const specialty = routing.specialtyReference
    ? `\n\n## Selected niche reference\nUse its story structure and sensitivity guidance. The ContentMachine runtime guide overrides any conflicting output-format examples.\n\n${readReference(routing.specialtyReference)}`
    : '';
  return {
    ...routing,
    prompt: `## FacelessOS ContentMachine runtime\nSelected format: ${routing.format}\nSelected references: ${routing.references.join(', ')}\n\n${runtimeGuide}${specialty}`,
  };
};

const spokenText = (unit) => (unit?.lines || [])
  .filter((line) => !String(line).trim().startsWith('['))
  .join(' ')
  .replace(/\s+/g, ' ')
  .trim();

const sentencesOf = (text) => (
  text.match(/[^.!?]+(?:[.!?]+["')\]]*|$)/g) || []
).map((sentence) => sentence.trim()).filter(Boolean);

const wordCount = (text) => (text.match(/[A-Za-z0-9']+/g) || []).length;

const HARD_BANS = [
  /\blet'?s dive(?: in| into)?\b/i,
  /\blet'?s break (?:this|it) down\b/i,
  /\bwithout further ado\b/i,
  /\blet'?s unpack\b/i,
  /\blet'?s jump (?:in|into)\b/i,
  /\bbuckle up\b/i,
  /\bhere'?s the kicker\b/i,
  /\b(?:evolving|shifting|changing|ever-changing|digital) landscape\b/i,
  /\b(?:delve|tapestry|unleash|robust|game[ -]?changer)\b/i,
];

export const auditNarrationContinuity = (sequence = []) => {
  const violations = [];
  const units = sequence.map((unit, index) => ({
    id: unit.unit_id || unit.scene_id || `unit-${index + 1}`,
    text: spokenText(unit),
  })).filter((unit) => unit.text);
  const fullText = units.map((unit) => unit.text).join(' ');
  const sentences = sentencesOf(fullText);
  const lengths = sentences.map(wordCount);
  const totalWords = wordCount(fullText);
  const plannedSeconds = sequence.reduce((sum, unit) => sum + (Number(unit?.duration) || 0), 0);
  const wordsPerSecond = plannedSeconds > 0 ? totalWords / plannedSeconds : 0;

  if (/[—–]|--/.test(fullText)) {
    violations.push('H15: spoken narration contains a dash construction; rewrite it with spoken punctuation or a connective word.');
  }
  for (const pattern of HARD_BANS) {
    const match = fullText.match(pattern);
    if (match) violations.push(`Machine-ban: remove "${match[0]}" from spoken narration.`);
  }
  for (let index = 0; index < lengths.length - 1; index++) {
    if (lengths[index] <= 4 && lengths[index + 1] <= 4) {
      violations.push(`H17 Staccato-Robotic: consecutive fragment-sized sentences near "${sentences[index]} ${sentences[index + 1]}".`);
      break;
    }
  }
  for (let index = 0; index < lengths.length - 2; index++) {
    if (lengths.slice(index, index + 3).every((length) => length <= 8)) {
      violations.push(`H17 Staccato-Robotic: three consecutive short sentences begin at "${sentences[index]}".`);
      break;
    }
  }
  const shortDensity = lengths.length
    ? lengths.filter((length) => length <= 8).length / lengths.length
    : 0;
  if (lengths.length >= 6 && shortDensity > 0.34) {
    violations.push(`H17 rhythm: ${Math.round(shortDensity * 100)}% of sentences are eight words or fewer; translate the fragment-heavy register into flowing speech.`);
  }
  if (/(?:^|[.!?]\s+)(?:one|no)\b[^.!?]{0,55}[.!?]\s+(?:one|no)\b/i.test(fullText)) {
    violations.push('H17 Movie Trailer: repeated "One/No" sentence beats are being used for rhythm instead of natural narration.');
  }
  for (const unit of units) {
    if (wordCount(unit.text) < 6) {
      violations.push(`Unit ${unit.id} is too fragmentary to sound like connected documentary narration.`);
    }
  }
  if (plannedSeconds > 0 && wordsPerSecond > 2.65) {
    violations.push(`Production pacing: ${totalWords} words across ${plannedSeconds.toFixed(1)} planned seconds is ${wordsPerSecond.toFixed(2)} words/second; tighten to 2.65 or below without reintroducing fragments.`);
  }

  return {
    pass: violations.length === 0,
    violations: [...new Set(violations)],
    metrics: {
      units: units.length,
      sentences: sentences.length,
      shortSentencePercent: Math.round(shortDensity * 100),
      totalWords,
      plannedSeconds: Number(plannedSeconds.toFixed(1)),
      wordsPerSecond: Number(wordsPerSecond.toFixed(2)),
    },
  };
};
