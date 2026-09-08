import { Command } from 'commander';
import http from 'node:http';
import chalk from 'chalk';

/**
 * Lightweight local HTTP receiver for the FlurryPORT bridge.
 *
 * Pair with `flurryport listen` in a second terminal: send a webhook to your
 * dev endpoint, `listen` claims the execution and forwards to localhost, echo
 * receives + logs it. Useful for first-time setup, demos, prototyping a flow
 * before you have a real backend, or just sanity-checking a provider's
 * payload shape.
 *
 * True echo: every incoming request header is mirrored back as
 * `X-Echo-<name>` on the response, and the full request body is returned
 * inside a JSON envelope. That round-trips every header value through the
 * persisted ReplayExecution.ResponseHeaders + ResponseBodyPreview fields,
 * so bridge-secret redaction is visible end-to-end in the UI for any custom
 * header — not just Authorization. Send a target header like
 * `X-Api-Key: $secrets.STRIPE_KEY` and the recorded response shows
 * `X-Echo-X-Api-Key: [REDACTED:STRIPE_KEY]`.
 */
/**
 * `flurryport echo <port | url>`: the positional may be a bare port or the same address the
 * listener takes (http://localhost:8765/hook). A URL supplies the port, the host to bind, and
 * the path to answer on; explicit --host / --path still win. Exported for the test.
 */
export function parseEchoAddress(arg: string): { port: number; host?: string; path?: string } | null {
  const trimmed = arg.trim();
  if (/^[0-9]+$/.test(trimmed)) {
    const port = parseInt(trimmed, 10);
    return Number.isNaN(port) ? null : { port };
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const port = url.port ? parseInt(url.port, 10) : url.protocol === 'https:' ? 443 : 80;
  const path = url.pathname && url.pathname !== '/' ? url.pathname : undefined;
  return { port, host: url.hostname, path };
}

export const echoCommand = new Command('echo')
  .description('Local HTTP receiver that 200s, logs, and mirrors every request header + body back - pair with `listen` to dogfood a bridge without a backend')
  .argument('[port]', 'Port to listen on, or the full local address the listener will forward to, e.g. http://localhost:8765/hook (default: 3000)', '3000')
  .option('--host <host>', 'Interface to bind on. Defaults to localhost (whichever of 127.0.0.1 / ::1 your OS resolver returns). Pass 127.0.0.1, ::1, 127.0.0.5, 0.0.0.0, etc. to bind a specific address.')
  .option('--path <path>', 'Only respond 200 on this path; other paths return 404. Default: respond 200 on every path.')
  .action((portArg: string, opts: { host?: string; path?: string }) => {
    const parsed = parseEchoAddress(portArg);
    const port = parsed?.port ?? NaN;
    if (!parsed || Number.isNaN(port) || port < 1 || port > 65535) {
      console.error(chalk.red(`Invalid port or address: ${portArg}`));
      process.exit(1);
    }
    // An explicit flag wins; a URL fills in what the flags left unset.
    const host = opts.host ?? parsed.host ?? 'localhost';
    const pathOpt = opts.path ?? parsed.path;
    const filterPath = pathOpt && !pathOpt.startsWith('/') ? `/${pathOpt}` : pathOpt;

    let count = 0;
    const server = http.createServer((req, res) => {
      count += 1;
      const n = count;
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const ts = new Date().toLocaleTimeString();

        // Compare just the path portion (strip query string) so `?foo=bar`
        // doesn't bust the filter.
        const [reqPath, reqQuery] = (req.url ?? '/').split('?', 2);
        const accepted = !filterPath || reqPath === filterPath;
        const statusColor = accepted ? chalk.green : chalk.yellow;
        const statusCode = accepted ? 200 : 404;

        console.log(
          `${chalk.dim(ts)} ${chalk.cyan(`#${n}`)} ${chalk.green(req.method ?? '?')} ${req.url ?? '/'} ${statusColor(`→ ${statusCode}`)} ${chalk.dim(`(${body.length} bytes)`)}`,
        );

        // Log every header that came in. Helps verify substitution worked at
        // the bridge layer (you see the resolved value on the wire here).
        for (const [name, value] of Object.entries(req.headers)) {
          const display = Array.isArray(value) ? value.join(', ') : (value ?? '');
          console.log(chalk.dim(`  ${name}: `) + display);
        }
        if (body) {
          const preview = body.length > 200 ? body.slice(0, 200) + chalk.dim('…') : body;
          console.log(chalk.dim('  body: ') + preview);
        }

        if (!accepted) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: `path ${reqPath} not configured; only ${filterPath} accepts hits` }));
          return;
        }

        // Mirror every incoming header back as X-Echo-<original-name>. The
        // X- prefix avoids colliding with response-protocol headers
        // (Content-Length, Transfer-Encoding, etc.) that Node sets itself.
        // Values land verbatim, so any resolved secret in a custom header
        // round-trips into ReplayExecution.ResponseHeaders → redaction
        // path → [REDACTED:NAME] in the UI.
        const echoedHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
        for (const [name, value] of Object.entries(req.headers)) {
          const v = Array.isArray(value) ? value.join(', ') : (value ?? '');
          echoedHeaders[`X-Echo-${name}`] = v;
        }

        res.writeHead(200, echoedHeaders);
        // Body envelope mirrors everything in structured form. Headers are
        // included verbatim a second time so the response-body redaction
        // path (ResponseBodyPreview) gets exercised too.
        res.end(JSON.stringify({
          ok: true,
          hit: n,
          method: req.method ?? '',
          path: reqPath,
          query: reqQuery ?? null,
          headers: req.headers,
          body,
          received: body.length,
        }));
      });
      req.on('error', (err) => {
        console.error(chalk.red(`  request error: ${err.message}`));
      });
    });

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        console.error(chalk.red(`${host}:${port} is already in use.`));
      } else if (err.code === 'EADDRNOTAVAIL') {
        console.error(chalk.red(`Cannot bind ${host} - no network interface has that address.`));
      } else {
        console.error(chalk.red(`Server error: ${err.message}`));
      }
      process.exit(1);
    });

    // IPv6 literals need brackets in URLs.
    const displayHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
    server.listen(port, host, () => {
      const pathBit = filterPath ? ` filtering on ${chalk.cyan(filterPath)}` : '';
      console.log(chalk.green(`Echo server listening on http://${displayHost}:${port}${pathBit}`));
      console.log(chalk.dim('Every matching request gets 200 + full mirror of headers and body. Press Ctrl+C to stop.'));
    });

    const shutdown = () => {
      console.log(chalk.dim('\nShutting down...'));
      server.close(() => process.exit(0));
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
