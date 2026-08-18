---
description: Syncs local main with the parent repo and spins up a clean feature branch.
agent: build
---
Please run the following terminal commands sequentially to prepare my workspace:
1. `git checkout main`
2. `git fetch upstream`
3. `git merge upstream/main` (Make sure my local main is perfectly sync'd with the parent repo)
4. `git checkout -b feature/$ARGUMENTS` (Create my new feature branch off parent main)

After running, output a message saying "Branch feature/$ARGUMENTS is ready! What are we building today?"