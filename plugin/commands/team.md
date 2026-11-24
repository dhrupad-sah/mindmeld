---
description: Your mindmeld team: show it, or create, invite, accept, remove, change roles
argument-hint: "[create <name> | invite <github-login> | accept [team] | remove <github-login> | role <github-login> admin|member]"
---
Arguments: $ARGUMENTS

Pick the mindmeld tool from the arguments:
- nothing: the team tool, and show me its result as is
- create <name>: create_team with that name
- invite <github-login>: invite_member, then show me the message to send them, ready to copy
- accept [team]: accept_invite (pass the team if I named one). It also connects this machine to a team I am already in
- remove <github-login>: remove_member (it asks me to confirm in a dialog)
- role <github-login> admin|member: set_role

If a tool says I'm not signed in, tell me to run /mindmeld:login. Then tell me the result.
