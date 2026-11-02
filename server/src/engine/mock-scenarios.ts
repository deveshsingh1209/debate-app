/**
 * Scripted content for mock engine v2. Every company, person, figure and
 * source below is invented: the sources sit on reserved `.example` domains and
 * name fictional publishers. Nothing here is research.
 *
 * Write cut-able turns with at least three sentences and no abbreviations
 * ending in a period ("Dr.", "vs."), because the director finds sentence
 * boundaries by punctuation.
 */
import { citationId, type MockExpert, type Scenario } from './mock-v2.ts';

const SRC = {
  nrr: 'https://benchmarks.example/devtools-pricing-2025',
  variance: 'https://finops.example/revenue-variance-by-model',
  compression: 'https://pricingnotes.example/seat-compression',
};

const ex = (
  id: string, name: string, role: string, tagline: string, bio: string, expertise: string[], personality: string, biases: string, style: string,
  color: string, initials: string,
  temperament: MockExpert['temperament'], belief: MockExpert['belief'],
): MockExpert => ({ persona: { id, name, role, tagline, bio, expertise, personality, biases, style, color, initials }, temperament, belief });

// ---------- Scenario 1: the pricing room (3 experts, the one to watch) ----------

export const PRICING: Scenario = {
  key: 'pricing',
  title: 'THE SEAT PRICE PROBLEM',
  topic: 'Halyard sells a CI tool at $29 per seat per month. Customers are adopting AI coding assistants and shrinking their teams, so seats are falling while usage rises. Should Halyard move new customers to usage-based pricing before its Series B?',
  goal: 'Decide whether, from 1 January, new Halyard customers are priced on usage instead of per seat: the model (pure usage or a hybrid with a committed minimum), how existing accounts are protected, and the tripwires that would reverse the call.',
  founder: 'Dana',
  stakes: {
    decisionOwner: { name: 'FOUNDER', role: 'CEO of Halyard' },
    decideBy: 'the board meeting on 12 November',
    atRisk: {
      money: '$2.1M of Q1 renewals across 38 enterprise accounts (61% of ARR)',
      time: 'about nine weeks of billing and metering work',
      reputation: 'the Series B story, due in roughly nine months',
    },
    ifWrong: {
      yes: 'revenue swings with other people\'s build schedules, the forecast the Series B rests on stops being believable, and customers who hate surprise invoices churn.',
      no: 'seat compression keeps eating 6 to 9 percent of expansion a year while the competitors who moved first set the new price anchor.',
    },
    reversibility: 'one-way',
    source: 'founder',
  },
  clarify: [
    { question: 'Is the choice between seats and pure pay-as-you-go, or are hybrids on the table?', options: ['Pure usage only', 'Hybrids are fine', 'Panel should decide'] },
    { question: 'Do existing customers move too, or only new ones?', options: ['New customers only', 'Everyone, eventually', 'Undecided'] },
  ],
  contextBrief: 'The uploaded pack is a board memo draft and a billing export. It states ARR of $9.2M, 410 customers and 38 enterprise accounts at 61 percent of ARR, gross margin of 78 percent, and an average seat count per account that fell 7 percent over four quarters while build minutes rose 22 percent. The memo promises the board a pricing recommendation on 12 November.',
  scopeRationale: 'One decision with a hard edge: the pricing model for new customers. Three voices are enough because the real argument has three sides, forecast risk, customer pain and growth upside, and a fourth voice would only repeat one of them. Standard depth answers the strongest objection and names what would change each mind.',
  experts: [
    ex('priya', 'Priya Raman', 'Fractional CFO, ex-infrastructure software', 'Put it in a cell.',
      'Ran finance for two developer-tool companies through their Series B. Has seen a usage forecast miss by a quarter\'s worth of hiring.',
      ['forecasting', 'unit economics', 'fundraising'], 'Clipped, dry, unimpressed by stories.', 'Overweights forecast risk; trusts only numbers she can recompute.', 'Short declarative sentences. Numbers first.',
      '#22d3ee', 'PR',
      { heatGain: 0.22, heatDecay: 0.12, interruptThreshold: 0.72, dominance: 0.55 },
      { stance: -1, confidence: 'medium', crux: 'Revenue I cannot forecast to within a few points is revenue the Series B will discount.', reasons: ['Seat revenue forecasts to within 4 percent a quarter.', 'Usage moves with customers\' build schedules, not ours.'] }),
    ex('tomas', 'Tomás Ferreira', 'Head of Product and Growth', 'Price the thing that grows.',
      'Built the pricing for a developer-tools company that went from seats to usage and doubled expansion revenue. Tells it as a story every time.',
      ['pricing', 'product-led growth', 'packaging'], 'Warm, fast, a storyteller who leads with an anecdote.', 'Believes everything compounds; discounts the customer who just wants a bill they can predict.', 'Anecdote first, then the claim. Analogies.',
      '#a78bfa', 'TF',
      { heatGain: 0.26, heatDecay: 0.1, interruptThreshold: 0.78, dominance: 0.8 },
      { stance: 2, confidence: 'high', crux: 'We charge for the thing that is shrinking and give away the thing that is growing.', reasons: ['Our largest account fell from 60 to 41 seats at constant build volume.', 'Customers say they value pipeline minutes, not people.'] }),
    ex('adaeze', 'Adaeze Okafor', 'VP Customer Success', 'Who gets the phone call?',
      'Eleven years running customer success for enterprise infrastructure vendors. Has taken the call from a platform lead holding an invoice nobody expected.',
      ['enterprise accounts', 'renewals', 'support'], 'Combative and socratic; answers a claim with a question.', 'Overweights the angriest customer; underweights what happens if the product stalls.', 'Questions back. Names the customer.',
      '#fb923c', 'AO',
      { heatGain: 0.3, heatDecay: 0.1, interruptThreshold: 0.56, dominance: 0.62 },
      { stance: -1, confidence: 'low', crux: 'A bill the customer cannot predict is a reason to throttle us or leave.', reasons: ['Platform teams cap usage to stay under budget.', 'Surprise invoices turn champions into cancellations.'] }),
  ],
  panelRationale: 'Three seats, three fault lines: forecast against growth (Priya and Tomás), growth against customer pain (Tomás and Adaeze), and customer pain against the spreadsheet (Adaeze and Priya). The chair keeps the cost of a wrong yes and a wrong no in front of them.',
  motion: {
    id: 'm1',
    title: 'USAGE-LINKED PRICING FOR NEW CUSTOMERS',
    motion: 'From 1 January, new Halyard customers are priced on usage, as pure pay-as-you-go or as a hybrid with a committed minimum, instead of per seat. Existing accounts keep their current terms until the room says otherwise.',
  },
  plan: {
    revision: 1,
    rationale: 'One motion, with the grandfathering question inside it.',
    items: [
      { id: 'a1', title: 'Is seat compression real?', detail: 'One account, or the trend?', status: 'active' },
      { id: 'a2', title: 'Forecast risk against upside', detail: 'What usage does to the number the board sees.', status: 'pending' },
      { id: 'a3', title: 'Protecting existing accounts', detail: 'Grandfathering and bill shock.', status: 'pending' },
    ],
  },
  sources: [
    { url: SRC.nrr, title: 'Developer-tool pricing models and net revenue retention, 2025', publisher: 'Meridian SaaS Benchmarks (fictional)', publishedAt: '2025-04-14', quote: 'Median net revenue retention was 118% for usage-based, 108% for seat-based and 114% for hybrid developer tools with a committed minimum.' },
    { url: SRC.variance, title: 'Quarterly revenue variance by pricing model', publisher: 'Ledgerline Research (fictional)', publishedAt: '2025-06-02', quote: 'Quarterly revenue landed within 4% of forecast for seat-based, 14% for pure usage and 6% for hybrid with a committed minimum.' },
    { url: SRC.compression, title: 'Seat compression after AI coding assistants', publisher: 'Pricing Notes (fictional)', publishedAt: '2025-08-21', quote: 'Teams adopting AI assistants cut paid developer seats by a median of 9% within two quarters.' },
  ],
  findings: [
    { claim: 'Median net revenue retention: usage-based 118%, seat-based 108%, hybrid with a committed minimum 114%.', figure: { value: '118 / 108 / 114', unit: 'percent', asOf: '2025' }, source: 0, confidence: 'medium' },
    { claim: 'Quarterly revenue variance against forecast: seat-based 4%, pure usage 14%, hybrid 6%.', figure: { value: '4 / 14 / 6', unit: 'percent', asOf: '2025' }, source: 1, confidence: 'medium' },
    { claim: 'Teams adopting AI assistants cut paid seats by a median of 9% within two quarters.', figure: { value: '9', unit: 'percent', asOf: '2025' }, source: 2, confidence: 'low' },
  ],
  researchSummary: 'Across the benchmark set, usage-based developer tools post the highest median net revenue retention (118 percent against 108 for seat-based) {0}. The price is forecast variance: quarterly revenue lands within 14 percent of forecast for pure usage against 4 percent for seats {1}. A hybrid with a committed minimum sits between them, at 114 percent retention and 6 percent variance {0}{1}. Seat compression after AI-assistant adoption is real but modest in the median case, about 9 percent in two quarters {2}. Confidence: medium; the sources are industry benchmarks, not Halyard data.',
  researchSpoken: 'Usage-based developer tools post median net revenue retention of 118 percent against 108 for seat-based {0}. Variance is the cost: 14 percent against 4 {1}. A hybrid with a committed minimum lands at 114 percent and 6 percent variance {0}{1}. Seat compression is real, about 9 percent in two quarters {2}.',
  beats: [
    { t: 'round', round: 1, fresh: 3, rung: 1, rungName: 'mechanism', note: 'Positions stated; the mechanism behind each is on the table.' },
    { t: 'chair', text: 'Here is the call. Halyard charges twenty-nine dollars a seat, and seats are shrinking while usage grows. {founder} takes a recommendation to the board on the twelfth, and a pricing change is hard to walk back once forty enterprise accounts have seen it. Tomás, you want this. Make the case.' },
    {
      t: 'say', id: 'm_pr_tomas_1', who: 'tomas', shape: 'set_piece', to: ['priya', 'adaeze'],
      text: 'Let me tell you what happened to our biggest account last quarter. They had sixty seats. They rolled out an AI pair programmer, and two months later they had forty-one, with exactly the same number of builds. Same value delivered, a third less revenue, and nobody did anything wrong. That is seat compression, and it is coming for every tool priced per developer. Our customers keep telling us what they value, and it is pipeline minutes, not people. We charge for the thing that is shrinking and give away the thing that is growing. Price the thing that grows.',
      claims: [{ text: 'Largest account fell from 60 to 41 seats in two months at constant build volume.', grade: 'observed' }],
    },
    { t: 'react', id: 'm_pr_adaeze_r1', who: 'adaeze', text: 'Sixty to forty-one. That is one account.', to: ['tomas'] },
    {
      t: 'say', id: 'm_pr_priya_1', who: 'priya', shape: 'set_piece', to: ['tomas'], question: 'What is December revenue under the usage model, as one number?',
      text: 'One account is a story, not a trend. Here is the number I care about. Seat revenue forecasts to within four percent a quarter, so I can tell the board in October what December looks like. Usage revenue moves with someone else\'s build schedule. A holiday freeze, a bad release, a customer reorg, and my quarter moves ten points. Series B investors pay for predictability. Tomás, one number: what is our December revenue under your model? Not a range.',
    },
    { t: 'heat', who: 'adaeze', times: 1 },
    {
      t: 'cut', id: 'm_pr_tomas_2', cutId: 'm_pr_adaeze_cut', who: 'tomas', shape: 'reply', to: ['priya'], dodge: true, by: 'adaeze', intensity: 3, atSentence: 4, pauseMs: 1800,
      text: 'Fair challenge, and I will answer it straight. We back-tested last year\'s invoices under usage pricing. Revenue would have come in higher in eleven of twelve months, and the swing is mostly upward, because usage only compounds when customers succeed. You are pricing the downside of variance, and I am pricing the upside of growth. And the customers who love us most will grow into the bill without ever noticing it.',
      cutIn: 'Without noticing? Who calls them when the invoice triples?',
      resume: { id: 'm_pr_tomas_3', shape: 'reply', text: 'Let me finish. They get an alert at eighty percent of their usual spend, and a person on our side picks up the phone first. That is a design problem. It is not a reason to keep charging for a unit that is shrinking.' },
      takes: { id: 'm_pr_adaeze_3', shape: 'reply', text: 'I will answer my own question. Their finance lead does, at nine at night, and then that person calls me. I have taken that call. A surprise invoice is the fastest way I know to turn a champion into a cancellation.' },
    },
    { t: 'aside', from: 'priya', to: 'adaeze', text: 'He still has not given me a number. If he dodges again, push on the invoice shock. It is the same hole from your side.' },
    { t: 'react', id: 'm_pr_priya_r2', who: 'priya', text: 'That is still not a December number.', to: ['tomas'], question: 'What is December revenue under the usage model, as one number?' },
    {
      t: 'say', id: 'm_pr_adaeze_1', who: 'adaeze', shape: 'set_piece', to: ['tomas'],
      text: 'Here is what usage pricing does to my customers. Their bill becomes something they have to forecast, and most platform teams cannot. So they cap usage. They throttle their own builds to stay under budget, and our product gets used less, which is the opposite of what Tomás wants. Do you remember what happened to the CI vendors who billed per minute? Customers wrote scripts to avoid them. Why would we hand our best accounts a reason to use us less?',
    },
    { t: 'round', round: 2, fresh: 2, rung: 2, rungName: 'evidence', note: 'Two sourced claims on the table; the December number is still unanswered.' },
    { t: 'chair', expect: 'dodge', text: 'Tomás. Priya has asked for the December number twice, and you have answered the questions around it. I am not letting that slide, and I am not going to demand an answer you do not have. Do you have one?' },
    {
      t: 'say', id: 'm_pr_tomas_4', who: 'tomas', shape: 'reply', to: ['priya'],
      text: 'No. I cannot give you a point estimate, Priya, and nobody honest can. The range is the answer, and I think we should find out how wide it really is before we bet on it.',
    },
    { t: 'chair', text: 'Then we stop guessing. Research desk: what do published benchmarks say about net revenue retention and forecast variance for usage-based against seat-based developer tools, and what does a hybrid with a committed minimum do to both?' },
    { t: 'research', question: 'Net revenue retention and forecast variance: usage-based vs seat-based vs hybrid developer-tool pricing.', thinking: 'Three questions in one: retention by model, variance by model, and where a committed minimum lands. Start with benchmark reports rather than vendor blogs, since vendors selling metering have a reason to flatter usage. Look for a variance figure from forecast, not from year over year, because the CFO will check which one. If a single source covers all three models, prefer it and cross-check the variance number with a second.' },
    { t: 'limit_pause', ms: 5000 },
    { t: 'round', round: 3, fresh: 3, rung: 3, rungName: 'stress', note: 'The strongest objection (forecast risk) has been made and the desk has an answer to it.' },
    {
      t: 'say', id: 'm_pr_priya_2', who: 'priya', shape: 'set_piece', to: ['tomas', 'adaeze'],
      text: 'Hybrid at six percent variance. That I can take to a board. It is not four, but a committed minimum is a floor I can model, and it turns most of Tomás\'s upside into contracted revenue. Set the floor at seventy percent of trailing spend and I move. Pure pay-as-you-go, no. Hybrid with a floor, yes.',
    },
    {
      t: 'concede', expert: 'priya', to: { stance: 1, confidence: 'medium' }, kind: 'conditional',
      movedBy: { kind: 'evidence', ref: citationId(SRC.variance), who: 'research' },
      cost: 'her insistence on a flat, seat-based forecast',
    },
    {
      t: 'ask_founder', question: 'Have you promised any enterprise account price protection in writing?', context: 'The grandfathering terms depend on it. A written promise is a constraint; a verbal one is a negotiation.',
      options: [
        { label: 'Yes, a few', description: 'There are written price locks we cannot change.' },
        { label: 'No', description: 'Nothing in writing; we are free to set terms.' },
        { label: 'Not sure', description: 'Someone needs to check the contracts.' },
      ],
      assumed: 'Assumed no written price locks exist, and flagged for legal review before any terms are announced.',
    },
    { t: 'heat', who: 'tomas', times: 1 },
    {
      t: 'cut', id: 'm_pr_adaeze_2', cutId: 'm_pr_tomas_cut', who: 'adaeze', shape: 'set_piece', to: ['tomas', 'priya'], by: 'tomas', intensity: 3, atSentence: 3, pauseMs: 1500,
      text: 'I can live with a hybrid if the existing accounts are protected. Our top thirty-eight accounts are on annual contracts, and they will read any change as the start of a price increase. Grandfather them for twenty-four months, the length of a full budget cycle. Anything shorter and we renegotiate in the middle of their budget year, which is exactly when they shop us.',
      cutIn: 'Twenty-four months? Twelve, and not a day more.',
      resume: { id: 'm_pr_adaeze_3b', shape: 'reply', text: 'Let me finish. Twenty-four months is the length of a contract cycle for the accounts that carry sixty percent of revenue. Twelve means we reopen the price while they are still deciding whether to renew.' },
      takes: { id: 'm_pr_tomas_5', shape: 'reply', text: 'Twelve, Adaeze. Every month of grandfathering is a month the seat curve keeps bleeding, and a longer lock means the best customers carry us for two years at yesterday\'s price.' },
    },
    { t: 'aside', from: 'adaeze', to: 'tomas', text: 'I am closer to you than I sound. I just need the existing accounts to hear it from a person before they see an invoice.' },
    { t: 'react', id: 'm_pr_priya_r3', who: 'priya', text: 'Twelve is a number I can model. Twenty-four, I cannot.', to: ['adaeze', 'tomas'] },
    {
      t: 'say', id: 'm_pr_tomas_6', who: 'tomas', shape: 'reply', to: ['adaeze', 'priya'],
      text: 'Fine. Hybrid, with a floor and a twelve-month lock on the existing accounts. Let us call it that and move on.',
    },
    {
      t: 'concede', expert: 'tomas', to: { stance: 1, confidence: 'medium' }, kind: 'tactical',
      movedBy: { kind: 'unexplained' }, cost: 'the clean pay-as-you-go story',
    },
    { t: 'chair', expect: 'unexplained', text: 'Tomás, a minute ago you were at two out of two on pure usage, and nobody has put a new fact in front of you since. What moved you?' },
    {
      t: 'say', id: 'm_pr_tomas_7', who: 'tomas', shape: 'reply', to: ['adaeze', 'priya'],
      text: 'Honestly? {founder}\'s board will not take a model that Priya cannot forecast. That is not a fact about pricing. It is a fact about who has to sign.',
    },
    { t: 'round', round: 4, fresh: 1, rung: 4, rungName: 'falsifier', note: 'Each side has named what would change its mind.' },
    { t: 'chair', text: 'The room has stopped finding new ground. Here is where I land.' },
  ],
  decision: {
    motionId: 'm1',
    motionTitle: 'USAGE-LINKED PRICING FOR NEW CUSTOMERS',
    decision: 'From 1 January, price new customers on a hybrid: a platform fee plus a committed usage minimum set at 70 percent of trailing spend, with overage billed at the metered rate. Do not offer pure pay-as-you-go. Existing accounts keep seat pricing for 12 months.',
    owner: '{founder}',
    rationale: 'The benchmark data puts a hybrid at 114 percent net revenue retention and 6 percent forecast variance, which keeps most of the upside Tomás wants and a forecast Priya can defend to a board. Adaeze\'s bill-shock objection is answered by the floor, usage alerts and a named contact; her objection to a 12-month lock is not answered and is recorded as a dissent.',
    evidence: 'mixed',
    dependsOn: [],
    dissents: [
      {
        expert: 'adaeze',
        position: 'Twelve months of grandfathering is too short for the 38 enterprise accounts.',
        reasoning: 'Tripwire: if more than three of the 38 ask for a price lock at renewal by 28 February, twelve months was wrong and the lock should be extended. Cost of ignoring it: up to $1.4M of Q1 renewals reopened in the middle of their budget year.',
      },
    ],
  },
  closings: [
    { who: 'priya', text: 'Hybrid with a floor at seventy percent of trailing spend. I move to that and not an inch beyond. If the committed minimum drops below sixty percent in negotiation, my forecast is fiction and I will say so.' },
    { who: 'adaeze', text: 'I accept the hybrid and I dissent on the lock. Twelve months will cost us renewals, and I have written down how we will know by the end of February.' },
    { who: 'tomas', text: 'We stopped charging for the shrinking thing, and that was the whole point. Ship the hybrid, meter it properly, and make the first invoice impossible to be surprised by.' },
  ],
  audit: {
    checked: 3,
    summary: 'Two of the three figures the room relied on hold. The 70 percent floor is a proposal rather than a computed figure, and nothing in the pack shows what it does to the 38 enterprise accounts.',
    findings: [
      { figure: 'Hybrid forecast variance of 6 percent', verdict: 'holds', recomputed: 'Matches the Ledgerline benchmark (fictional) quoted by the research desk', impact: '' },
      { figure: 'Largest account fell from 60 to 41 seats', verdict: 'holds', recomputed: 'Matches the billing export in the uploaded pack', impact: '' },
      { figure: 'A 70 percent floor keeps enterprise accounts whole', verdict: 'uncheckable', recomputed: 'No per-account trailing spend in the pack', impact: 'The floor was set without testing it against the 38 accounts that matter most.' },
    ],
  },
  spend: { perSpoken: 0.55, perReaction: 0.04 },
};

