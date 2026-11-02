/** A tiny assertion counter shared by the realism selftests (same output style as director.selftest.ts). */
export function suite(title: string) {
  let passes = 0;
  let fails = 0;
  console.log(`\n== ${title}`);
  return {
    section: (name: string) => console.log(`[${name}]`),
    ok(name: string, cond: boolean, detail: unknown = '') {
      if (cond) passes++;
      else fails++;
      const d = typeof detail === 'string' ? detail : JSON.stringify(detail);
      console.log(`${cond ? '  ok  ' : '  FAIL'}  ${name}${cond ? '' : `  <- ${d}`}`);
    },
    /** Print the tally and return the failure count. */
    done(): number {
      console.log(`${title}: ${passes} passed, ${fails} failed`);
      return fails;
    },
  };
}
