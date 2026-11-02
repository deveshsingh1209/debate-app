/**
 * Rich sample ReportData for the renderer.
 * Fictional debate: "Should I build a premium supplement organizer box D2C
 * brand for India?" Doubles as the renderer's test fixture and as the
 * reference shape for the report-analyst prompt.
 *
 * Covers every ChartSpec kind (bar, line, donut, radar, matrix with id
 * 'risk-matrix'), 7 decisions, 3 dissents, 10 risks, 2 tables, 4 roadmap
 * phases, open questions and a moderator note with genuine edge.
 */

import type { ReportData } from '../../../shared/report-types.ts';

export const sampleReport: ReportData = {
  title: 'Supplement Organizer D2C',
  subtitle: 'Panel verdict on a premium supplement organizer subscription brand for urban India',
  generatedAtIso: '2026-07-27T14:05:00.000Z',
  topic:
    'I want to build a premium supplement organizer box brand for India, direct to consumer. Something beautiful that sits on the kitchen counter, weekly compartments, maybe refill packs, targeting people who take multiple vitamins and supplements daily. Premium price point, premium materials. Is this a real business or an expensive hobby?',
  goal: 'Decide whether to build a premium supplement organizer D2C brand for urban India, and if yes, define the business model, pricing, go-to-market sequence, and the gates that would kill it.',
  model: 'Claude · chair Opus 5.5',
  mode: 'directed',
  autonomy: 'interactive',

  panel: [
    { id: 'marcus', name: 'Marcus', role: 'Moderator and devil’s advocate', color: '#67e8f9' },
    { id: 'kavita', name: 'Dr. Kavita Rao', role: 'Nutraceutical regulation and FSSAI compliance', color: '#f472b6' },
    { id: 'ananya', name: 'Ananya Iyer', role: 'D2C growth, scaled a beauty brand to ₹40 Cr ARR', color: '#38bdf8' },
    { id: 'rohan', name: 'Rohan Mehta', role: 'Supply chain and consumer hardware manufacturing', color: '#fbbf24' },
    { id: 'priya', name: 'Priya Deshmukh', role: 'Consumer psychology and pricing research', color: '#a78bfa' },
    { id: 'sameer', name: 'Sameer Kulkarni', role: 'E-commerce finance and unit economics', color: '#34d399' },
    { id: 'nikhil', name: 'Dr. Nikhil Bhandari', role: 'Preventive health physician, adherence science', color: '#fb7185' },
  ],

  stats: {
    messages: 214,
    interjections: 37,
    researchTasks: 9,
    planRevisions: 3,
    userDecisions: 6,
    assumptions: 2,
    durationMin: 96,
  },

  keyRecommendation:
    'Build the adherence subscription, not the box: launch a ₹1,499 starter kit with ₹499 monthly refill packs, prove day-60 refill retention of 35 percent on a 500-unit pilot, and commit zero tooling capital until that gate clears.',

  executiveSummary: [
    'The panel voted 5 to 2 to build, but only after the product was reframed. A premium organizer box sold once is a gifting SKU with no repeat revenue, competing in the buyer’s head with a ₹299 Amazon generic. What survived the debate is an adherence system: a well-made weekly organizer as the hardware anchor, monthly refill packs as the revenue engine, and WhatsApp-based habit nudges as the retention layer.',
    'Pricing landed at a ₹1,499 starter kit plus ₹499 per month for refills. The kit price roughly covers hardware and acquisition cost on day one, which makes each new subscriber close to self-liquidating. Sameer’s model shows the subscription overtaking a one-time ₹2,999 premium SKU on 12-month contribution by roughly 27 percent, but only if average retention holds past five months. That single assumption carries the whole business case.',
    'Go-to-market is creators first, marketplaces later. The subscription pitch dies in an Amazon comparison grid, and the onboarding flow that drives adherence needs owned channels. Paid social is capped at 30 percent of acquisition spend; the blended CAC target is ₹750 with referral and creator barter doing the heavy lifting. Amazon opens in month 5 strictly as an acquisition door, with the subscription upsell moved to the insert and WhatsApp.',
    'Manufacturing starts deliberately unglamorous: a certified white-label organizer with custom-printed packaging for the pilot, and no domestic tooling until a 10,000 units per month run-rate is in sight. Rohan dissents on this and his objection is recorded in full. The panel’s view is that ₹8.5 lakh of tooling before a single retention data point is the classic hardware founder trap.',
    'The kill criteria are explicit and Sam accepted them on the record. A 500-unit pilot over 8 weeks must clear three gates: sell-through above 60 percent, day-60 refill retention at or above 35 percent, and blended CAC at or below ₹750. Retention is the red gate; a miss below 25 percent kills the project outright rather than triggering another pivot debate.',
    'The honest tension the report preserves: two of seven experts believe the safer business is the one Sam originally described, a beautiful premium object sold once at ₹2,999. The panel majority holds that a box business has no moat and no compounding, while an adherence loop has both. The pilot is designed to settle exactly that argument with data instead of taste.',
  ],

  decisions: [
    {
      topic: 'Product wedge',
      conclusion: 'The product is an adherence system sold as a subscription; the organizer box is the hardware anchor, not the business.',
      proposedBy: 'Dr. Nikhil Bhandari',
      supportedBy: [
        {
          expert: 'Ananya Iyer',
          argument: 'Repeat revenue is what makes Indian D2C economics work at this AOV. A one-time box is a gifting SKU: one spike in November, silence after.',
        },
        {
          expert: 'Priya Deshmukh',
          argument: 'A lone box gets price-anchored against ₹299 Amazon generics. A system with refills and streaks escapes that comparison entirely.',
        },
      ],
      challengedBy: [
        {
          expert: 'Rohan Mehta',
          objection: 'A subscription adds refill SKUs, reverse logistics and a packing line from day one. That is triple the ops surface for a solo founder.',
        },
        {
          expert: 'Sameer Kulkarni',
          objection: 'Subscription revenue is worthless if month-3 churn is high; you would just be financing your own COGS with float you do not have.',
        },
      ],
      resolution:
        'Nikhil’s adherence framing plus Ananya’s LTV math settled it: at 35 percent day-60 retention the subscription beats the one-time model on 12-month contribution by about 27 percent, and the pilot gate converts Sameer’s churn objection into a measurable kill criterion instead of a matter of opinion.',
      dependsOn: [
        'Day-60 refill retention of at least 35 percent',
        'Refill pack COGS stays under ₹240',
        'FSSAI treats refill packs as food supplements, not medical devices',
      ],
      userInput: 'Sam confirmed he wants a repeat-revenue business, not a single-SKU brand, and accepted the retention gate as the go or no-go line.',
    },
    {
      topic: 'Pricing model',
      conclusion: 'A ₹1,499 starter kit plus ₹499 monthly refills, replacing both the ₹2,999 one-time premium and the pure-subscription options.',
      proposedBy: 'Priya Deshmukh',
      supportedBy: [
        {
          expert: 'Sameer Kulkarni',
          argument: 'The kit price covers hardware COGS and most of CAC on day one, so every subscriber is nearly self-liquidating before the first refill ships.',
        },
        {
          expert: 'Ananya Iyer',
          argument: '₹1,499 sits under the impulse ceiling for the urban wellness buyer on Instagram; ₹2,999 forces a considered purchase and halves conversion.',
        },
      ],
      challengedBy: [
        {
          expert: 'Dr. Kavita Rao',
          objection: '₹499 a month invites a pharmacy-price comparison. The pack contents have to visibly justify it or the number reads as rent on a plastic box.',
        },
        {
          expert: 'Marcus',
          objection: 'Why ₹499 and not ₹399? The panel was converging on a round number without evidence and I pushed for the basis.',
        },
      ],
      resolution:
        'Priya’s price-laddering data on comparable wellness subscriptions (the ₹450–650 band) plus Sameer’s contribution model settled it: ₹399 breaks even on a subscriber at month 9, ₹499 at month 6. Marcus accepted ₹499 on condition of an A/B against ₹449 inside the pilot.',
      dependsOn: [
        'Pilot A/B of ₹499 against ₹449 shows no cliff in conversion',
        'Refill perceived value holds against pharmacy comparison',
      ],
      userInput: 'Sam set a floor on the record: no discounting below ₹449 even in pilot experiments, to protect the premium read of the brand.',
    },
    {
      topic: 'Go-to-market',
      conclusion: 'Launch on an owned D2C site through Instagram creators; Amazon opens in month 5 as an acquisition-only door; quick-commerce waits for 5,000 subscribers.',
      proposedBy: 'Ananya Iyer',
      supportedBy: [
        {
          expert: 'Priya Deshmukh',
          argument: 'Marketplace buyers are price shoppers by context. The subscription story needs a landing page and a founder video, not a comparison grid.',
        },
        {
          expert: 'Dr. Nikhil Bhandari',
          argument: 'The adherence onboarding that drives retention lives in owned post-purchase flows. Amazon does not let you own that conversation.',
        },
      ],
      challengedBy: [
        {
          expert: 'Sameer Kulkarni',
          objection: 'Own-site acquisition through paid social is the most expensive door in Indian D2C right now; blended CAC could blow past ₹1,000.',
        },
        {
          expert: 'Rohan Mehta',
          objection: 'Amazon solves COD, returns and trust infrastructure that a new brand otherwise has to build alone. Skipping it is expensive purity.',
        },
      ],
      resolution:
        'A sequencing compromise: creators plus referral first with paid social capped at 30 percent of spend, and Amazon in month 5 as an acquisition channel with the subscription upsell moved to the package insert and WhatsApp. Sameer’s CAC concern became the ₹750 amber gate on the pilot scorecard.',
      dependsOn: ['Blended CAC at or below ₹750 by pilot end', 'Creator barter supplies at least 25 percent of pilot traffic'],
    },
    {
      topic: 'Manufacturing',
      conclusion: 'White-label the organizer hardware for the pilot; commit domestic tooling only past a 10,000 units per month run-rate.',
      proposedBy: 'Sameer Kulkarni',
      supportedBy: [
        {
          expert: 'Ananya Iyer',
          argument: 'Speed to a retention read beats mold ownership. Every week spent on tooling is a week not spent learning whether anyone refills.',
        },
        {
          expert: 'Dr. Kavita Rao',
          argument: 'A supplier that already holds food-contact certification shortcuts a 6 to 8 week compliance track we would otherwise run ourselves.',
        },
      ],
      challengedBy: [
        {
          expert: 'Rohan Mehta',
          objection: 'Premium positioning on catalog molds is brand debt. Everyone sees the same box on Alibaba at $4 and the story collapses.',
        },
        {
          expert: 'Priya Deshmukh',
          objection: 'The unboxing IS the premium signal at this price. If the hardware is generic, packaging has to carry the entire experience.',
        },
      ],
      resolution:
        'The panel split the premium signal from the mold: pilot on the best available certified white-label unit, with custom-printed packaging, insert and refill trays carrying the brand. The tooling decision moves behind the retention gate, where ₹8.5 lakh of capex becomes defensible with data.',
      dependsOn: ['White-label unit passes food-contact and drop tests', 'Landed hardware cost stays at or under ₹385 per kit'],
      userInput: 'Sam capped pre-gate capital at ₹6 lakh total and explicitly ruled out tooling spend before the pilot reads out.',
    },
    {
      topic: 'Target customer',
      conclusion: 'Primary: urban professionals aged 30–45 already buying three or more supplement SKUs; secondary: adult children managing parents’ regimens. Never a medical pitch.',
      proposedBy: 'Dr. Kavita Rao',
      supportedBy: [
        {
          expert: 'Dr. Nikhil Bhandari',
          argument: 'Multi-SKU buyers feel the organization pain weekly; single-SKU buyers do not have the problem this product solves.',
        },
        {
          expert: 'Priya Deshmukh',
          argument: 'The parents angle is emotionally powerful but must stay secondary, or the brand reads geriatric and the primary audience walks.',
        },
      ],
      challengedBy: [
        {
          expert: 'Ananya Iyer',
          objection: 'Two audiences means two creative tracks on a pilot budget. I wanted one ICP and one message until the gate clears.',
        },
        {
          expert: 'Marcus',
          objection: 'I challenged whether 3-plus-SKU buyers are even reachable as an ad audience, or just a persona that feels precise in a slide.',
        },
      ],
      resolution:
        'Kavita’s regulatory line settled the framing: wellness organization, never dosage or treatment claims, which also keeps FSSAI simple. Ananya conceded once the parents story was demoted to a retargeting layer rather than a separate funnel, and interest-stack tests were added to pilot week 1 to answer Marcus.',
      dependsOn: ['Ad platforms can approximate the multi-SKU buyer within 2x of target CAC'],
      userInput: 'Sam confirmed the primary ICP matches the 14 early adopters he interviewed before the debate.',
    },
    {
      topic: 'Brand and moat',
      conclusion: 'Position as a wellness ritual brand; the moat is the adherence loop of packs, streaks and community, with the box as the physical token.',
      proposedBy: 'Priya Deshmukh',
      supportedBy: [
        {
          expert: 'Ananya Iyer',
          argument: 'Community content compounds and gets cheaper over time; hardware differentiation depreciates from the day it ships.',
        },
        {
          expert: 'Dr. Nikhil Bhandari',
          argument: 'Streak mechanics lift refill retention 12 to 18 percent in comparable adherence programs; that delta is the whole margin story.',
        },
      ],
      challengedBy: [
        {
          expert: 'Sameer Kulkarni',
          objection: 'Moat talk at zero customers is decoration. The only moat that matters this year is surviving CAC math.',
        },
        {
          expert: 'Rohan Mehta',
          objection: 'A ritual does not stop a copycat pulling the same supplier catalog and undercutting by 40 percent in week one.',
        },
      ],
      resolution:
        'Marcus reframed the copycat threat as the argument FOR the loop: the hardware is provably copyable in 8 weeks, so defensibility has to live in data, habit and community or it does not exist. The panel adopted that framing with Sameer’s caveat that moat spend stays under 10 percent of pilot budget.',
      dependsOn: ['Nudge and streak layer ships with the pilot, not after it'],
    },
    {
      topic: 'Kill criteria',
      conclusion: 'A 500-unit pilot over 8 weeks with three gates: 60 percent sell-through, 35 percent day-60 refill retention, and blended CAC at or below ₹750.',
      proposedBy: 'Marcus',
      supportedBy: [
        {
          expert: 'Sameer Kulkarni',
          argument: 'Gates convert every unresolved argument in this room into a measurable bet with a date on it. That is what a pilot is for.',
        },
        {
          expert: 'Dr. Kavita Rao',
          argument: 'Eight weeks covers two full refill cycles, which is the minimum honest read on retention behavior.',
        },
      ],
      challengedBy: [
        {
          expert: 'Ananya Iyer',
          objection: 'A hard CAC gate mid-learning-phase executes channels before they optimize. Week-2 CAC is always ugly; that is not signal.',
        },
        {
          expert: 'Dr. Nikhil Bhandari',
          objection: 'Day-60 is early for habit formation; a strict read there risks killing a product that would have cleared at day-90.',
        },
      ],
      resolution:
        'Retention stays red at day-60 with a day-90 confirmatory read before any final kill; CAC becomes an amber gate that triggers channel rebalance rather than shutdown. Below 25 percent day-60 retention the project ends without a pivot debate, which everyone signed.',
      dependsOn: ['Weekly scorecard reviewed with Sam every Monday of the pilot'],
      userInput: 'Sam accepted all three gates on the record and asked for the weekly scorecard in his inbox rather than a dashboard.',
    },
  ],

  dissents: [
    {
      expert: 'Sameer Kulkarni',
      position: 'The one-time ₹2,999 premium kit is the safer wedge, and the panel is underweighting that.',
      reasoning:
        'The subscription stacks refill churn risk on top of CAC risk, and the cash cycle is worse: refill inventory is bought ahead of revenue that may not arrive. If day-60 retention lands at 25 to 30 percent, plausible for a habit product without an app, the one-time model quietly outperforms by month 12 with a third of the operational surface. He supports the pilot precisely because it can prove him wrong cheaply.',
    },
    {
      expert: 'Rohan Mehta',
      position: 'Custom domestic tooling should start now, not after the retention gate.',
      reasoning:
        'Tooling has a 14-week lead time. A positive pilot readout in week 14 still means two more quarters of shipping a catalog-mold product while claiming premium, which he considers brand debt that compounds. The ₹8.5 lakh is recoverable at 4,000 units and the mold is an asset even in an acquisition. He was outvoted on capital discipline grounds and stands by his objection.',
    },
    {
      expert: 'Dr. Nikhil Bhandari',
      position: 'Without a software adherence layer at launch, retention will miss the gate.',
      reasoning:
        'Physical organizers plus WhatsApp nudges historically underperform app-supported loops on 60-day adherence. He believes the panel scheduled the app for Phase 4 because of build cost, not evidence, and that the pilot is therefore testing a weaker version of the product than the one the thesis describes. If the gate is missed narrowly, he wants that read as an argument for the app, not against the business.',
    },
  ],

  risks: [
    {
      title: 'Refill churn breaks the model',
      likelihood: 'high',
      impact: 'high',
      mitigation: 'Day-60 red gate with day-90 confirmatory read; nudge A/B from week 1; founder calls to first 50 cancellations.',
      owner: 'Founder',
    },
    {
      title: 'CAC inflation on paid social',
      likelihood: 'high',
      impact: 'medium',
      mitigation: 'Paid capped at 30 percent of spend; creator barter and referral loop carry volume; ₹750 amber gate triggers rebalance.',
      owner: 'Growth',
    },
    {
      title: 'Copycat listings at half price',
      likelihood: 'high',
      impact: 'medium',
      mitigation: 'Moat built in the loop, not the box: packs, streaks, community. Design registration and trademark filed in Phase 1.',
      owner: 'Brand',
    },
    {
      title: 'Meta and WhatsApp platform dependency',
      likelihood: 'high',
      impact: 'medium',
      mitigation: 'Email and SMS fallback flows live from pilot; owned community space stood up by Phase 3.',
      owner: 'Growth',
    },
    {
      title: 'Single white-label supplier concentration',
      likelihood: 'medium',
      impact: 'high',
      mitigation: 'Second supplier qualified during Phase 2; 60-day buffer stock; molds and dielines documented for portability.',
      owner: 'Ops',
    },
    {
      title: 'Founder bandwidth as a solo operator',
      likelihood: 'medium',
      impact: 'high',
      mitigation: 'Ops lead hired at Phase 3; weekly scorecard keeps scope honest; explicit no-new-SKU rule until 5,000 subscribers.',
      owner: 'Founder',
    },
    {
      title: 'FSSAI misclassification of refill packs',
      likelihood: 'medium',
      impact: 'high',
      mitigation: 'Pre-clearance legal opinion before pilot; wellness-only claims; Kavita reviews all pack copy and labels.',
      owner: 'Regulatory',
    },
    {
      title: 'MOQ-driven cash lock in inventory',
      likelihood: 'medium',
      impact: 'medium',
      mitigation: 'Pilot capped at 500 kits; staggered refill POs; no PO larger than 6 weeks of forecast demand.',
      owner: 'Finance',
    },
    {
      title: 'Quality or food-safety incident',
      likelihood: 'low',
      impact: 'high',
      mitigation: 'Batch testing on every refill lot; food-contact certification on all trays; written recall SOP before first shipment.',
      owner: 'Ops',
    },
    {
      title: 'Festival-season logistics slippage',
      likelihood: 'medium',
      impact: 'low',
      mitigation: 'Refill dispatch calendar pulled forward 10 days around Diwali; 3PL SLA with penalty clause.',
      owner: 'Ops',
    },
  ],

  charts: [
    {
      id: 'cac-by-channel',
      title: 'Projected CAC by acquisition channel',
      insight: 'Referral and creator barter acquire at less than half the cost of paid social; the ₹750 blended gate only holds if paid stays capped at 30 percent of spend.',
      kind: 'bar',
      unit: '₹',
      xLabel: 'Cost per acquired subscriber',
      series: [
        {
          name: 'CAC',
          points: [
            { label: 'Instagram paid', value: 980 },
            { label: 'Google search', value: 760 },
            { label: 'Amazon ads', value: 640 },
            { label: 'Creator barter', value: 410 },
            { label: 'Referral', value: 260 },
          ],
        },
      ],
    },
    {
      id: 'unit-economics',
      title: '12-month economics per customer: one-time vs subscription',
      insight: 'The subscription earns about 27 percent more 12-month contribution per customer, but the gap exists only because retention is assumed to average 5.2 months.',
      kind: 'bar',
      unit: '₹',
      yLabel: 'Per customer, months 1-12',
      series: [
        {
          name: 'One-time kit ₹2,999',
          points: [
            { label: 'Revenue', value: 2999 },
            { label: 'COGS', value: 1130 },
            { label: 'CAC', value: 620 },
            { label: 'Contribution', value: 1249 },
          ],
        },
        {
          name: 'Kit + refills ₹1,499 + ₹499',
          points: [
            { label: 'Revenue', value: 4094 },
            { label: 'COGS', value: 1890 },
            { label: 'CAC', value: 620 },
            { label: 'Contribution', value: 1584 },
          ],
        },
      ],
    },
    {
      id: 'refill-retention',
      title: 'Modeled refill retention by cohort month',
      insight: 'Behavioral nudges are modeled to be worth roughly 15 points of retention by month 6; without them the cohort halves before month 4 and the gate is unreachable.',
      kind: 'line',
      unit: '%',
      xLabel: 'Months since first kit',
      yLabel: 'Cohort still subscribed',
      series: [
        {
          name: 'Base case',
          points: [
            { label: 'M1', value: 78 },
            { label: 'M2', value: 64 },
            { label: 'M3', value: 55 },
            { label: 'M4', value: 48 },
            { label: 'M5', value: 43 },
            { label: 'M6', value: 39 },
            { label: 'M7', value: 36 },
            { label: 'M8', value: 34 },
            { label: 'M9', value: 32 },
          ],
        },
        {
          name: 'With nudges',
          color: '#22c55e',
          points: [
            { label: 'M1', value: 86 },
            { label: 'M2', value: 74 },
            { label: 'M3', value: 66 },
            { label: 'M4', value: 61 },
            { label: 'M5', value: 57 },
            { label: 'M6', value: 54 },
            { label: 'M7', value: 51 },
            { label: 'M8', value: 49 },
            { label: 'M9', value: 47 },
          ],
        },
      ],
    },
    {
      id: 'cost-structure',
      title: 'Where the ₹1,499 starter kit goes',
      insight: 'Hardware is only 26 percent of the kit price; fulfilment, COD and returns quietly consume ₹255, which is why the kit alone can never be the profit engine.',
      kind: 'donut',
      unit: '₹',
      series: [
        {
          name: 'Kit price breakdown',
          points: [
            { label: 'Organizer hardware', value: 385 },
            { label: 'First refill pack', value: 240 },
            { label: 'Packaging and unboxing', value: 130 },
            { label: 'Fulfilment and COD', value: 165 },
            { label: 'Payments and returns', value: 90 },
            { label: 'Gross margin', value: 489 },
          ],
        },
      ],
    },
    {
      id: 'competitor-radar',
      title: 'Competitive position at launch (panel scoring)',
      insight: 'The panel cannot win on reach or trust at launch; the defensible axes are adherence tooling and community, which is exactly where the roadmap concentrates spend.',
      kind: 'radar',
      series: [
        {
          name: 'This brand (planned)',
          color: '#38bdf8',
          points: [
            { label: 'Brand trust', value: 4 },
            { label: 'Price value', value: 7 },
            { label: 'Adherence tooling', value: 9 },
            { label: 'Distribution reach', value: 3 },
            { label: 'Margin headroom', value: 7 },
            { label: 'Community', value: 8 },
          ],
        },
        {
          name: 'Amazon generics',
          points: [
            { label: 'Brand trust', value: 5 },
            { label: 'Price value', value: 9 },
            { label: 'Adherence tooling', value: 2 },
            { label: 'Distribution reach', value: 10 },
            { label: 'Margin headroom', value: 4 },
            { label: 'Community', value: 1 },
          ],
        },
        {
          name: 'Premium imports',
          points: [
            { label: 'Brand trust', value: 8 },
            { label: 'Price value', value: 4 },
            { label: 'Adherence tooling', value: 5 },
            { label: 'Distribution reach', value: 6 },
            { label: 'Margin headroom', value: 8 },
            { label: 'Community', value: 3 },
          ],
        },
      ],
    },
    {
      id: 'risk-matrix',
      title: 'Risk matrix: likelihood vs impact',
      insight: 'Both severe-quadrant risks are retention-adjacent: churn and CAC. Everything else is manageable with process; those two decide whether the business exists.',
      kind: 'matrix',
      xLabel: 'Likelihood',
      yLabel: 'Impact',
      series: [
        {
          name: 'Risks',
          points: [
            { label: 'Refill churn breaks the model', value: 7, value2: 9 },
            { label: 'CAC inflation on paid social', value: 8, value2: 7 },
            { label: 'Copycat listings at half price', value: 8, value2: 5 },
            { label: 'Meta platform dependency', value: 7, value2: 6 },
            { label: 'Single supplier concentration', value: 5, value2: 8 },
            { label: 'Founder bandwidth', value: 5, value2: 7.5 },
            { label: 'FSSAI misclassification', value: 3.5, value2: 9 },
            { label: 'MOQ cash lock', value: 5, value2: 5 },
            { label: 'Quality incident', value: 2.5, value2: 9.5 },
            { label: 'Festival logistics slippage', value: 6, value2: 3.5 },
          ],
        },
      ],
    },
  ],

  tables: [
    {
      id: 'pricing-scenarios',
      title: 'Pricing scenarios compared',
      columns: ['Model', 'Upfront', 'Monthly', '12-mo revenue / customer', 'Subscriber break-even'],
      rows: [
        ['One-time premium kit', '₹2,999', 'None', '₹2,999', 'Immediate, no tail'],
        ['Kit + refill subscription (chosen)', '₹1,499', '₹499', '₹4,094', 'Month 6'],
        ['Pure subscription, free hardware', '₹0', '₹699', '₹5,031', 'Month 9'],
        ['Kit + refills at ₹399', '₹1,499', '₹399', '₹3,574', 'Month 9'],
      ],
      note: 'Assumes blended CAC of ₹620 at pilot scale and the base-case retention curve; 12-month revenue uses 5.2 months average paid retention.',
    },
    {
      id: 'validation-gates',
      title: 'Pilot validation gates (500 units, 8 weeks)',
      columns: ['Gate', 'Metric', 'Threshold', 'Call'],
      rows: [
        ['Demand', 'Pilot sell-through', '60% in 6 weeks', 'Below: reprice or reposition before spending further'],
        ['Retention (red)', 'Day-60 refill retention', '35% or higher', '25–35%: iterate nudges, day-90 read. Below 25%: kill'],
        ['Efficiency (amber)', 'Blended CAC', '₹750 or lower', 'Above: rebalance channels, no shutdown'],
        ['Love', 'NPS at day 30', '50 or higher', 'Below 30 alongside weak retention: kill'],
        ['Operations', 'Refund and damage rate', '5% or lower', 'Above: freeze acquisition, fix packaging first'],
      ],
      note: 'Gates were accepted by Sam on the record; the weekly scorecard goes to his inbox every Monday during the pilot.',
    },
  ],

  roadmap: [
    {
      phase: 'Phase 1 - Validate',
      timeframe: 'Weeks 0–6',
      actions: [
        'Qualify certified white-label supplier; run food-contact and drop tests on 3 candidate units',
        'Lock 3 refill pack formulations with the co-packer and pass label review',
        'File trademark and design registration; FSSAI pre-clearance legal opinion',
        'Brand identity, packaging dielines, and a 30-creator shortlist',
        'Build a 1,000-person waitlist through founder-led content',
      ],
      owner: 'Founder',
      dependencies: 'Supplier samples pass QA; legal opinion returns clean',
    },
    {
      phase: 'Phase 2 - Pilot',
      timeframe: 'Weeks 6–14',
      actions: [
        'Ship the 500-unit pilot at ₹1,499 + ₹499, with the ₹449 A/B cell',
        'WhatsApp nudge and streak flows v1 live from first delivery',
        'Weekly gate scorecard to Sam every Monday',
        'Qualify the second supplier in parallel',
        'Founder calls with every cancellation in the first 50',
      ],
      owner: 'Founder + Growth',
      dependencies: 'Phase 1 certifications and waitlist',
    },
    {
      phase: 'Phase 3 - Launch',
      timeframe: 'Weeks 14–26',
      actions: [
        'Scale to 2,500 subscribers on the winning price cell',
        'Open Amazon as acquisition-only; subscription upsell via insert and WhatsApp',
        'Hire the ops lead; move fulfilment to a 3PL with SLA',
        'Tooling decision on the gate readout; stand up owned community space',
      ],
      owner: 'Founder + Ops lead',
      dependencies: 'Day-60 retention gate cleared at 35 percent',
    },
    {
      phase: 'Phase 4 - Scale',
      timeframe: 'Months 6–12',
      actions: [
        'Push toward 10,000 subscribers; domestic tooling at the 10K units/month run-rate',
        'Adherence app MVP with streaks, refill tracking and household profiles',
        'Quick-commerce pilots for refill top-ups in 2 metros',
        'Optional seed raise from a position of proven retention',
      ],
      owner: 'Founder + team of 4',
      dependencies: 'Phase 3 economics hold at 2,500 subscribers',
    },
  ],

  openQuestions: [
    'How much capital beyond the ₹6 lakh pre-gate cap is actually available if the pilot clears? The panel leans bootstrap through Phase 3 and raising only from proven retention, but the number changes the Phase 4 pace.',
    'Full-time from Phase 2, or nights-and-weekends through the pilot? The panel is unanimous that Phase 3 onward cannot be run part-time; only Sam can set the date.',
    'Brand name direction: the ritual-led candidate or the clinical one? Priya leans ritual, Kavita leans clinical for claim-safety reasons, and the trademark filing is waiting on this call.',
    'Do refill packs carry third-party branded supplements or an own-label blend? Kavita leans branded-first for regulatory speed; own-label roughly doubles margin but adds a compliance track.',
    'Is Sam willing to build the adherence app in-house at Phase 4, or outsource it? Nikhil considers this the single highest-leverage product decision after the pilot.',
  ],

  moderatorNote:
    'I will say this plainly, because the report above is more polite than the room was. Sam came in asking about a beautiful box, and the panel talked him into a subscription business that happens to include one. That reframe is correct on the numbers, but it should be held with suspicion: it is also the reframe every consumer panel reaches for, because subscriptions look better in spreadsheets than they behave in kitchens.\n\nThe whole thesis stands on one number: 35 percent of pilot customers still paying for refills at day 60. Every chart in the analysis section inherits that assumption. Sameer built the model honestly and flagged it himself; the 27 percent contribution advantage evaporates at 28 percent retention and inverts below that. If the pilot comes back at 31 percent, expect a strong temptation to call it close enough. The gates exist precisely so that conversation does not happen. Hold the line or do not bother having gates.\n\nI pushed hardest on the audience. A person who buys three supplement SKUs, wants them organized, will pay ₹499 monthly for the privilege, and can be found by an ad platform at under ₹750: that is four filters multiplied together, and multiplied filters shrink markets faster than founders expect. The week-1 reach tests are not a formality. If the audience is thin, the business is a boutique, and boutiques are fine, but nobody should raise money believing otherwise.\n\nTwo dissents deserve permanent visibility. Rohan may be right that shipping catalog molds under a premium flag builds brand debt no packaging can fully hide. Nikhil may be right that we are piloting a weaker product than the thesis describes because the app comes last. Both were outvoted on capital discipline, not on merits. If the pilot misses narrowly, reread their dissents before deciding anything.\n\nWhat gives me genuine confidence is not the model. It is that Sam accepted three hard gates on the record, capped his own capital, and asked for the scorecard in his inbox. Founders who instrument their own kill switches are rare, and they are the ones I would back even when I am only 60/40 on the idea. That is where I sit: 60/40, build, and let the gate do the arguing.',
};
