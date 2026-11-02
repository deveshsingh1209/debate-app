/**
 * The room's tics, as data (docs/PHASE2-PLAN.md 2e).
 *
 * One list, three readers: the metrics script counts these in transcripts,
 * the realism linter scores a turn against them before it is published, and
 * the prompt selftest asserts no prompt builder's output contains a phrase the
 * room is not supposed to say. The biggest finding of the Phase 2 diagnosis
 * was that the room's dialect was quoted from its own prompts, so the fix for
 * a new tic is an edit here plus a prompt rewrite, never a new special case in
 * the engine. Update it from the metrics script's "top shared openers and
 * 4-grams" output after each real run.
 */

/**
 * Praise and agreement filler: words that cost the speaker nothing and tell
 * the room nothing. Matched once per turn (a turn either leans on it or not).
 */
export const FILLER: RegExp[] = [
  /\b(great|good|fair|excellent|interesting|valid|important) (point|question|catch)\b/i,
  /\bwell said\b/i, /\bspot on\b/i, /\babsolutely right\b/i, /\bexactly right\b/i,
  /\bi (completely|totally|fully|entirely) agree\b/i, /\bi agree with\b/i, /\bi hear you\b/i,
  /\bi appreciate\b/i, /\bthank you\b/i, /\bwith (all due )?respect\b/i, /\bto be fair\b/i,
  /\bthat'?s (a )?(really )?(fair|good|great)\b/i, /\bbuilding on\b/i, /\bto build on\b/i,
];

/**
 * Concession markers: a speaker giving ground. Proxy, not proof. `POSITION_CHANGE`
 * is the strong subset: a stated change of position, not a courtesy
 * ("you're right that...").
 */
