---
name: synchronized-workspace
description: Keep code changes coherent and transferable when working in a pi-sync synchronized conversation. Use when the conversation has a recorded upstream branch and commit or when another runtime may continue the work.
license: MIT
---

# Synchronized Workspace

A synchronized conversation transfers the conversation and a pointer to the
last pushed upstream commit. It does not transfer dirty files, local commits,
stashes, credentials, or machine-specific configuration.

## Before handing work to another runtime

1. Inspect the working tree and remove generated files, credentials, and
   machine-local state from the change.
2. Make a coherent commit that describes the completed unit of work.
3. Push that commit to the recorded upstream branch.
4. Confirm that the pushed commit contains everything the next runtime needs.
5. Report the branch and pushed commit, plus any intentionally uncommitted local
   work that the next runtime must not assume exists.

Do not claim that work can continue elsewhere until the required code is
committed and pushed. Never commit API keys, auth files, private keys, local
Pi state, absolute paths, or unrelated workspace artifacts.

## When resuming

Treat the synchronized branch and commit as the shared starting point. Verify
that the local checkout has the commit available through normal Git workflow.
Do not copy patches or mutate Git history automatically as part of conversation
synchronization. If the workspace is dirty or the expected commit is missing,
explain the condition before changing files.
