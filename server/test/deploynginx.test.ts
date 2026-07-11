import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CONF = readFileSync(
  fileURLToPath(new URL('../../deploy/nginx.conf', import.meta.url)),
  'utf8',
);

/**
 * Directives nginx accepts only in the `http { ... }` context. The shipped file is written to
 * be included from there (`/etc/nginx/conf.d/*.conf`), so its own top level *is* that context
 * and these are legal at column zero — and nowhere deeper. One written inside a `server` or a
 * `location` is not a warning or a no-op: nginx refuses the whole configuration with
 * "directive is not allowed here" and does not start.
 */
const HTTP_ONLY = ['log_format', 'map', 'upstream', 'server'];

interface Directive {
  name: string;
  args: string;
  /** The enclosing blocks, outermost first. Empty means the file's top level: the http context. */
  context: string[];
  commented: boolean;
}

/**
 * Every directive the file ships, live or offered commented-out, with the block it sits in.
 *
 * A commented example is guidance the operator uncomments verbatim, so it has to be legal
 * where it is written — which is the whole of what this file gets wrong when it gets it wrong.
 * As in the systemd unit, the two kinds of comment are told apart by the space: a commented-out
 * *directive* is written flush against the `#` (`#access_log …`), prose gets a space (`# nginx
 * refuses …`), so a sentence that happens to open with a directive's name is not mistaken for
 * one, and uncommenting stays a one-character edit.
 */
function directives(): Directive[] {
  const found: Directive[] = [];
  const context: string[] = [];

  for (const raw of CONF.split('\n')) {
    const line = raw.trim();
    const match = /^(#?)([a-z_]+)(\s.*)?$/.exec(line);
    if (match) {
      const [, hash, name, rest = ''] = match;
      found.push({
        name,
        args: rest.trim(),
        context: [...context],
        commented: hash === '#',
      });
      // Only a live block opens a context; a commented one is inert text.
      if (hash === '' && line.endsWith('{')) context.push(name);
    } else if (line === '}') {
      context.pop();
    }
  }

  return found;
}

describe('the shipped nginx config', () => {
  it('keeps every http-context directive out of a server or location block', () => {
    // The trap this exists to hold shut: the `?auth=` token rides in the URL, so the file
    // offers a log format that writes the path without the query string — the one remedy it
    // gives for keeping a token out of the proxy's access log. Written where it is used, in
    // `location /`, that offer takes the proxy down: `log_format` is an http-context directive,
    // so nginx answers `[emerg] "log_format" directive is not allowed here` and refuses to
    // start. An operator acting on a token-in-the-log warning loses the whole proxy. The pair
    // has to be split — the format defined at the top level, the `access_log` that names it in
    // the location — and a commented directive is checked like a live one, because it is
    // written to be uncommented as it stands.
    const misplaced = directives().filter(
      (d) => HTTP_ONLY.includes(d.name) && d.context.length > 0,
    );
    expect(misplaced).toEqual([]);
  });

  it('defines every log format it selects, and selects the one it defines', () => {
    // The other half of the split: `access_log … no_query` uncommented on its own names a
    // format nginx has never heard of (`[emerg] unknown log format "no_query"`) — the same
    // dead proxy by a different message. The two lines are only correct together, so neither
    // may drift out of the file without the other.
    const all = directives();
    const defined = all
      .filter((d) => d.name === 'log_format')
      .map((d) => d.args.split(/\s+/)[0]);
    const selected = all
      .filter((d) => d.name === 'access_log')
      .map((d) => d.args.replace(/;$/, '').split(/\s+/).pop())
      .filter((format) => format !== undefined && format !== 'off');

    expect(defined.length).toBeGreaterThan(0);
    expect(selected.length).toBeGreaterThan(0);
    for (const format of selected) expect(defined).toContain(format);
  });

  it('places the access_log that keeps the token out of the log where it applies', () => {
    // `access_log` is legal in http, server and location alike, but it has to reach the routes
    // whose URL carries the token, and it is inherited only downward. In the location the
    // proxy_pass lives in, it covers exactly them.
    const accessLog = directives().find((d) => d.name === 'access_log');
    expect(accessLog?.context.at(-1)).toBe('location');
  });
});
