# Security

Gina RAG is a reference implementation of a fail-closed retrieval gate. It is not a hosted service.

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private vulnerability reporting on this repository (Security → Report a vulnerability). Include the input, the expected decision (`allowed` or a deny reason) and the decision you got.

A finding that makes the gate return `allowed` where it should deny, or that puts record text into the vector index, is treated as critical.

## Scope and known limits

- The injection detector is a layer, not a barrier. Bypasses are expected and documented in `docs/evaluation.md`. A bypass is in scope only if it also defeats a structural guarantee: a field the user cannot read reaching the model, a CRM write without human approval, or text stored in the index.
- Never commit org credentials. The `sf` CLI owns them; `.env.local` is git-ignored.