// ---------- Scenario 2: the library hours (3 experts, shorter) ----------

export const LIBRARY: Scenario = {
  key: 'library',
  title: 'SUNDAYS OR MAKERS',
  topic: 'The Calder Falls public library can fund a teen makerspace only by closing on Sundays. Should it?',
  goal: 'Decide whether the library closes on Sundays to fund a teen makerspace, or finds the money another way, before the board votes on 3 December.',
  founder: 'Ruth',
  stakes: {
    decisionOwner: { name: 'FOUNDER', role: 'chair of the library board' },
    decideBy: 'the board vote on 3 December',
    atRisk: {
      money: '$86,000 a year in operating costs, and a $140,000 state matching grant that lapses on 31 January',
      people: 'about 310 Sunday visitors a week, and roughly 40 teens who would use a makerspace',
    },
    ifWrong: {
      yes: 'the one seven-day public space in town closes on the day seniors and job seekers rely on it.',
      no: 'the matching grant lapses and the teen programme stays in a borrowed back room for another year.',
    },
    reversibility: 'two-way',
    source: 'dossier',
  },
  clarify: [
    { question: 'Is Sunday the only day that could close?', options: ['Sunday only', 'Any day', 'Panel should decide'] },
  ],
  contextBrief: 'The uploaded pack is the library\'s annual report and the grant notice. It records 310 average Sunday visits, a $140,000 state matching grant that requires a dedicated teen space by 31 January, and $86,000 a year of operating cost for the makerspace.',
  scopeRationale: 'One local decision, three real positions. Three voices cover the staffing view, the programme view and the budget view without padding, and a quick pass is enough to find the one number that decides it.',
  experts: [
    ex('marguerite', 'Marguerite Oyelaran', 'Library director, 24 years', 'The people with nowhere else come on Sundays.',
      'Has run the Calder Falls library since 2001 and knows most Sunday regulars by name.',
      ['public libraries', 'staffing', 'access'], 'Plain, dry, unhurried.', 'Overweights the people already in the building.', 'Plain sentences. Names the regulars.',
      '#22d3ee', 'MO',
      { heatGain: 0.22, heatDecay: 0.12, interruptThreshold: 0.74, dominance: 0.6 },
      { stance: -2, confidence: 'high', crux: 'Closing Sunday takes the day that matters most to people with the fewest options.', reasons: ['Sunday visitors skew to seniors, job seekers and families without home internet.'] }),
    ex('jamal', 'Jamal Pruitt', 'Youth programme director', 'Fourteen-year-olds do not wait for the next grant.',
      'Runs the library\'s after-school programme out of a borrowed back room. Tells every argument as a story about one kid.',
      ['youth programmes', 'makerspaces', 'grants'], 'Passionate, a storyteller.', 'Overweights the kid in front of him; underweights who loses the hours.', 'One kid, one story, then the claim.',
      '#a78bfa', 'JP',
      { heatGain: 0.28, heatDecay: 0.1, interruptThreshold: 0.58, dominance: 0.7 },
      { stance: 2, confidence: 'high', crux: 'The grant deadline is real and the teens have no space.', reasons: ['The matching grant lapses on 31 January.', 'Forty teens already use the back room.'] }),
    ex('hollis', 'Hollis Brandt', 'County budget analyst', 'Which line item?',
      'Reads library budgets for the county. Has no stake in the answer, only in the arithmetic.',
      ['public budgets', 'grant compliance'], 'Clipped, neutral, allergic to adjectives.', 'Distrusts any figure he cannot trace to a line.', 'Fragments. Numbers. Questions.',
      '#34d399', 'HB',
      { heatGain: 0.2, heatDecay: 0.14, interruptThreshold: 0.8, dominance: 0.45 },
      { stance: 0, confidence: 'low', crux: 'Whether Sunday is really the cheapest day to cut.', reasons: ['Nobody has put per-day cost on the table.'] }),
  ],
  panelRationale: 'Access against youth programming is the fight; the budget analyst is the seat that makes both of them show their arithmetic.',
  motion: {
    id: 'm1',
    title: 'CLOSE SUNDAYS TO FUND THE MAKERSPACE',
    motion: 'The Calder Falls library closes on Sundays from 1 January and uses the savings to fund the teen makerspace.',
  },
  plan: {
    revision: 1,
    rationale: 'One motion.',
    items: [
      { id: 'a1', title: 'What Sunday actually costs and delivers', detail: 'Per-day cost against visits.', status: 'active' },
      { id: 'a2', title: 'Other ways to fund the makerspace', detail: 'Which hours, if any, give.', status: 'pending' },
    ],
  },
  sources: [
    { url: 'https://libraries.example/hours-and-use-survey-2025', title: 'Public library visits by day of week, mid-sized towns', publisher: 'Civic Library Survey (fictional)', publishedAt: '2025-03-10', quote: 'Monday morning accounted for 2% of weekly visits and 11% of staffed hours; Sunday for 9% of visits.' },
    { url: 'https://grants.example/matching-guidance', title: 'Matching grant guidance for dedicated youth spaces', publisher: 'State Library Grants Office (fictional)', publishedAt: '2025-09-01', quote: 'A dedicated space may operate on a scheduled basis and need not be open every day the library is open.' },
  ],
  findings: [
    { claim: 'Monday morning is 2% of weekly visits but 11% of staffed hours; Sunday is 9% of visits.', figure: { value: '2 / 11 / 9', unit: 'percent', asOf: '2025' }, source: 0, confidence: 'medium' },
    { claim: 'A grant-funded youth space may run on a schedule rather than every open day.', source: 1, confidence: 'medium' },
  ],
  researchSummary: 'In comparable towns Monday morning accounts for about 2 percent of weekly visits and 11 percent of staffed hours, while Sunday accounts for 9 percent of visits {0}. The state grant guidance allows a dedicated youth space to run on a schedule instead of every open day {1}. Confidence: medium; neither source is about Calder Falls.',
  researchSpoken: 'Monday morning is about 2 percent of weekly visits and 11 percent of staffed hours in comparable towns, Sunday is 9 percent of visits {0}. And the grant allows a youth space to run on a schedule, not every open day {1}.',
  beats: [
    { t: 'chair', text: 'The board votes on the third of December. The question is whether Sunday closes to pay for a teen makerspace. Jamal, start with the kid.' },
    {
      t: 'say', id: 'm_li_jamal_1', who: 'jamal', shape: 'set_piece', to: ['marguerite', 'hollis'],
      text: 'There is a fifteen-year-old who builds drone frames on a folding table in our back room, because we have no bench. He told me last week that if the room closes, he stops coming at all. We have forty kids like him, and a state grant that lapses on the thirty-first of January. A makerspace is not a luxury for them. It is the only place in town where what they make counts as a reason to show up.',
    },
    { t: 'react', id: 'm_li_marguerite_r1', who: 'marguerite', text: 'I know the boy. I am not arguing about him.', to: ['jamal'] },
    { t: 'heat', who: 'jamal', times: 1 },
    {
      t: 'cut', id: 'm_li_marguerite_1', cutId: 'm_li_jamal_cut', who: 'marguerite', shape: 'set_piece', to: ['jamal', 'hollis'], by: 'jamal', intensity: 3, atSentence: 3, pauseMs: 1500,
      text: 'I am arguing about Sunday. About three hundred and ten people come on a Sunday, and they are the people with the fewest other places to go. Seniors, job seekers, families without internet at home. Close the doors and those people lose the one day we are the only option, and no grant fixes that.',
      cutIn: 'And the forty kids lose the only option they have?',
      resume: { id: 'm_li_marguerite_2', shape: 'reply', text: 'Let me finish. They lose a room, and I want them to have a room. They do not lose a day that three hundred people plan their week around.' },
      takes: { id: 'm_li_jamal_2', shape: 'reply', text: 'Forty kids, Marguerite. Forty, and a deadline. Three hundred people can read a library notice and come on Saturday. A fifteen-year-old does not get another January.' },
    },
    { t: 'aside', from: 'hollis', to: 'marguerite', text: 'Nobody has shown which day is cheapest to cut. I suspect it is not Sunday. Ask for the staffed-hours table.' },
    { t: 'chair', text: 'Hollis, you have been quiet. Is Sunday actually the cheapest day to cut?' },
    {
      t: 'say', id: 'm_li_hollis_1', who: 'hollis', shape: 'reply', to: ['marguerite', 'jamal'],
      text: 'Unknown. Nobody has put per-day cost on the table. You are comparing a day to a room without a price on either.',
    },
    { t: 'research', question: 'Visits and staffed hours by weekday for comparable libraries, and what the state matching grant requires of a dedicated youth space.', thinking: 'Two separate questions. First, weekday use against weekday staffing in towns of similar size. If one low-use slot carries a lot of staffed hours, that is the cheaper cut. Second, the grant text itself: whether a dedicated space has to be open every day the library is, because that changes what has to close.' },
    {
      t: 'say', id: 'm_li_jamal_3', who: 'jamal', shape: 'reply', to: ['marguerite', 'hollis'],
      text: 'The grant does not need the makerspace open seven days. So we need the room, not the Sundays. Give us Tuesday and Thursday evenings and I can live with that.',
    },
    {
      t: 'concede', expert: 'jamal', to: { stance: 0, confidence: 'medium' }, kind: 'partial',
      movedBy: { kind: 'evidence', ref: citationId('https://grants.example/matching-guidance'), who: 'research' },
      cost: 'a seven-day makerspace and the clean win',
    },
    {
      t: 'say', id: 'm_li_hollis_2', who: 'hollis', shape: 'reply', to: ['marguerite'],
      text: 'Then cut Monday morning, not Sunday. That is eleven percent of staffed hours for two percent of visits.',
    },
    {
      t: 'concede', expert: 'hollis', to: { stance: -1, confidence: 'medium' }, kind: 'tactical',
      movedBy: { kind: 'unexplained' }, cost: 'his neutrality',
    },
    { t: 'chair', expect: 'unexplained', text: 'Hollis, you came in at zero and you were the neutral seat. You are now against closing Sunday, and nothing new reached you. What moved you?' },
    {
      t: 'say', id: 'm_li_hollis_3', who: 'hollis', shape: 'reply', to: ['marguerite', 'jamal'],
      text: 'The Monday figure. Once I saw it, closing Sunday looked like the expensive way to save the same money.',
    },
    { t: 'chair', text: 'Good. That is a ruling I can write down.' },
  ],
  decision: {
    motionId: 'm1',
    motionTitle: 'CLOSE SUNDAYS TO FUND THE MAKERSPACE',
    decision: 'Keep Sunday open. Fund the makerspace by closing Monday mornings, and run it Tuesday and Thursday evenings in the second meeting room.',
    owner: '{founder}',
    rationale: 'Comparable towns show Monday morning carrying 11 percent of staffed hours for 2 percent of visits, and the grant guidance allows a scheduled youth space. Both of the stated goals can be met without closing the day the most vulnerable visitors rely on.',
    evidence: 'mixed',
    dependsOn: [],
    dissents: [
      {
        expert: 'jamal',
        position: 'Two evenings a week is too little for the forty teens.',
        reasoning: 'Tripwire: if average evening attendance is above 25 for six consecutive weeks, add a third evening. Cost of ignoring it: the programme the grant exists to fund runs below capacity.',
      },
    ],
  },
  closings: [
    { who: 'marguerite', text: 'Sunday stays. Monday morning goes, and I will tell the regulars myself. Mark my words: two evenings is a fine start.' },
    { who: 'jamal', text: 'Two evenings is a start and I will take it. If the benches fill, add a third. I will bring the count to the board in February.' },
    { who: 'hollis', text: 'Monday morning, two evenings, one meeting room. Every figure traces to a line. That is all I ask.' },
  ],
  spend: { perSpoken: 0.3, perReaction: 0.03 },
};

export const SCENARIOS: Record<string, Scenario> = { pricing: PRICING, library: LIBRARY };
