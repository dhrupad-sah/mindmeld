import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadSession, type Session } from "./auth/session.js";
import type { Channel } from "./channel.js";
import { DEFAULT_RELAY, relayWarning, saveConfig, teamRelay, withTeam, type Config } from "./config.js";
import { loadOrCreateIdentity } from "./identity.js";
import {
  acceptInvite,
  addDevice,
  createTeam,
  deleteMember,
  formatTeam,
  getRoster,
  inviteMember,
  inviteMessage,
  invitedByText,
  listTeams,
  normLogin,
  planAccept,
  removeAndRotate,
  revokeInvite,
  setRole,
  signIn,
  signInLine,
  signInState,
  SIGNED_IN_EXPIRED,
  teamLine,
  type TeamEntry,
} from "./teamapi.js";
import { SIGN_IN_EXPIRED, TeamChannel } from "./teamchannel.js";
import { rotate, type TeamRoster } from "./teamkeys.js";

const NO_TEAM = "You're not in a team yet. Create one with create_team, or accept an invite with accept_invite.";

/** "invite to "core" (invited by @alice)" or "team "core" (member)". */
const describeEntry = (t: TeamEntry) => (t.role === "invited" ? `invite to "${t.name}" (${invitedByText(t)})` : `team "${t.name}" (${t.role})`);

const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], isError });

/** What the team tools need from the MCP server in src/mcp.ts. */
export interface TeamHost {
  server: McpServer;
  elicit(message: string, requestedSchema: any): Promise<{ action: string }>;
  loadConfig(): Config | null;
  /** Rebuild this session's connection from the saved config (after sign-in or a team change). */
  reconnect(): void;
}

type Ready = { session: Session; config: Config | null; relay: string };
type ReadyTeam = Ready & { config: Config; team: NonNullable<Config["team"]> };

/**
 * GitHub sign-in and teams for the MCP server: registers login, create_team, invite_member,
 * revoke_invite, accept_invite, team, remove_member and set_role, and builds the TeamChannel when config.json has a
 * team. Every tool answers with sign-in guidance when the session is missing or expired.
 */
