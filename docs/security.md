# mindmeld security

This page is for people reviewing mindmeld's security design. It describes what is built as of 0.7.0, with the exact constructions, and it lists what is not covered. **None of this has had an external cryptography review yet.** The code is small and the sources are named below so you can check each claim.

mindmeld has two ways to connect people:

- **Teams (GitHub sign-in):** identity from GitHub, a key pair per device, roles, and removal with key rotation. Added in 0.6.0.
- **Legacy groups (invite codes):** a shared group secret from a SPAKE2 pairing. No identity beyond a self-chosen name.

Both go through a relay (a Cloudflare Worker, [`relay-worker/`](../relay-worker/)), which you can self-host.

## What the relay knows

Teams:

- Team names, members' GitHub numeric user ids and current logins, roles, pending invites (by login, with the login of the admin who sent each), and a membership log (who created, invited, cancelled an invite, joined, removed, rotated).
- Each device's public keys (Ed25519 signing key and X25519 box key) and device id.
- Which devices are connected right now, when, and how much data moves.
- Sealed (encrypted) team keys, one per device per epoch, and the signatures on them.
- For each direct message (a question, a progress status, an answer, a decline or a snippet): the team, the sending device id, the recipient device id, when it was sent and its size. Not its content, and not which kind of payload it is (though size and timing may suggest it, e.g. small fixed-size statuses).

The relay never sees team keys or the plaintext of anything the team sends. Frames pass through as ciphertext plus a signature.

