

export interface DeepSeekChatShimOptions {

  port?: number;
  upstreamBaseUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface DeepSeekChatShim {
  port: number;
  stop(): void;
}


export function rewriteChatBody(raw: string): string {
  try {
    const body = JSON.parse(raw);
    if (body && typeof body === 'object' && Array.isArray(body.messages)) {
      for (const m of body.messages) {
        if (m && typeof m === 'object' && m.role === 'developer') m.role = 'system';
      }
      return JSON.stringify(body);
    }
    return raw;
  } catch {
    return raw;
  }
}

export function startDeepSeekChatShim(opts: DeepSeekChatShimOptions = {}): DeepSeekChatShim {
  const upstream = (opts.upstreamBaseUrl ?? process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com')
    .replace(/\/$/, '')
    .replace(/\/v1$/, '');
  const fetchImpl = opts.fetchImpl ?? fetch;

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: opts.port ?? 3979,
    async fetch(req) {
      const url = new URL(req.url);

      const path = url.pathname.replace(/^\/v1/, '');
      const forwardHeaders = new Headers();
      const auth = req.headers.get('authorization');
      if (auth) forwardHeaders.set('authorization', auth);
      forwardHeaders.set('content-type', 'application/json');

      const init: RequestInit = { method: req.method, headers: forwardHeaders };
      if (req.method === 'POST') {
        init.body = rewriteChatBody(await req.text());
      }
      const res = await fetchImpl(`${upstream}${path}${url.search}`, init);

      return new Response(res.body, { status: res.status, headers: res.headers });
    },
  });

  return {
    port: server.port ?? 0,
    stop: () => server.stop(true),
  };
}
