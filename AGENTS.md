# Agent instructions

This repository is ECHO's internal context-source authority. It is not an
installed runtime, a live-state authority, or a separate commercial product.

- Changes to `main` require an independently reviewed feature branch. A builder
  must never review or merge its own implementation.
- Build and publish only exact reviewed Git objects. Never rebuild after review
  or substitute working-tree bytes for a committed source SHA.
- The item-136 source seal is exactly the six-field content tuple: approved
  source SHA, source tree, version, source-archive SHA-256, lock hash, and
  manifest hash. It has no hosted workflow, tag, release, or artifact identity.
- Default to no live-state access and no external mutation. Do not read or alter
  a live database, client configuration, credential, LaunchAgent, daemon, or
  machine context authority from this repository.
- Installation, runtime authority, migration, rollback, and cutover are owned by
  later sequential items coordinated through Project_echo.
- Record cross-repository execution evidence in Project_echo's canonical
  migration record before claiming a gate complete.
- The item-135 provenance documents, including
  `provenance/runtime-inventory.v1.json`, are immutable historical evidence.
