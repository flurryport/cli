import { createServer, type Server } from 'node:http';

/**
 * In-process echo receiver for the MCP `start_echo_server` tool (agent feedback, 0.2.3):
 * the "prove the replay loop without a backend" moment, without making the agent
 * daemonize `flurryport echo` in its shell. Loopback-only, answers 200 and mirrors
 * headers + body back (so forward_to_localhost's responseBodyPreview SHOWS the echo),
 * lives and dies with the MCP process. Idempotent: repeat calls return the running
 * instance instead of failing on a busy port.
 */

export interface EchoServerInfo {
  localUrl: string;
  port: number;
  status: 'started' | 'already_running';
  requestsReceived: number;
}

const DEFAULT_PORT = 4242;

let server: Server | null = null;
let boundPort = 0;
let received = 0;

/** The running echo URL, or null — lets forward results recognize an echo delivery. */
export function currentEchoUrl(): string | null {
  return server && boundPort > 0 ? `http://127.0.0.1:${boundPort}/` : null;
}

export async function ensureEchoServer(requestedPort?: number): Promise<EchoServerInfo> {
  if (server && boundPort > 0 && (requestedPort === undefined || requestedPort === boundPort)) {
    return { localUrl: `http://127.0.0.1:${boundPort}/`, port: boundPort, status: 'already_running', requestsReceived: received };
  }

  const echo = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      received++;
      const body = Buffer.concat(chunks);
      const mirrored = {
        echo: true,
        method: req.method,
        path: req.url,
        headers: req.headers,
        bodyLength: body.length,
        body: body.toString('utf8').slice(0, 2048),
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(mirrored));
    });
  });

  const port = await new Promise<number>((resolve, reject) => {
    echo.once('error', (err: NodeJS.ErrnoException) => {
      // Requested port busy (someone else's process): fall back to an ephemeral port
      // instead of failing — the URL in the response is what matters, not the number.
      if (err.code === 'EADDRINUSE') {
        echo.removeAllListeners('error');
        echo.once('error', reject);
        echo.listen(0, '127.0.0.1', () => resolve((echo.address() as { port: number }).port));
      } else {
        reject(err);
      }
    });
    echo.listen(requestedPort ?? DEFAULT_PORT, '127.0.0.1', () =>
      resolve((echo.address() as { port: number }).port));
  });

  // Never hold the process open for the echo listener — stdio closing ends the CLI.
  echo.unref?.();
  server?.close();
  server = echo;
  boundPort = port;
  received = 0;

  return { localUrl: `http://127.0.0.1:${port}/`, port, status: 'started', requestsReceived: 0 };
}
