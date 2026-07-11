import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const UNIT = readFileSync(
  fileURLToPath(new URL('../../deploy/commlink-server.service', import.meta.url)),
  'utf8',
);

/**
 * Every `Key=value` the unit ships, whether it is live or offered commented-out for the
 * operator to uncomment. A commented example is guidance the operator acts on verbatim, so
 * it has to hold up to the same rules as a live line.
 *
 * The file distinguishes the two kinds of comment by the space systemd itself ignores: a
 * commented-out *directive* is written `#Key=value`, flush against the `#` so uncommenting
 * is a one-character edit, while prose is `# a sentence`. So a line is a directive here
 * only if it is uncommented, or commented with nothing between the `#` and the key —
 * otherwise a sentence that happens to open with `User=…` would read as one.
 */
function directives(): { key: string; value: string; commented: boolean }[] {
  return UNIT.split('\n')
    .map((line) => {
      const match = /^(#?)([A-Za-z]+)=(.*)$/.exec(line.trim());
      return match
        ? { key: match[2], value: match[3], commented: match[1] === '#' }
        : undefined;
    })
    .filter((d) => d !== undefined);
}

describe('the shipped systemd unit', () => {
  it('never resolves a path through %h, which does not follow User=', () => {
    // %h is the home of the service *manager*, not of the account in User= — systemd's
    // manual says it "is not influenced by the User= setting". Under `systemctl --user`
    // the manager is the operator, so %h is their home and looks account-scoped; under the
    // system manager it is /root no matter what User= says. A system unit carrying
    // `WorkingDirectory=%h/commlink/server` and `User=commlink` therefore chases the
    // checkout into /root — where it is not, and which an unprivileged account cannot enter
    // — and dies on CHDIR before running any of the server. Absolute paths hold under
    // either manager, so the unit uses them and this keeps %h from creeping back in.
    const usingHome = directives().filter((d) => d.value.includes('%h'));
    expect(usingHome).toEqual([]);
  });

  it('gives WorkingDirectory an absolute path', () => {
    // The one directive whose breakage is the CHDIR above. Absolute is the only form that
    // means the same thing to both managers and to any User=.
    const workdir = directives().find((d) => d.key === 'WorkingDirectory');
    expect(workdir).toBeDefined();
    expect(workdir?.commented).toBe(false);
    expect(workdir?.value.startsWith('/')).toBe(true);
  });

  it('only reaches for %S alongside the StateDirectory that creates it', () => {
    // %S is manager-scoped exactly as %h is (/var/lib for a system unit, ~/.local/state for
    // a user one), but that is the right state root in each case rather than the wrong home,
    // so it stays. It is only meaningful because StateDirectory= creates the directory and
    // owns its permissions: DB_PATH pointing into %S with no StateDirectory would name a
    // path nothing creates, and SQLite does not create a missing parent.
    const all = directives();
    const usingState = all.filter((d) => d.value.includes('%S'));
    expect(usingState.length).toBeGreaterThan(0);
    expect(all.some((d) => d.key === 'StateDirectory' && !d.commented)).toBe(true);
  });
});
