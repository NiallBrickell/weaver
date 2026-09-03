import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { rewriteLoopbackHostsForContainer } from './openHands.js';

describe('rewriteLoopbackHostsForContainer', () => {
  it('rewrites a loopback DB URL to host.docker.internal, preserving userinfo, port and query', () => {
    const out = rewriteLoopbackHostsForContainer({
      PG_READONLY_URI:
        'postgresql://claude_code:p%40ss-w0rd@127.0.0.1:55432/postgres?sslmode=disable',
    });
    assert.equal(
      out.PG_READONLY_URI,
      'postgresql://claude_code:p%40ss-w0rd@host.docker.internal:55432/postgres?sslmode=disable',
    );
  });

  it('handles localhost and [::1] hosts, with and without userinfo', () => {
    const out = rewriteLoopbackHostsForContainer({
      A: 'clickhouse://localhost:8443/default',
      B: 'https://user:tok@localhost/health',
      C: 'redis://[::1]:6379/0',
    });
    assert.equal(out.A, 'clickhouse://host.docker.internal:8443/default');
    assert.equal(out.B, 'https://user:tok@host.docker.internal/health');
    assert.equal(out.C, 'redis://host.docker.internal:6379/0');
  });

  it('leaves URLs whose host is already routable untouched', () => {
    const uri = 'postgresql://u:p@thomas.proxy.rlwy.net:41456/railway?sslmode=require';
    assert.equal(rewriteLoopbackHostsForContainer({ X: uri }).X, uri);
  });

  it('does not touch a non-URL value that merely contains a loopback literal', () => {
    // A bare token, or a value where 127.0.0.1 is not the URL host, must survive
    // verbatim — the rewrite is anchored to scheme://[userinfo@]<loopback>.
    const env = {
      TOKEN: 'not-a-url-127.0.0.1-suffix',
      ALLOWLIST: 'https://api.example.com/?redirect=127.0.0.1',
    };
    const out = rewriteLoopbackHostsForContainer(env);
    assert.equal(out.TOKEN, env.TOKEN);
    assert.equal(out.ALLOWLIST, env.ALLOWLIST);
  });

  it('rewrites only the host token, never a loopback literal elsewhere in the URL path', () => {
    const uri = 'postgresql://u:p@127.0.0.1:5432/db-127.0.0.1';
    assert.equal(
      rewriteLoopbackHostsForContainer({ X: uri }).X,
      'postgresql://u:p@host.docker.internal:5432/db-127.0.0.1',
    );
  });
});