export const CONCESSION: RegExp[] = [
  /\bi concede\b/i, /\bconceded?\b/i, /\bconceding\b/i, /\bi withdraw\b/i, /\bwithdrawn\b/i,
  /\bi was wrong\b/i, /\bi('m| am) wrong\b/i, /\byou('re| are) right\b/i, /\b\w+ is right\b/i,
  /\bi take (it|the correction|that)\b/i, /\bi revise\b/i, /\bi('m| am) moving off\b/i,
  /\bi drop\b/i, /\bi lose (it|that|the)\b/i, /\bthat breaks my\b/i, /\bit fired\b/i,
  /\bchanges my (mind|ruling|number|view)\b/i, /\bi accept\b/i, /\bfair, i\b/i,
];
export const POSITION_CHANGE: RegExp[] = [
  /\bi withdraw\b/i, /\bi was wrong\b/i, /\bi revise\b/i, /\bi('m| am) moving off\b/i,
  /\bchanges my (mind|ruling|number|view)\b/i,
  // "my own claim just broke", but not "my falsifier has not fired"
  /\bmy (own )?(\w+ )?(claim|thesis|falsifier|load-bearing claim)\b(?![^.]{0,40}\b(not|never|didn't|hasn't)\b)[^.]{0,40}\b(broke|breaks|fired|failed)\b/i,
  /\bi concede the (whole|motion|band|point)\b/i, /\bwithdrawn as\b/i, /\bi drop (my|the)\b/i,
];

/**
 * The broader concession list, for MEASURING only (the metrics script). People
 * mostly give ground with small words ("fair enough", "granted", "true, but"),
 * which the strict list above misses: on the AMI and ICSI corpora it read
 * zero concessions per 100 turns at the median. The linter keeps the strict
 * list, so a courtesy is not flagged for saying "true".
 */
export const CONCESSION_BROAD: RegExp[] = [
  /\bfair enough\b/i, /\bthat'?s fair\b/i, /\bgranted\b/i, /\bpoint taken\b/i,
  /\bi('ll| will) give you that\b/i, /\byou have a point\b/i, /\bi take your point\b/i, /\bi stand corrected\b/i,
  /(?:^|[.!?]\s+)(?:yeah|yes|okay|ok),? (?:that'?s )?(?:fair|true|right)\b/i,
  /(?:^|[.!?]\s+)true[,.]/i, /(?:^|[.!?]\s+)agreed\b/i,
];

/**
 * First words that make an opener a discourse marker ("yeah I think", "okay
 * so", "well the"): the commonest way any human turn starts, so the metrics
 * script does not count a shared one as a house opener.
 */
export const DISCOURSE_OPENER = new Set(['yeah', 'yep', 'yes', 'okay', 'ok', 'so', 'well', 'um', 'uh', 'right', 'oh', 'mm', 'hmm', 'alright', 'no']);

/**
 * Tics this corpus shows over and over. Each one is fine once; the problem is
 * a room where every voice reaches for the same move. Counted per 100 expert
 * turns by the metrics script (a turn can hit several).
 */
export const TICS: Record<string, RegExp> = {
  // "X is not A, it is B" / "not A, it's B": the dominant construction.
  antithesis: /\b(is|was|are|'s)\s+not\s+(a |an |the )?[^.;:?!]{1,60}?[,;]\s+(it|that|this|they)('s| is| are|'re| was)\b/i,
  // "the strongest version of your case", "take your point at its strongest"
  steelmanFormula: /\b(strongest version|at its strongest|strongest (honest )?case)\b/i,
  // "Ana is closer to right", "Bo is closer"
  closerToRight: /\bcloser( to right)?\b[,.]/i,
  // speech about one's own speech: "I'll say it plainly", "out loud", "I'll name"
  metaSpeech: /\b(say (it|that|this|so) (plainly|out loud|aloud)|out loud|i'?ll name|let me (be clear|name)|i will say)\b/i,
  // "own my bias", "against my own book/instinct"
  biasDisplay: /\b(own(ing)? my (own )?bias|my bias|against my own (book|instinct|line|case))\b/i,
  // evidence labels spoken as a parenthetical: "(observed, from ...)"
  labelParenthetical: /\((measured|observed|assumed|persona)\b/i,
  // "what everyone is missing" / "nobody has named"
  nobodyHasSaid: /\b(what everyone is missing|nobody (here |in this room )?has (yet )?(named|said|asked|priced)|the (route|thing|one) nobody)\b/i,
  // the position-card mechanic leaking into speech
  falsifierJargon: /\b(falsifier|load-bearing claim)\b/i,
  // ending on a tidy summary
  narrowly: /^(narrowly|plainly|briefly|one sentence|one answer|priced|dates, then)\b/i,
};

/** Endings that wrap the turn up for the listener instead of leaving it open. */
export const SUMMARY_ENDING = /^(so[, ]|so the |which means|that is why|that's why|in short|bottom line|net[:,]|the point is|the honest|the answer is|that is the|that's the)/i;

/** The antithesis construction, every occurrence (the TICS entry finds the first). */
export const ANTITHESIS_ALL = new RegExp(TICS.antithesis.source, 'gi');

/**
 * Phrases no prompt may contain, because the room repeated them back as its
 * own dialect (Phase 2 diagnosis, item 3). Each is the PROMPT form that seeded
 * a corpus tic. A prompt describes the behaviour instead ("answer the person,
 * not the chair") and never scripts the words. Checked against every prompt
 * builder's output by prompts.selftest.ts.
 */
export const PROMPT_BANNED: { id: string; re: RegExp }[] = [
  { id: 'closer_to_right', re: /\bcloser to right\b/i },
  { id: 'strongest_version', re: /\bstrongest version\b|\bat (its|their|your) strongest\b/i },
  { id: 'everyone_missing', re: /\bwhat (is )?everyone( is)? missing\b/i },
  { id: 'own_bias', re: /\bown (my|your|his|her|their|the) bias|\(own them\b|\byours to own\b/i },
  { id: 'out_loud', re: /\bout loud\b|\baloud\b/i },
  { id: 'say_it_plainly', re: /\bsay it plainly\b/i },
  { id: 'name_the_cost', re: /\bname the cost\b|\bwhat (that|it|this) costs (you|me)\b|\bsay what it costs\b/i },
  { id: 'falsifier_spoken', re: /\b(my|your|his|her|their) (own )?falsifier\b|\bfalsifier (has |hasn'?t |has not )?(fired|not fired)\b/i },
  { id: 'change_my_mind', re: /\bwould change (my|your|his|her|their) mind\b/i },
  { id: 'spoken_label', re: /\((measured|observed|assumed)\)|\blabel (every|each|the) claim|\blabel behavioural claims\b|\blabel it,? (as )?(measured|observed|assumed)\b|\bsay the word\b/i },
  { id: 'against_my_book', re: /\bagainst (my|your) own book\b/i },
];

/**
 * What the realism linter refuses in SPEECH. Broader than PROMPT_BANNED where
 * the spoken form is the problem: an expert saying "falsifier" at all is the
 * position card's machinery leaking into the room, while the card's own
 * system prompt has to use the word to ask for one.
 */
export const SPEECH_BANNED: { id: string; re: RegExp }[] = [
  { id: 'closer_to_right', re: /\bcloser to right\b/i },
  { id: 'strongest_version', re: TICS.steelmanFormula },
  { id: 'everyone_missing', re: TICS.nobodyHasSaid },
  { id: 'own_bias', re: TICS.biasDisplay },
  { id: 'meta_speech', re: TICS.metaSpeech },
  { id: 'name_the_cost', re: /\bname the cost\b|\bthat costs me\b|\bwhat (that|it) costs (you|me)\b/i },
  { id: 'falsifier_jargon', re: TICS.falsifierJargon },
  { id: 'change_my_mind', re: /\bwould change my mind\b/i },
];

/** Melodrama: stakes inflated past anything the room has shown (2d). */
export const MELODRAMA = /\b(destroy (everything|the company|us)|existential (threat|risk)|this (will|could) (kill|sink|end) (us|the company|the business)|catastroph(e|ic))\b/i;