export function setupTeams(host: TeamHost) {
  const { server } = host;
  /** The current connection's TeamChannel, if this machine is in a team and signed in. */
  let channel: TeamChannel | null = null;
  /** The relay refused this channel's session token. */
  let channelExpired = false;
  let login: { gen: number; pending: boolean; error: string | null } = { gen: 0, pending: false, error: null };

  /** Signed in (and in a team when `needTeam`), or the text to answer with instead. */
  function ready(needTeam: false): Ready | string;
  function ready(needTeam: true): ReadyTeam | string;
  function ready(needTeam: boolean): Ready | ReadyTeam | string {
    const config = host.loadConfig();
    const relay = teamRelay(config);
    const s = signInState(relay);
    if (!("session" in s)) return signInLine(s);
    if (!needTeam) return { session: s.session, config, relay };
    if (!config?.team) return NO_TEAM;
    return { session: s.session, config, relay, team: config.team };
  }

  /** Run a relay call for a tool, turning a thrown error into an error result. */
  const attempt = async (f: () => Promise<ReturnType<typeof text>>) => {
    try {
      return await f();
    } catch (e) {
      return text((e as Error).message, true);
    }
  };

  /**
   * How to connect for `config`: the team channel (and the login as the name) when it has a team,
   * `{ name }` for the legacy group, or null when it has a team but nobody is signed in.
   */
  function channelFor(config: Config): { channel?: Channel; name: string } | null {
    channel = null;
    channelExpired = false;
    if (!config.team) return { name: config.name };
    const relay = teamRelay(config);
    const session = loadSession(relay);
    if (!session) return null;
    const ch = new TeamChannel({ relayHttp: relay, teamId: config.team.teamId, session, id: loadOrCreateIdentity() });
    ch.on("auth-expired", () => {
      if (channel === ch) channelExpired = true;
    });
    channel = ch;
    // A second machine for the same login: add this device (a no-op when the team already has it).
    addDevice(relay, session, config.team.teamId).catch(() => {});
    return { channel: ch, name: session.login };
  }

  /** Why the team connection can't be used right now (sign-in or channel trouble); null if fine or not in a team. */
  function blocker(): string | null {
    const config = host.loadConfig();
    if (!config?.team) return null;
    const s = signInState(teamRelay(config));
    if (!("session" in s)) return signInLine(s);
    if (channelExpired) return SIGNED_IN_EXPIRED;
    if (channel && !channel.connected && channel.status) return `Not connected to team "${config.team.name}": ${channel.status}`;
    return null;
  }

  /** Lines for the status tool: sign-in, team and role, and the team connection's problem if any. */
  async function statusLines(config: Config | null): Promise<string[]> {
    const relayUrl = teamRelay(config);
    const s = signInState(relayUrl);
    let signedIn = signInLine(s);
    const lines: string[] = [];
    let teamText: string | null = null;
    if (config?.team) {
      let roster: TeamRoster | null = null;
      let failed = "";
      if ("session" in s && !channelExpired) {
        try {
          roster = await getRoster(relayUrl, s.session, config.team.teamId, 3000);
        } catch (e) {
          if ((e as { status?: number }).status === 401) channelExpired = true;
          else failed = ` (couldn't load the roster: ${(e as Error).message})`;
        }
      }
      if (channelExpired) signedIn = SIGNED_IN_EXPIRED;
      teamText = teamLine(config.team.name, roster, "session" in s ? s.session.uid : null) + failed;
    }
    // The relay in use: the legacy group's when only a group is set, else the team relay.
    const relay = relayWarning(config?.secret && !config.team ? config.relay : relayUrl);
    if (relay) lines.push(relay);
    lines.push(signedIn);
    if (login.pending && !("session" in s)) lines.push("Sign-in in progress: waiting for the code to be entered on GitHub");
    if (login.error) lines.push(`Last sign-in attempt failed: ${login.error}`);
    if (teamText) lines.push(teamText);
    const why = config?.team ? channel?.status : null;
    if (why && why !== SIGN_IN_EXPIRED) lines.push(`Team connection: ${why}`);
    return lines;
  }

  /** What the config watcher compares: a change means reconnect. Includes the session for a team. */
  const watchKey = (c: Config | null) =>
    [c?.secret ?? "", c?.team?.teamId ?? "", teamRelay(c), c?.team ? (loadSession(teamRelay(c))?.token ?? "") : ""].join("|");

  /**
   * Point config.json at `team`, keeping everything else except the always-allow list when the team
   * changes: names trusted in a legacy group (or another team) must not match a GitHub login here.
   */
  function useTeam(r: Ready, team: { teamId: string; name: string }): string {
    const prev = r.config;
    saveConfig(withTeam(prev, { relay: prev?.relay ?? DEFAULT_RELAY, name: prev?.name ?? r.session.login }, team));
    host.reconnect();
    return prev?.team && prev.team.teamId !== team.teamId ? ` (This replaced team "${prev.team.name}" on this machine.)` : "";
  }

  server.registerTool(
    "login",
    {
      title: "Sign in with GitHub",
      description:
        "Sign this machine in to mindmeld with GitHub (needed for teams). Returns a code and a URL for the user to open; " +
        "sign-in finishes in the background once they approve, and status then shows who is signed in.",
      inputSchema: {},
    },
    async () => {
      const config = host.loadConfig();
      const relay = teamRelay(config);
      const gen = login.gen + 1;
      login = { gen, pending: true, error: null };
      return new Promise<ReturnType<typeof text>>((resolve) => {
        let shown = false;
        signIn(relay, config, (code, uri) => {
          shown = true;
          resolve(
            text(
              [
                `Open ${uri} and enter ${code}`,
                "",
                "Show the user this code and link. Sign-in finishes on its own once they approve it on GitHub; then /mindmeld:status shows who is signed in.",
                "The code expires in 15 minutes.",
              ].join("\n"),
            ),
          );
        }).then(
          () => {
            if (login.gen !== gen) return;
            login = { gen, pending: false, error: null };
            host.reconnect();
          },
          (e: Error) => {
            if (login.gen === gen) login = { gen, pending: false, error: e.message };
            if (!shown) resolve(text(`Sign-in failed: ${e.message}`, true));
          },
        );
      });
    },
  );

  server.registerTool(
    "create_team",
    {
      title: "Create a team",
      description: "Create a mindmeld team with the signed-in user as its admin, and connect this machine to it. Only when the user asks.",
      inputSchema: { name: z.string().min(1).max(60).describe("The team's name") },
    },
    async ({ name }) => {
      const r = ready(false);
      if (typeof r === "string") return text(r, true);
      return attempt(async () => {
        const teamName = name.trim();
        const { teamId } = await createTeam(r.relay, r.session, teamName);
        const replaced = useTeam(r, { teamId, name: teamName });
        return text(
          `Created team "${teamName}" with you (@${r.session.login}) as admin.${replaced}\n` +
            "Invite teammates by their GitHub login with invite_member. Your sessions stay private until you run /mindmeld:share in one.",
        );
      });
    },
  );

  server.registerTool(
    "invite_member",
    {
      title: "Invite someone to the team",
      description: "Invite a GitHub user to the team (admins only). Gives the user a message to send them, with install and sign-in steps.",
      inputSchema: { login: z.string().min(1).describe("Their GitHub login") },
    },
    async ({ login: who }) => {
      const r = ready(true);
      if (typeof r === "string") return text(r, true);
      return attempt(async () => {
        await inviteMember(r.relay, r.session, r.team.teamId, who);
        return text(inviteMessage(who, r.team.name));
      });
    },
  );

  server.registerTool(
    "revoke_invite",
    {
      title: "Cancel an invite",
      description: "Cancel a pending invite to the team (admins only), so that GitHub login can no longer accept it. Only when the user asks.",
      inputSchema: { login: z.string().min(1).describe("The invited GitHub login") },
    },
    async ({ login: who }) => {
      const r = ready(true);
      if (typeof r === "string") return text(r, true);
      const target = normLogin(who);
      try {
        await revokeInvite(r.relay, r.session, r.team.teamId, target);
      } catch (e) {
        if ((e as { status?: number }).status === 404) return text(`@${target} has no pending invite to team "${r.team.name}".`, true);
        return text((e as Error).message, true);
      }
      return text(`Cancelled the invite for @${target} to team "${r.team.name}". They can no longer accept it.`);
    },
  );

  server.registerTool(
    "accept_invite",
    {
      title: "Accept a team invite (or use a team you're in)",
      description:
        "Accept an invite to a mindmeld team and connect this machine to it, or connect this machine to a team the user already belongs to. " +
        "Without a team it never joins anything: it lists pending invites and who sent each one, so the user can choose. " +
        "Pass the team name or id (only one the user named) to accept that invite.",
      inputSchema: { team: z.string().optional().describe("Team name or id, as the user named it") },
    },
    async ({ team }) => {
      const r = ready(false);
      if (typeof r === "string") return text(r, true);
      return attempt(async () => {
        const plan = planAccept(await listTeams(r.relay, r.session), team, r.session.login, "/mindmeld:team accept");
        if ("text" in plan) return text(plan.text, plan.isError);
        if ("use" in plan) {
          const t = plan.use;
          const replaced = useTeam(r, { teamId: t.teamId, name: t.name });
          return text(`This machine now uses team "${t.name}", where you're ${t.role}.${replaced}`);
        }
        const t = plan.join;
        await acceptInvite(r.relay, r.session, t.teamId);
        const replaced = useTeam(r, { teamId: t.teamId, name: t.name });
        return text(
          `Joined team "${t.name}" as @${r.session.login} (${invitedByText(t)}).${replaced}\n` +
            "A teammate's mindmeld gives this device the team key the next time one of them is online; /mindmeld:status shows progress. " +
            "Your sessions stay private until you run /mindmeld:share in one.",
        );
      });
    },
  );

  server.registerTool(
    "team",
    {
      title: "Show the team",
      description: "Show the user's mindmeld team: members and roles, each device's key fingerprint and whether it has the team key, pending invites, and recent activity.",
      inputSchema: {},
    },
    async () => {
      const r = ready(false);
      if (typeof r === "string") return text(r, true);
      return attempt(async () => {
        if (!r.config?.team) {
          const teams = await listTeams(r.relay, r.session);
          if (teams.length === 0) return text(NO_TEAM);
          return text(`This machine isn't using a team. Yours: ${teams.map(describeEntry).join(", ")}. Use accept_invite with the team's name to use one here.`);
        }
        const roster = await getRoster(r.relay, r.session, r.config.team.teamId);
        return text(formatTeam(roster, { uid: r.session.uid, deviceId: loadOrCreateIdentity().deviceId }));
      });
    },
  );

  server.registerTool(
    "remove_member",
    {
      title: "Remove someone from the team",
      description:
        "Remove a member from the team (admins only), with all their devices, then rotate the team key so they can't read anything sent afterwards. " +
        "Only when the user asks. A dialog asks them to confirm.",
      inputSchema: {
        login: z.string().min(1).describe("Their GitHub login"),
        confirmed: z
          .boolean()
          .optional()
          .describe("Only used when this client can't show dialogs: set true after the user has explicitly confirmed in chat. Otherwise a dialog always asks them"),
      },
    },
    async ({ login: who, confirmed }) => {
      const r = ready(true);
      if (typeof r === "string") return text(r, true);
      const target = normLogin(who);
      // The user confirms in a dialog whenever the client can show one; `confirmed` can't skip it.
      if (!server.server.getClientCapabilities()?.elicitation) {
        if (!confirmed) {
          return text(`Ask the user to confirm removing @${target} from team "${r.team.name}", then call remove_member again with confirmed: true.`, true);
        }
      } else {
        const a = await host.elicit(
          [
            `Remove @${target} from team "${r.team.name}"?`,
            "",
            "Their devices lose access right away, and the team key is rotated so they can't read anything the team sends after this.",
          ].join("\n"),
          { type: "object", properties: {} },
        );
        if (a.action !== "accept") return text(`Okay, @${target} stays in the team.`);
      }
      const o = { relayHttp: r.relay, teamId: r.team.teamId, session: r.session, id: loadOrCreateIdentity() };
      const res = await removeAndRotate(target, {
        remove: () => deleteMember(r.relay, r.session, r.team.teamId, target),
        rotate: () => rotate({ ...o, reason: "removed" }),
      });
      return text(res.text, res.isError);
    },
  );

  server.registerTool(
    "set_role",
    {
      title: "Change a member's role",
      description: "Make a team member an admin or a regular member (admins only).",
      inputSchema: {
        login: z.string().min(1).describe("Their GitHub login"),
        role: z.enum(["admin", "member"]),
      },
    },
    async ({ login: who, role }) => {
      const r = ready(true);
      if (typeof r === "string") return text(r, true);
      return attempt(async () => {
        await setRole(r.relay, r.session, r.team.teamId, who, role);
        return text(`@${normLogin(who)} is now ${role} in team "${r.team.name}".`);
      });
    },
  );

  return { channelFor, blocker, statusLines, watchKey };
}
