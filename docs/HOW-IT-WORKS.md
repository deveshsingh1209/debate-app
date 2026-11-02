# How it works, in plain language

No technical knowledge needed. For the engineering view see [ARCHITECTURE.md](ARCHITECTURE.md).

## The idea

Hard decisions go wrong when only one voice is heard. The app puts several voices in a room, makes them disagree with evidence, and makes someone rule. You get the decision plus the argument behind it, including the best objections, so you can see where you might be wrong.

## Who is in the room

- **Marcus**, the chair. He runs the meeting, keeps it on topic, asks you questions and writes the rulings.
- **The experts.** Named people the app invents to fit your topic: say a finance lead, an operations expert and a sceptic. Each has their own background, bias and private opinion, and they do not share a mind. They disagree for real, and they can change their position when the evidence moves them.
- **A referee** who checks after each round whether anything *new* was said, so the room does not go in circles.
- **The adversary desk**, whose only job is to attack each ruling and the final report before you see it.
- **Researchers** who look things up on the web and bring back sources.
- **A number cruncher**, when you attach spreadsheets (Claude only): it measures instead of guessing.

## What happens, in order

1. **Intake.** You write the topic. The chair checks it is clear, and asks you if not. It then states the goal and how big the debate should be. You approve.
2. **Panel.** The experts are designed for your topic. You approve or change them.
3. **Agenda.** The questions to settle ("motions"). You approve or change them. Research starts in the background.
4. **The meeting.** Each motion is argued like a working meeting. Nobody waits in a queue: whoever was put on the spot answers, two people in a real fight trade short turns, someone with a case to make gets the floor for longer, and a listener who cannot let a point stand cuts in, sometimes over the speaker's last words. Marcus, the chair, speaks only when the room needs him. Every few turns the referee asks: was it new and substantive? When the argument is settled, anyone the decision turns on who has not spoken is asked for their view, and Marcus rules. The adversary desk attacks the ruling. Marcus may ask you something along the way; the room waits.
5. **Wrap-up.** Closing statements, a written report that is attacked once more and corrected, and a saved copy in your library.

## You stay in control

Nothing important happens without your approval: goal, panel and agenda each wait for a yes. You can ask for changes, switch to "autonomous" so the room assumes instead of asking, pause, or end the debate early (open questions then get ruled and you still get the report).

## What stays on your computer

Everything the app keeps (debates, files, reports, a log of every step) lives in the `data` folder next to the app. The only thing that leaves your computer is the text sent to the AI you chose, using your own account or key. There is no account with us, no analytics and no copy of your debates anywhere else.

## Why debates are long and what they cost

Many separate AI calls take turns: speaking, researching, refereeing, ruling, attacking, checking. That is the point of the app, so it favours quality over speed and cost. It does not stop a debate because it got expensive. You can set a spending ceiling if you want one; at the ceiling the room pauses and asks. The app does avoid waste: it will not repeat an identical call or keep arguing a point where the room is only repeating itself.

If your AI allowance runs out, the debate pauses and continues by itself when it returns.

## Why it survives closing the tab

The app writes down every event as it happens, in order. The screen you see is rebuilt from that record, so closing the browser or restarting the app loses at most the sentence being written, which is redone.

## Which AI does the work

You connect one of four things: **Claude: sign in**, **Claude: API key**, **ChatGPT: Codex sign-in** or **OpenAI: API key**. One debate uses one provider from start to finish. You never choose a model: the app gives the hardest jobs (chairing, arguing, ruling) to the provider's strongest model, and routine jobs (looking things up, tidying wording) to a lighter one. See [CONNECT-YOUR-AI.md](CONNECT-YOUR-AI.md).

## What it cannot do

- It is not an oracle. The experts are AI and can be wrong, and the web research can be wrong or thin. Read the objections as well as the ruling.
- It does not know your private facts unless you tell it or attach them.
- It is for one person on one computer, not a shared service.
