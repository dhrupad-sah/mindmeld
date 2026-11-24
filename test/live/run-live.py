#!/usr/bin/env python3
"""
Live end-to-end test with two real, interactive Claude Code sessions ("dhrupad" and "sarim")
driven by `expect`, talking through a real relay with the plugin bundle.

  python3 test/live/run-live.py            # uses the hosted relay
  MINDMELD_RELAY=ws://... python3 test/live/run-live.py

Needs: expect, a signed-in `claude`, and `npm run build:plugin` first. Takes ~5 minutes and uses
a little of your Claude quota. Prints one line per step and exits 0 only if the answer comes back.

Sarim's session learns a fact, joins with Dhrupad's invite and shares itself as "scraper work".
Dhrupad's session lists peers, asks, and must get the fact back. Both approval dialogs are
accepted with Enter.
"""
import json, os, shutil, subprocess, sys, tempfile, time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
BUNDLE = os.path.join(ROOT, "plugin", "server", "mindmeld.cjs")
WORK = tempfile.mkdtemp(prefix="mm_live_")  # no hyphens: must never look like an invite code
EVENTS = os.path.join(WORK, "events")

# Run like a fresh terminal: drop markers inherited from any parent Claude session, and load no
# user settings or plugins (no hooks, no memory plugins leaking earlier runs into the test).
UNSET = " ".join(f"-u {k}" for k in os.environ if k.startswith("CLAUDE_CODE_") or k in ("CLAUDECODE", "CLAUDE_PID", "CLAUDE_EFFORT"))
TOOLS = " ".join("mcp__mindmeld__" + t for t in "invite_peer join_peer ask_peer list_peers share_session status".split())
# The TUI moves the cursor instead of printing spaces, so multi-word patterns allow either.
SP = r"(?:\s|\x1b\[[\d;?]*[A-Za-z])+"  # spaces, line wraps, or any cursor/erase code

def words(*ws):
    return SP.join(ws)

def script(who):
    env = {"MINDMELD_HOME": os.path.join(WORK, f"home-{who}")}
    if os.environ.get("MINDMELD_RELAY"):
        env["MINDMELD_RELAY"] = os.environ["MINDMELD_RELAY"]
    cfg = os.path.join(WORK, f"{who}.json")
    json.dump({"mcpServers": {"mindmeld": {"command": "node", "args": [BUNDLE, "mcp"], "env": env}}}, open(cfg, "w"))
    head = f"""proc ev {{m}} {{ exec sh -c "echo $m >> {EVENTS}" }}
proc say {{t}} {{ send $t; sleep 1; send "\\r" }}
log_file -noappend {WORK}/{who}.tty
set timeout 60
spawn -noecho env {UNSET} claude --setting-sources "" --strict-mcp-config --mcp-config {cfg} --allowedTools {TOOLS}
expect -re {{trust}} {{ sleep 1; send "\\033\\[B"; sleep 0.7; send "\\r" }}
expect -re {{Try "}} {{ sleep 8 }}
"""
    if who == "sarim":
        body = f"""say "Context for later: in this project the scraper got fast because we switched to a bounded worker pool of 32 workers with HTTP keep-alive and connection reuse, which cut runtime from 40 minutes to 3. Reply only OK."
set timeout 90
expect -re {{\\mOK\\M}} {{ ev sarim-context-ok }} timeout {{ ev sarim-context-FAILED }}
set w 0
while {{![file exists {WORK}/code.txt] && $w < 240}} {{ sleep 1; incr w }}
if {{![file exists {WORK}/code.txt]}} {{ ev no-code; exit 1 }}
set f [open {WORK}/code.txt]; set code [string trim [read $f]]; close $f
say "Join mindmeld with code $code. My name is Sarim."
# Judge the join by its effect (the saved pairing), not by Claude's wording.
set w 0
while {{![file exists {WORK}/home-sarim/config.json] && $w < 120}} {{ sleep 1; incr w }}
if {{[file exists {WORK}/home-sarim/config.json]}} {{ ev sarim-joined }} else {{ ev sarim-join-FAILED }}
sleep 8
say "Share this session on mindmeld with the label scraper work."
expect -re {{(?i)shared}} {{ ev sarim-shared }} timeout {{ ev sarim-share-FAILED }}
sleep 5
exec touch {WORK}/joined
set timeout 420
set n 0
expect {{
  -re {{requests your input}} {{ incr n; ev dialog-$n; sleep 4; send "\\r"; if {{$n < 2}} {{ exp_continue }} }}
  timeout {{ ev dialog-timeout }}
}}
sleep 30
"""
    else:
        body = f"""say "Use mindmeld to invite a teammate. My name is Dhrupad."
set timeout 120
expect -re {{(?:^|[^a-zA-Z0-9_/.-]|\x1b\[[\d;]*[A-Za-z])([a-z2-9]{{4}}-[a-z2-9]{{4}}-[a-z2-9]{{4}})(?![a-zA-Z0-9-])}} {{ set c $expect_out(1,string); exec sh -c "echo $c > {WORK}/code.txt"; ev invite-code-ok }} timeout {{ ev invite-FAILED }}
set w 0
while {{![file exists {WORK}/joined] && $w < 420}} {{ sleep 1; incr w }}
sleep 4
say "List who is sharing on mindmeld."
set timeout 90
expect -re {{{words("scraper", "work")}}} {{ ev dhrupad-sees-scraper-work }} timeout {{ ev dhrupad-list-FAILED }}
sleep 10
say "Ask Sarim via mindmeld: how did the scraper get so fast? Then show me the answer verbatim."
set timeout 480
expect -re {{keep-alive|{words("worker", "pool")}}} {{ ev ANSWER-RECEIVED }} timeout {{ ev answer-timeout }}
sleep 15
"""
    tail = 'send "\\x03"; sleep 1; send "\\x03"\nexpect eof\n'
    path = os.path.join(WORK, f"{who}.exp")
    open(path, "w").write(head + body + tail)
    return path

def main():
    if not shutil.which("expect"):
        sys.exit("needs `expect`")
    if not os.path.exists(BUNDLE):
        sys.exit("run `npm run build:plugin` first")
    procs = []
    for who in ("sarim", "dhrupad"):
        cwd = os.path.join(WORK, f"proj-{who}")
        os.makedirs(cwd)
        procs.append(subprocess.Popen(["expect", script(who)], cwd=cwd, stdout=open(os.path.join(WORK, f"{who}.err"), "w"), stderr=subprocess.STDOUT))
        time.sleep(2)
    seen = 0
    while any(p.poll() is None for p in procs):
        time.sleep(2)
        lines = open(EVENTS).read().split() if os.path.exists(EVENTS) else []
        for line in lines[seen:]:
            print(line, flush=True)
        seen = len(lines)
    ok = os.path.exists(EVENTS) and "ANSWER-RECEIVED" in open(EVENTS).read()
    print("PASS" if ok else f"FAIL (transcripts in {WORK})", flush=True)
    sys.exit(0 if ok else 1)

if __name__ == "__main__":
    main()