**Who receives what.** Presence (a shared session's `hello` with its owner's login, label and last-active time, and `bye`) is broadcast to every member's devices under the team key, so every member sees who is sharing which session. Everything between two people is sealed to the recipient device and the relay delivers it only to that device: other members' devices receive nothing for it, not even ciphertext (see [Direct messages](#direct-messages)). An honest relay (the hosted one runs the code in `relay-worker/`) also never stores your GitHub token: it uses the token once to ask GitHub who you are, then drops it. A relay you don't control can do whatever it likes with the token (see Known gaps).

**Identity is the GitHub numeric user id.** GitHub logins can be renamed, and a freed login can be registered by someone else, so the relay keys accounts, team members, devices and keys by the numeric `id` from `GET /user`. The login is kept for display and refreshed whenever the member signs in or uses the team. Invites are addressed by login (that is what admins type) and bind to the GitHub id of whoever accepts them while holding that login.

Legacy groups:

- A room id, which is a hash of the group secret (`sha256("claude-share/room/" + secret)`), not the secret itself.
- Who is online and when, and how much data moves.
- During pairing, the first 4 characters of the invite code (a rendezvous id). Not the password part.

It never sees the group secret or plaintext. It stores nothing.

## Sign-in

Source: `src/auth/github.ts`, `src/auth/session.ts`, `relay-worker/src/auth.ts`.

1. **GitHub device flow.** The client asks GitHub for a user code, shows you the code and URL, and polls until you approve. mindmeld is a GitHub App, and its client id is public (`src/auth/config.ts`). Device flow needs no client secret, so no secret ships in mindmeld.
2. **Challenge.** The client asks the relay for a nonce (`POST /v1/auth/challenge`). The nonce is stateless: `hex(32 random bytes) + hex(expiry, 8 bytes) + hex(HMAC-SHA256(TOKEN_SIGNING_KEY, "mm-challenge|v1|" + random + "|" + expiry))`. It is valid for 5 minutes.
3. **Device proof.** The client sends the GitHub token, its device keys, the nonce, and an Ed25519 signature by its signing key over the UTF-8 string `mm-auth|v1|<nonce>|<deviceId>`. The relay checks the nonce MAC and expiry, then the signature (strict Ed25519, `zip215: false`), and only then asks GitHub (`GET /user`) whose token it is (numeric `id` and `login`). This proves the caller holds the private key for the device it is registering.
4. **Session token.** `base64url(JSON {uid, login, deviceId, exp}) + "." + base64url(HMAC-SHA256(TOKEN_SIGNING_KEY, first part))`, where `uid` is the GitHub numeric id. `exp` is unix time in seconds. Tokens last 7 days. There is no refresh: when one expires you sign in again. The relay refuses to issue or accept tokens if `TOKEN_SIGNING_KEY` is missing or shorter than 32 bytes.
5. The relay records the device under your GitHub id. If a device id is already registered with different keys, it refuses (409).

The session is saved in `session.json` (mode 600) together with the relay that issued it, and is only ever sent back to that relay. The GitHub token is not saved.

**Which relay gets your credentials.** The client sends the GitHub token and session token only to the hosted relay, a loopback relay (`127.0.0.1` or `localhost`), or a relay you chose explicitly (`mindmeld login --relay`, which writes `teamRelay` into `config.json`, or that field written by hand). Environment variables (`MINDMELD_RELAY`, `CLAUDE_SHARE_RELAY`) and the legacy group's relay never decide where they go, because a project can set them. A session saved for one relay counts as signed out for any other. The GitHub device flow itself always runs against `https://github.com`; `MINDMELD_GITHUB_BASE` is honoured only as `http://127.0.0.1:<port>` or `http://localhost:<port>` (a local test mock).

## Device keys

Source: `src/identity.ts`.

Each machine makes one identity on first use: an Ed25519 signing key pair and an X25519 key pair, from the platform's secure random source. It is written to `identity.json` in the mindmeld home with mode 600 (the directory is created with mode 700). On Windows the mode bits do nothing, so the file is protected only by your user profile's default ACLs.

- **Device id:** the first 16 hex characters of `sha256(signPub)`. The relay checks this derivation at sign-in.
- **Fingerprint:** the first 16 bytes of `sha256(signPub)`, shown as 8 groups of 4 hex characters. `/mindmeld:team` shows one per device.

If `identity.json` is corrupt, mindmeld reports it and does not silently make a new identity.

## Team cryptography

Source: `src/teamcrypto.ts`, `src/crypto.ts`, `src/teamkeys.ts`.

### Team key and epochs

A team has one 32-byte random key per **epoch**. Epoch 1 is created by an admin's device when the team first gets a key. Any device that holds the current key seals it to teammates' devices that don't have it yet (automatic key delivery when a teammate is online). A new device therefore waits until a teammate comes online.

### sealToDevice

Seals bytes (a team key) to one device's X25519 key:

- Fresh ephemeral X25519 key pair per call. `shared = X25519(ephPriv, boxPub)`.
- `key = HKDF-SHA256(ikm = shared, salt = ephPub (32 bytes) || boxPub (32 bytes), info = "mindmeld/seal/v1", length = 32)`.
- AES-256-GCM with a random 96-bit nonce. No AAD for key wraps; direct messages pass an AAD (below).
- Output: `base64(ephPub || nonce || ciphertext || tag)`.

The key is used once, so nonce reuse cannot happen. The sender is anonymous at this layer; authenticity comes from the signed wrap below.

### Signed wraps and epoch commitments

Each sealed key is stored as a **wrap** with an Ed25519 signature by the writing device over the UTF-8 string:

```
mm-wrap|v1|<teamId>|<epoch>|<recipientDeviceId>|<sealed>
```

A rotation also carries a **commitment**: `hash = hex(sha256(raw team key))`, signed by the admin's device over:

```
mm-epoch|v1|<teamId>|<epoch>|<hash>
```

The relay checks every signature against the caller's own registered device key before storing anything, accepts a rotation only from an admin, only to exactly `current epoch + 1`, and only if it covers every current device. It refuses to replace an existing wrap for the same epoch and device.

The client does not trust the relay's checks. Before using a key for an epoch, it requires all of:

1. The wrap was written by a device in the **current roster** (`by`), and its signature verifies.
2. A commitment exists, was signed by a device in the **current roster** (any role), and its signature verifies. Role is not checked on the client, because that would break epochs committed by an admin who has since been demoted. The relay enforces admin-only rotation at write time.
3. The key unwraps with this device's X25519 key, is 32 bytes, and its `sha256` equals the committed hash.

An epoch that fails any check is dropped and reported (for example "team key for epoch 3 failed verification (bad wrap signature)").

### Broadcast frames (presence)

Presence payloads (`hello`, `bye`) go to the whole team as a frame `{ e, dev, d, sig }`:

- `d = base64(nonce || ciphertext || tag)` of AES-256-GCM(team key for epoch `e`, payload, random 96-bit nonce, AAD = `"mindmeld/frame/v1|" + e + "|" + dev`).
- `sig = Ed25519(signPriv, UTF-8(e + "|" + dev + "|" + d))`.

The receiver checks that `dev` is 16 lowercase hex characters, looks it up in the roster, **verifies the signature first**, then decrypts. The sender (GitHub id, and login for display) comes from the roster entry for the verified device, not from anything the relay stamps on it; a frame whose relay-stamped GitHub id disagrees is dropped, and a connection stays bound to the GitHub id of its first verified frame. The relay forwards a frame only if `dev` is the sending socket's own device, and sends it to every other team socket. Only `hello` and `bye` are ever broadcast (an allowlist: any other payload kind, including one a later version adds, must go as a direct message or not at all), and a broadcast frame that turns out to carry anything else is dropped by the receiver.

### Direct messages

Questions, progress statuses, answers, declines and snippets go to one device. The client sends the relay `{ t: "dm", to, f: { dev, to, s, sig } }`:

- `s = sealToDevice(recipient boxPub, UTF-8(payload JSON), AAD = UTF-8("mm-dm|v1|" + teamId + "|" + dev + "|" + to))`, the construction above (fresh ephemeral X25519 key, HKDF-SHA256 with info `"mindmeld/seal/v1"`, AES-256-GCM). Only the recipient device's X25519 private key opens it. The AAD binds the sender: if someone (for example the relay colluding with another member) re-signs `s` under a different `dev`, it no longer opens.
- `sig = Ed25519(signPriv of the sending device, UTF-8("mm-dm|v1|" + teamId + "|" + dev + "|" + to + "|" + s))`.

Source: `sealDirect` and `openDirect` in `src/teamcrypto.ts`, routing in `src/teamchannel.ts` and `relay-worker/src/teamsocket.ts`.

**Routing on the relay.** The relay forwards a `dm` only if `f.dev` is the sending socket's own device, `to` equals `f.to`, and `to` is a device currently on the team roster. It then sends `{ t: "dm", f, c, uid, login }` (stamped like a broadcast frame) only to the sockets of device `to`, never to anyone else. Anything else is dropped. A device may have several sockets (several Claude sessions on one machine share its device key); all of them get it, and each session keeps only what is meant for it: a question or snippet addressed to its own peer id, or a status, answer or decline whose id matches a question it is waiting on.

**Addressing on the client.** An ask or snippet names the target session's peer id; the client seals it to the device that sent that peer id's verified `hello`. A peer id stays bound to the GitHub id that announced it: a `hello` or `bye` for it from another member is dropped. The binding goes when that peer says `bye`, when its connection closes, or when it is evicted (at most 1,000 are kept, oldest first). Statuses, answers and declines go back to the device the question came from, which is known from the question's verified signature (askers never announce themselves). If the recipient can't be resolved to a device on the current roster, nothing is sent, and the ask fails with "can't reach <name>'s session right now". There is no fallback to a broadcast.

**Checks on receipt.** The receiver requires, in order: `dev` and `to` are 16 lowercase hex characters; `to` is its own device id; `dev` is a device on the current roster; the signature verifies against that device's signing key (strict, `zip215: false`); `s` opens with its own X25519 key and the AAD built from `teamId`, `dev` and `to`. The sender (GitHub id, and login for display) is the roster entry for `dev`, never anything in the payload; a frame whose relay-stamped GitHub id disagrees is dropped, and the connection binding applies as for broadcast frames. A `dm` carrying `hello` or `bye` is dropped. Anything that fails a check is dropped (and counted in the channel's `framesDropped`).

**Client versions.** Team sockets carry the client version (`?v=`). The relay refuses team clients below `TEAM_MIN_VERSION` (0.7.0), or that send no version, closing with code 4005 and "mindmeld <v> is too old for teams; update: claude plugin update mindmeld@mindmeld". So no team member can still be sending questions or answers under the team key. Legacy groups keep their own minimum (0.5.0).

### Which signature checks are strict

Every Ed25519 check uses `zip215: false` (strict RFC 8032 style verification, which also refuses small-order keys): the sign-in device proof (relay), wrap and commitment signatures on the relay when they are written (`relay-worker/src/team.ts`), wrap and commitment signatures on the client (`src/teamkeys.ts`), frame signatures in `openFrame` and direct message signatures in `openDirect` (`src/teamcrypto.ts`). Both also refuse a frame whose `dev` (and, for `openDirect`, `to`) is not exactly 16 lowercase hex characters before they look anything up.

## Removing a member

Source: `relay-worker/src/team.ts`, `relay-worker/src/teamsocket.ts`, `src/teamapi.ts`, `src/teamkeys.ts`.

An admin removes a member in two steps, run back to back by the `remove_member` tool after the admin confirms in a dialog:

1. **Remove.** The relay deletes the member, all their devices and their stored wraps, and closes their team sockets with code 4001 ("removed from team"). Everyone else is told the roster changed.
2. **Rotate.** The admin's client creates a fresh 32-byte key for `epoch + 1`, seals it to every remaining device, signs the wraps and the commitment, and uploads them. Devices without the new key are disconnected until they receive it.

From then on the removed person cannot read anything sent at the new epoch. If the rotation fails, the tool says so, and running remove again finishes the job (a repeat remove of an already removed member still rotates).

Limits you should understand:

- Anything the removed member already received, including earlier epochs' keys they held, stays readable to them. Rotation protects the future, not the past.
- Between step 1 and step 2 the old key is still the current one. The removed person has already lost their connection and their wraps, but a copy of the old key they kept would still decrypt presence frames of that epoch they can get hold of. Direct messages are not under the team key: once their devices leave the roster, nobody seals to them and the relay delivers nothing to them.
- The relay keeps wraps for the current epoch and **2 previous epochs** per device, so a device can read recent history and drop older ones.

## Legacy groups

Source: `src/spake2.ts`, `src/pairing.ts`, `src/crypto.ts`.

An invite code like `k7q2-9xmd-4tpa` has a rendezvous id (first 4 characters, seen by the relay) and a password (last 8 characters, about 39 bits, never sent). Pairing runs **SPAKE2 over ristretto255** (RFC 9382 structure) with these deliberate differences from the RFC's ciphersuites:

- M and N come from hash-to-curve of fixed strings instead of the RFC's edwards25519 constants.
- The transcript hash is SHA-512.
- `w = scrypt(password) mod L`, which also slows online guessing.

An eavesdropper or relay operator can't brute-force the password offline. An active attacker gets one online guess per run, and a wrong guess burns the invite. The pairing then hands over a random 256-bit **group secret**. Messages are sealed with AES-256-GCM under a key from `HKDF-SHA256(secret, salt "claude-share/salt", info "claude-share/key")`, and the relay sees only a hash of the secret as the room id.

Everyone in a legacy group holds the same secret. That is why there is no per-person removal there (leave and re-pair instead), and why names are not authenticated.

## Local protections

- The local daemon binds to `127.0.0.1` and requires a random bearer token in a mode-600 file.
- Answers come from a read-only fork of the shared session limited to `Read` and `Glob` inside the project, with secret-like files denied. Replies reach the asking Claude fenced as untrusted data.
- Questions are rate limited, and by default the owner approves every question and draft answer.

## Known gaps

- **No external cryptography review yet.** Custom constructions (sealToDevice, frame format, wraps, commitments, token format, SPAKE2 parameter choices) were designed and tested by the author only.
- **The relay distributes public keys.** Rosters, device keys and invites come from the relay, and clients trust them as given. A malicious or compromised relay could hand out a substituted key or plant an extra device for a member, and then receive team keys sealed to it. With a substituted X25519 key for a member's device it could also read direct messages sealed to that device, and with a planted device it could send signed direct messages as that member. Mitigation: compare device fingerprints out of band using `/mindmeld:team`. Nothing forces you to do this. Admin-only rotation is enforced by the relay alone: a malicious relay could accept a rotation from a non-admin member's device, and clients would accept it.
- **No replay, reorder or drop protection for team frames.** Broadcast frames and direct messages carry no counter or timestamp, so a relay (or anyone who captured a frame) can withhold or re-send valid frames, including to a reconnecting device. A direct message can only be replayed to the device it was sealed to; a re-sent question with an id already seen is ignored.
- **No forward secrecy.** Anyone who gets a team key can read every presence frame sent in that epoch, including recorded ones; keys change only when an admin rotates (on removal). Direct messages are sealed to the recipient device's long-term X25519 key, so anyone who later gets that device's `identity.json` can read every recorded direct message sent to it.
- **Stateless challenge replay window.** The sign-in challenge is not recorded as used, so within its 5 minute life the same nonce can be presented again. Using it still needs a valid device signature and a GitHub token for that account, so a replay by a third party does not help them.
- **Names inside legacy groups are not authenticated.** Any member can claim another member's name, and "always allow" trusts a name. The "always allow" list is cleared when the machine switches to a team, so a legacy name can't match a GitHub login.
- **The answering fork relies on Claude Code's permission rules.** If those rules have a bug, the fork's read limits do too.
- **Relay override is allowed.** For legacy groups, `MINDMELD_RELAY` and `--relay` point mindmeld at any relay. For teams, only an explicit `mindmeld login --relay` (or `teamRelay` in `config.json`) does; environment variables don't. Status shows the relay host when it is not the default. A relay you don't control sees everything in "what the relay knows".
- **A relay you choose receives your GitHub token and session token.** If you point teams at a relay you don't control, it gets the GitHub token at sign-in and your session token on every call. It could replay the GitHub token against other services that accept it (for example the hosted relay) and act as you there until the token expires or you revoke it on GitHub. Only choose relays you trust.
- **The relay accepts any GitHub token that GitHub's `/user` accepts.** That includes personal access tokens and tokens issued to other apps, not only tokens issued to mindmeld's GitHub App. Anyone holding such a token for your account can sign in to mindmeld as you and register a device. Binding sign-in to mindmeld's app needs the app's client secret on the relay (to check the token with GitHub's application API); that is planned.
- **Session tokens can't be revoked before they expire.** A session token is valid for 7 days. Removing the member from a team stops it working for that team, but there is no per-token or per-device revocation otherwise.
- **The relay can delay or hide a removal or rotation.** Clients take the roster and the current epoch from the relay and don't check that they see the latest one. A malicious relay could keep showing a removed member, or keep a client on an old epoch, and that client would keep sealing to the old key.
- **Frame metadata is in the clear.** The relay (and anyone on the path to it) sees each broadcast frame's epoch, sending device id, size and timing, each direct message's sending and recipient device ids, size and timing (so it learns who asks whom, and when), and who is connected.
- **A new device may never get the key.** A device that joins gets the team key only when a device that already holds it comes online. If no key holder comes online (for example the team's only other member has left for good), the new device keeps waiting; status says so.
- **Session labels** come from Claude Code's on-disk transcript layout, which is not a documented API.
- **Windows file protection** for `identity.json` and `session.json` is the user profile ACLs, not mode 600.
