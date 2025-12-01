# Copilot reviewer playbook

This repository stores homework for the JavaScript/DOM course. Keep PR feedback scoped to the module of the changed task so guidance matches what the student has already studied. For custom Node.js models invoked from GitHub Actions, see `custom-model.md` in this directory.

How to review
- Locate the module from the path under `tasks-js-3/<module>/...` or the related tests.
- Use the module notes in `modules.md` to stay inside that module's concepts. Avoid suggesting techniques from later modules or adding external libraries unless the module explicitly teaches them.
- If a PR touches multiple modules, consider each one separately and call out cross-module leaks (advanced features used early, edits to unrelated tasks).
- Prefer minimal fixes that satisfy the tests and preserve the provided task scaffolding instead of large rewrites.
- Keep feedback actionable and course-aligned; do not request changes to CI, build, or formatting settings unless the module scope requires it.
