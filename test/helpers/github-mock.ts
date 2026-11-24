import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface GithubMock {
  /** http base URL, no trailing slash (what the Worker gets as GITHUB_API_BASE). */
  url: string;
  /** Register a user; returns a fake token that GET /user accepts. */
  addUser(login: string): string;
  stop(): Promise<void>;
}

type Handler = (req: IncomingMessage, res: ServerResponse, users: Map<string, string>) => void;

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Route table keyed by "METHOD /path". Add the device-flow endpoints here later. */
const routes: Record<string, Handler> = {
  "GET /user": (req, res, users) => {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? "");
    const login = m ? users.get(m[1]) : undefined;
    if (!login) return json(res, 401, { message: "Bad credentials" });
    json(res, 200, { login });
  },
};

export async function startGithubMock(): Promise<GithubMock> {
  const users = new Map<string, string>();
  const sockets = new Set<import("node:net").Socket>();
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    const handler = routes[`${req.method} ${path}`];
    if (!handler) return json(res, 404, { message: "Not Found" });
    handler(req, res, users);
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    addUser(login) {
      const token = `gho_test_${randomBytes(16).toString("hex")}`;
      users.set(token, login);
      return token;
    },
    stop: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
