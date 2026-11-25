---
description: Your mindmeld team: show it, or create, invite, cancel invites, accept, remove, change roles
argument-hint: "[create <name> | invite <github-login> | uninvite <github-login> | accept [team] | remove <github-login> | role <github-login> admin|member]"
---
Arguments: $ARGUMENTS

Pick the mindmeld tool from the arguments:
- nothing: the team tool, and show me its result as is
- create <name>: create_team with that name
- invite <github-login>: invite_member, then show me the message to send them, ready to copy
- uninvite <github-login>: revoke_invite with that login (cancels their pending invite)
- accept [team]: accept_invite, passing the team only if I named one. With no team it joins nothing: it lists my pending invites and who sent each one, so show me that list as is and let me pick. It also connects this machine to a team I am already in
- remove <github-login>: remove_member (it asks me to confirm in a dialog)
- role <github-login> admin|member: set_role

If a tool says I'm not signed in, tell me to run /mindmeld:login. Then tell me the result.
