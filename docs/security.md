# mindmeld security

This page is for people reviewing mindmeld's security design. It describes what is built as of 0.6.0, with the exact constructions, and it lists what is not covered. **None of this has had an external cryptography review yet.** The code is small and the sources are named below so you can check each claim.

mindmeld has two ways to connect people:

- **Teams (GitHub sign-in):** identity from GitHub, a key pair per device, roles, and removal with key rotation. Added in 0.6.0.
- **Legacy groups (invite codes):** a shared group secret from a SPAKE2 pairing. No identity beyond a self-chosen name.

Both go through a relay (a Cloudflare Worker, [`relay-worker/`](../relay-worker/)), which you can self-host.

## What the relay knows

Teams:

- Team names, member GitHub logins, roles, pending invites, and a membership log (who created, invited, joined, removed, rotated).
- Each device's public keys (Ed25519 signing key and X25519 box key) and device id.
- Which devices are connected right now, when, and how much data moves.
- Sealed (encrypted) team keys, one per device per epoch, and the signatures on them.

The relay never sees team keys or the plaintext of anything the team sends. Frames pass through as ciphertext plus a signature. It also never stores your GitHub token: the token is used once to ask GitHub who you are, then dropped.

Legacy groups:

- A room id, which is a hash of the group secret (`sha256("claude-share/room/" + secret)`), not the secret itself.
- Who is online and when, and how much data moves.
- During pairing, the first 4 characters of the invite code (a rendezvous id). Not the password part.

It never sees the group secret or plaintext. It stores nothing.

## Sign-in

Source: `src/auth/github.ts`, `src/auth/session.ts`, `relay-worker/src/auth.ts`.

1. **GitHub device flow.** The client asks GitHub for a user code, shows you the code and URL, and polls until you approve. mindmeld is a GitHub App, and its client id is public (`src/auth/config.ts`). Device flow needs no client secret, so no secret ships in mindmeld.
2. **Challenge.** The client asks the relay for a nonce (`POST /v1/auth/challenge`). The nonce is stateless: `hex(32 random bytes) + hex(expiry, 8 bytes) + hex(HMAC-SHA256(TOKEN_SIGNING_KEY, "mm-challenge|v1|" + random + "|" + expiry))`. It is valid for 5 minutes.
3. **Device proof.** The client sends the GitHub token, its device keys, the nonce, and an Ed25519 signature by its signing key over the UTF-8 string `mm-auth|v1|<nonce>|<deviceId>`. The relay checks the nonce MAC and expiry, then the signature (strict Ed25519, `zip215: false`), and only then asks GitHub (`GET /user`) whose token it is. This proves the caller holds the private key for the device it is registering.
4. **Session token.** `base64url(JSON {login, deviceId, exp}) + "." + base64url(HMAC-SHA256(TOKEN_SIGNING_KEY, first part))`. `exp` is unix time in seconds. Tokens last 7 days. There is no refresh: when one expires you sign in again. The relay refuses to issue or accept tokens if `TOKEN_SIGNING_KEY` is missing or shorter than 32 bytes.
5. The relay records the device under your login. If a device id is already registered with different keys, it refuses (409).

The session is saved in `session.json` (mode 600). The GitHub token is not saved.

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
- AES-256-GCM with a random 96-bit nonce, no AAD.
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

### Frames

Every message between team members is a frame `{ e, dev, d, sig }`:

- `d = base64(nonce || ciphertext || tag)` of AES-256-GCM(team key for epoch `e`, payload, random 96-bit nonce, AAD = `"mindmeld/frame/v1|" + e + "|" + dev`).
- `sig = Ed25519(signPriv, UTF-8(e + "|" + dev + "|" + d))`.

The receiver looks up `dev` in the roster, **verifies the signature first**, then decrypts. The login attached to a message comes from the roster entry for the verified device, not from anything the relay stamps on it; a frame whose relay-stamped login disagrees is dropped. The relay forwards a frame only if `dev` is the sending socket's own device.

### Which signature checks are strict

`zip215: false` (strict RFC 8032 style verification) is used for: the sign-in device proof (relay), wrap and commitment signatures on the relay when they are written (`relay-worker/src/team.ts`), and wrap and commitment signatures on the client (`src/teamkeys.ts`).

Frame signatures in `openFrame` (`src/teamcrypto.ts`) use the library default (`ed25519.verify` without options), which is not the strict mode. Frames are also authenticated by AES-GCM under the team key, so this is a gap in consistency rather than a known attack, but a reviewer should know it.

## Removing a member

Source: `relay-worker/src/team.ts`, `relay-worker/src/teamsocket.ts`, `src/teamapi.ts`, `src/teamkeys.ts`.

An admin removes a member in two steps, run back to back by the `remove_member` tool after the admin confirms in a dialog:

1. **Remove.** The relay deletes the member, all their devices and their stored wraps, and closes their team sockets with code 4001 ("removed from team"). Everyone else is told the roster changed.
2. **Rotate.** The admin's client creates a fresh 32-byte key for `epoch + 1`, seals it to every remaining device, signs the wraps and the commitment, and uploads them. Devices without the new key are disconnected until they receive it.

From then on the removed person cannot read anything sent at the new epoch. If the rotation fails, the tool says so, and running remove again finishes the job (a repeat remove of an already removed member still rotates).

Limits you should understand:

- Anything the removed member already received, including earlier epochs' keys they held, stays readable to them. Rotation protects the future, not the past.
- Between step 1 and step 2 the old key is still the current one. The removed person has already lost their connection and their wraps, but a copy of the old key they kept would still decrypt anything of that epoch they can get hold of.
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
- **The relay distributes public keys.** Rosters, device keys and invites come from the relay, and clients trust them as given. A malicious or compromised relay could hand out a substituted key or plant an extra device for a member, and then receive team keys sealed to it. Mitigation: compare device fingerprints out of band using `/mindmeld:team`. Nothing forces you to do this. Admin-only rotation is enforced by the relay alone: a malicious relay could accept a rotation from a non-admin member's device, and clients would accept it.
- **No replay, reorder or drop protection for team frames.** Frames carry no counter, so a relay (or anyone who captured a frame) can withhold or re-send valid frames within an epoch, including to a reconnecting device.
- **No forward secrecy within an epoch.** Anyone who gets a team key can read every frame sent in that epoch, including recorded ones. Keys change only when an admin rotates (on removal).
- **Stateless challenge replay window.** The sign-in challenge is not recorded as used, so within its 5 minute life the same nonce can be presented again. Using it still needs a valid device signature and a GitHub token for that login, so a replay by a third party does not help them.
- **Names inside legacy groups are not authenticated.** Any member can claim another member's name, and "always allow" trusts a name.
- **The answering fork relies on Claude Code's permission rules.** If those rules have a bug, the fork's read limits do too.
- **Relay override is allowed.** `MINDMELD_RELAY` and `--relay` point mindmeld at any relay, for self-hosting. Status shows the relay host when it is not the default. A relay you don't control sees everything in "what the relay knows".
- **Session labels** come from Claude Code's on-disk transcript layout, which is not a documented API.
- **Windows file protection** for `identity.json` and `session.json` is the user profile ACLs, not mode 600.
