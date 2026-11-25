import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { unstable_startWorker as startWorker } from "wrangler";
import { startGithubMock, type GithubMock } from "./github-mock.js";

export type { GithubMock };

export interface TestRelay {
  /** http base URL of the real Worker, no trailing slash. */
  url: string;
  /** ws base URL, no trailing slash. */
  wsUrl: string;
  github: GithubMock;
  stop(): Promise<void>;
}

const WORKER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "relay-worker");
export const TEST_TOKEN_SIGNING_KEY = "00".repeat(32);

export interface TestRelayOptions {
  /** wrangler config to run instead of relay-worker/wrangler.jsonc (e.g. a legacy-schema fixture). */
  config?: string;
  /** Durable Object storage directory to use, and keep on stop() (the caller removes it). */
  persist?: string;
  /** Extra plain-text bindings for this run only. */
  vars?: Record<string, string>;
}

/**
 * Runs relay-worker/src/index.ts locally (workerd via wrangler's unstable_startWorker) with the
 * GitHub API pointed at an in-process mock. Local only: nothing remote, nothing deployed.
 * Each call gets its own Durable Object storage directory, removed on stop(), unless `persist` is given.
 */
export async function startTestRelay(opts: TestRelayOptions = {}): Promise<TestRelay> {
  const github = await startGithubMock();
  const persist = opts.persist ?? (await mkdtemp(join(tmpdir(), "mindmeld-relay-test-")));
  const cleanup = () => (opts.persist ? Promise.resolve() : rm(persist, { recursive: true, force: true }));
  let worker: Awaited<ReturnType<typeof startWorker>> | undefined;
  try {
    worker = await startWorker({
      config: opts.config ?? join(WORKER_DIR, "wrangler.jsonc"),
      bindings: {
        GITHUB_API_BASE: { type: "plain_text", value: github.url },
        TOKEN_SIGNING_KEY: { type: "plain_text", value: TEST_TOKEN_SIGNING_KEY },
        ...Object.fromEntries(Object.entries(opts.vars ?? {}).map(([k, value]) => [k, { type: "plain_text", value }])),
      },
      dev: {
        remote: false,
        persist,
        inspector: false,
        server: { hostname: "127.0.0.1", port: 0 },
        logLevel: "error",
      },
    } as Parameters<typeof startWorker>[0]);
    await worker.ready;
    const u = await worker.url;
    const url = `http://${u.host}`;
    return {
      url,
      wsUrl: `ws://${u.host}`,
      github,
      stop: async () => {
        await worker!.dispose();
        await github.stop();
        await cleanup();
      },
    };
  } catch (err) {
    await worker?.dispose().catch(() => {});
    await github.stop();
    await cleanup();
    throw err;
  }
}
