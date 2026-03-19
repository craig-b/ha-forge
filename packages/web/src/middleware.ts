import { createMiddleware } from 'hono/factory';

/**
 * Ingress middleware: restricts access to HA Supervisor's ingress gateway
 * and extracts ingress headers.
 *
 * The guard checks the TCP remote address via c.env (set by @hono/node-server).
 * Port 8099 is not exposed outside the container — only the Supervisor ingress
 * gateway (172.30.32.2) can reach it.
 */
export function ingressGuard() {
  return createMiddleware(async (c, next) => {
    if (process.env.NODE_ENV !== 'development' && process.env.NODE_ENV !== 'test') {
      // c.env.incoming is set by @hono/node-server at runtime
      const socket = (c.env as Record<string, unknown>)?.incoming as
        { socket?: { remoteAddress?: string } } | undefined;
      const addr = socket?.socket?.remoteAddress ?? '';
      if (addr && !addr.includes('172.30.32.2')) {
        return c.text('Forbidden', 403);
      }
    }
    await next();
  });
}

/**
 * Custom getPath for Hono that normalizes double-slash paths from HA ingress.
 * Supervisor proxies to http://addon:port/{path} where path includes a leading
 * slash, resulting in URLs like http://addon:8099//api/files.
 */
export function getIngressPath(req: Request): string {
  const url = req.url;
  const start = url.indexOf('/', url.indexOf('://') + 3);
  const path = start === -1 ? '/' : url.slice(start, url.indexOf('?', start) === -1 ? undefined : url.indexOf('?', start));
  return path.replace(/^\/+/, '/');
}

/**
 * Extract ingress path from header and attach to context.
 */
export function ingressPath() {
  return createMiddleware(async (c, next) => {
    const basePath = c.req.header('x-ingress-path') ?? '';
    c.set('ingressPath', basePath);
    await next();
  });
}
