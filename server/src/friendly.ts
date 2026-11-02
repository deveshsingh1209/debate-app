/**
 * Turn an engine failure into one plain sentence for the room. The raw error
 * goes to the server terminal; the browser never sees a stack trace, a file
 * path or a request body.
 */
export function friendlyError(err: unknown): string {
  const raw = err instanceof Error ? `${err.name} ${err.message} ${(err as { code?: string }).code ?? ''}` : String(err);
  const t = raw.toLowerCase();
  const saved = 'Everything decided so far is saved.';

  if (/enoent|spawn .*claude|claude(?: code)? (?:cli )?(?:executable )?not found|could not find .*claude/.test(t)) {
    return `The Claude Code program was not found on this machine. Install it with \`npm install -g @anthropic-ai/claude-code\`, run \`claude\` once to sign in, then restart. \`npm run doctor\` checks the setup. ${saved}`;
  }
  if (/anthropic_api_key|x-api-key|credit balance is too low|claude api key/.test(t)) {
    return `The Claude API key is missing or was refused. Check ANTHROPIC_API_KEY in .env and its credit in the Anthropic Console, press Re-check on the Connect screen, then reopen this debate. ${saved}`;
  }
  if (/not logged in|please run \/login|invalid api key|authentication_error|oauth token|claude ai usage limit.*login|\b401\b/.test(t)) {
    return `Claude is not signed in, or the sign-in expired. Run \`claude\` in a terminal and sign in, then reopen this debate. ${saved}`;
  }
  if (/openai_api_key|incorrect api key|invalid_api_key/.test(t)) {
    return `The OpenAI key is missing or was refused. Set OPENAI_API_KEY in .env, press Re-check on the Connect screen, and reopen this debate. ${saved}`;
  }
  if (/codex.*(?:login|auth)|auth\.json/.test(t)) {
    return `The ChatGPT (Codex) sign-in is missing or expired. Run \`codex login\`, then reopen this debate. ${saved}`;
  }
  if (/process exited with code|exited with code|sigabrt|sigkill|signal/.test(t)) {
    return `The AI program stopped unexpectedly. Check that it is installed and signed in (\`npm run doctor\`), then reopen this debate. ${saved}`;
  }
  if (/enotfound|econnrefused|econnreset|etimedout|fetch failed|network|socket hang up|eai_again/.test(t)) {
    return `Could not reach the AI provider. Check your internet connection, then reopen this debate. ${saved}`;
  }
  if (/enospc|no space left/.test(t)) {
    return `The disk is full, so the debate could not be saved. Free some space, then reopen this debate.`;
  }
  if (/eacces|eperm|readonly database|sqlite|cannot open database/.test(t)) {
    return `The data folder could not be written. Check its permissions (\`npm run doctor\` shows where it is), then restart. ${saved}`;
  }
  return `Something went wrong while running this debate. ${saved} Reopen it to continue; the details are in the terminal where the app is running.`;
}
