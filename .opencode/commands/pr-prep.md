---
description: Analyzes changes, auto-generates missing tests for any language stack, runs them, and drafts a PR description.
agent: build
---
Let's prepare this branch for merging into the parent repository. Follow these steps sequentially:

### Step 1: Identify Changed Files
Run `git diff upstream/main --name-only` (or compare against the parent repository's main branch) to list all files modified or added on this branch.

### Step 2: Detect the Stack and Test Framework
For the modified files, auto-detect the programming language and standard testing setup. For example:
- **Python / FastAPI**: Look for `requirements.txt`, `pyproject.toml`, or `poetry.lock`. Use `pytest`.
- **Node.js / Next.js / React**: Look for `package.json`. Use `npm test`, `jest`, or `vitest` as defined in the scripts.
- **Go / Rust / Other**: Detect the standard native test runners (e.g., `go test`, `cargo test`).

### Step 3: Audit and Auto-Generate Tests
For any newly created or significantly modified business logic files (e.g., API endpoints, utilities, helper functions):
1. Check if a corresponding test file exists (e.g., look for files in `tests/`, `__tests__/`, or files ending in `.test.js`, `_test.py`, etc.).
2. **If no test file exists, create one.** Generate robust unit tests covering the edge cases of the new logic, matching the detected framework's style.
3. If a test file exists but lacks coverage for the new changes, append tests for the new logic.

### Step 4: Run the Test Suite
Run the appropriate shell command to execute the tests for the modified service (e.g., `pytest services/auth-service` or `npm run test` inside the frontend directory). Capture the results.

### Step 5: Draft the Pull Request Description and Update AGENTS.md
First update AGENTS.md so that the context of what's done also get commited.
Generate a beautifully structured Markdown description (without any emojies, also it should look natural and like it is written by a senior SDE) for the Pull Request (but don't create any md file for it... just output normally). Format it exactly like this:
"""
## Pull Request: [Brief Title of Changes]

### Summary of Changes
[Provide a 2-3 sentence summary of what this PR accomplishes]

### Key Modifications
- **[Service/Folder Name]**:
  - [Bullet points of files edited and what was changed]