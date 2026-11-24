import { GITHUB_DEVICE_SCOPE } from "./config.js";

/** Options for {@link deviceFlowLogin}. */
export interface DeviceFlowOptions {
  /** GitHub App client id (public). */
  clientId: string;
  /** Show the user the code to enter at `verificationUri`. */
  onCode(userCode: string, verificationUri: string): void;
  fetchImpl?: typeof fetch;
  /** Where the device-flow endpoints live. Default https://github.com. */
  githubBase?: string;
}

const GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function postForm(f: typeof fetch, url: string, form: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await f(url, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!body || typeof body !== "object") throw new Error(`GitHub sign-in failed (HTTP ${res.status})`);
  return body as Record<string, unknown>;
}

/**
 * GitHub OAuth device flow: get a user code, hand it to `onCode`, then poll until the user approves.
 * Honours the server's `interval` and adds 5 s on every `slow_down`. Resolves with the GitHub token,
 * which the caller should exchange right away and not keep.
 */
export async function deviceFlowLogin(opts: DeviceFlowOptions): Promise<string> {
  const f = opts.fetchImpl ?? fetch;
  const base = (opts.githubBase ?? "https://github.com").replace(/\/+$/, "");
  const start = await postForm(f, `${base}/login/device/code`, { client_id: opts.clientId, scope: GITHUB_DEVICE_SCOPE });
  if (typeof start.error === "string") throw new Error(`GitHub sign-in failed: ${start.error_description ?? start.error}`);
  const { device_code, user_code, verification_uri, expires_in, interval } = start;
  if (typeof device_code !== "string" || typeof user_code !== "string" || typeof verification_uri !== "string") {
    throw new Error("GitHub sign-in failed: unexpected device-code response");
  }
  let waitSeconds = typeof interval === "number" && interval >= 0 ? interval : 5;
  const deadline = Date.now() + (typeof expires_in === "number" && expires_in > 0 ? expires_in : 900) * 1000;
  opts.onCode(user_code, verification_uri);

  for (;;) {
    await sleep(waitSeconds * 1000);
    if (Date.now() > deadline) throw new Error("GitHub sign-in code expired; run the login again");
    const r = await postForm(f, `${base}/login/oauth/access_token`, { client_id: opts.clientId, device_code, grant_type: GRANT_TYPE });
    if (typeof r.access_token === "string" && r.access_token) return r.access_token;
    switch (r.error) {
      case "authorization_pending":
        continue;
      case "slow_down":
        waitSeconds = Math.max(waitSeconds + 5, typeof r.interval === "number" ? r.interval : 0);
        continue;
      case "expired_token":
        throw new Error("GitHub sign-in code expired; run the login again");
      case "access_denied":
        throw new Error("GitHub sign-in was denied");
      default:
        throw new Error(`GitHub sign-in failed: ${r.error_description ?? r.error ?? "no token in response"}`);
    }
  }
}
