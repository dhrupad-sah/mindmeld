import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** One scripted answer to a device-flow poll: an OAuth error code, or the granted token. */
export type DevicePollStep = "authorization_pending" | "slow_down" | "expired_token" | "access_denied" | { token: string };

export interface DeviceFlowScript {
  /** Poll interval (seconds) returned by POST /login/device/code. Default 5. */
  interval?: number;
  userCode?: string;
  /** Answers to successive polls; the last one repeats once the script runs out. */
  steps: DevicePollStep[];
}

export interface GithubMock {
  /** http base URL, no trailing slash (what the Worker gets as GITHUB_API_BASE). */
  url: string;
  /**
   * Register a user; returns a fake token that GET /user accepts. Each call gets a fresh numeric id,
   * unless `id` is given: reusing an id with a new login is that account renamed.
   */
  addUser(login: string, id?: number): string;
  /** Script the device flow (POST /login/device/code and POST /login/oauth/access_token). */
  setDeviceFlow(script: DeviceFlowScript): void;
  /** Number of polls of POST /login/oauth/access_token since the last setDeviceFlow. */
  devicePolls(): number;
  stop(): Promise<void>;
}

interface State {
  users: Map<string, { login: string; id: number }>;
  device: DeviceFlowScript | null;
  deviceCode: string | null;
  polls: number;
}

type Handler = (req: IncomingMessage, res: ServerResponse, state: State, body: URLSearchParams) => void;

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Route table keyed by "METHOD /path". */
const routes: Record<string, Handler> = {
  "GET /user": (req, res, { users }) => {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? "");
    const user = m ? users.get(m[1]) : undefined;
    if (!user) return json(res, 401, { message: "Bad credentials" });
    json(res, 200, { login: user.login, id: user.id });
  },
  "POST /login/device/code": (_req, res, state, body) => {
    if (!state.device || !body.get("client_id")) return json(res, 200, { error: "unauthorized_client" });
    state.deviceCode = randomBytes(20).toString("hex");
    state.polls = 0;
    json(res, 200, {
      device_code: state.deviceCode,
      user_code: state.device.userCode ?? "WDJB-MJHT",
      verification_uri: "https://github.com/login/device",
      expires_in: 900,
      interval: state.device.interval ?? 5,
    });
  },
  "POST /login/oauth/access_token": (_req, res, state, body) => {
    // GitHub answers device-flow errors with 200 and an `error` field.
    if (!state.device || body.get("device_code") !== state.deviceCode) return json(res, 200, { error: "incorrect_device_code" });
    if (body.get("grant_type") !== "urn:ietf:params:oauth:grant-type:device_code") return json(res, 200, { error: "unsupported_grant_type" });
    const steps = state.device.steps;
    const step = steps[Math.min(state.polls, steps.length - 1)];
    state.polls++;
    if (typeof step === "string") return json(res, 200, { error: step });
    json(res, 200, { access_token: step.token, token_type: "bearer", scope: "" });
  },
};

export async function startGithubMock(): Promise<GithubMock> {
  const state: State = { users: new Map(), device: null, deviceCode: null, polls: 0 };
  let nextId = 1000;
  const sockets = new Set<import("node:net").Socket>();
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const path = (req.url ?? "").split("?")[0];
      const handler = routes[`${req.method} ${path}`];
      if (!handler) return json(res, 404, { message: "Not Found" });
      handler(req, res, state, new URLSearchParams(Buffer.concat(chunks).toString("utf8")));
    });
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    addUser(login, id) {
      const token = `gho_test_${randomBytes(16).toString("hex")}`;
      state.users.set(token, { login, id: id ?? nextId++ });
      return token;
    },
    setDeviceFlow(script) {
      state.device = script;
      state.deviceCode = null;
      state.polls = 0;
    },
    devicePolls: () => state.polls,
    stop: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
