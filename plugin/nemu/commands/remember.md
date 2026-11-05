---
description: Save something durable to this project's Nemu memory
argument-hint: what to remember
---

Save this to the project's Nemu memory so it follows the project to other machines and agents:

$ARGUMENTS

If nothing was given after /remember, save the most useful durable fact from the work so far: a decision and why, a convention, a gotcha that cost time, or how to run or test something.

1. Call `memory_search` with a few words from it. If a current note already covers the same thing, update that note with `memory_write` under its existing name instead of writing a near copy.
2. Otherwise call `memory_write` with a name of the form `<tag>/<short_slug>`, choosing the tag that fits (`decision`, `convention`, `gotcha`, `preference`, `arch`, `env`, `test`, `deploy`, `todo` and the others the tool lists), a short subject and one plain paragraph as the body. Add `refs` for the files it concerns.
3. Never save a secret, a token, a password or personal data.

Then say in one line what was saved and under which name.
