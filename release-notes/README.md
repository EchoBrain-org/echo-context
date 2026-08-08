# Beta release notes

Each beta candidate must add one reviewed file named `<version>.md` before
staging, for example `0.1.0-beta.9.md`. The file contains only the human-written
middle of the GitHub release body. The release operator adds the invariant
heading, exact reviewed source commit, and artifact-policy footer.

These files are append-only release identity. Keep historical files unchanged,
use UTF-8 with LF line endings, end with exactly one newline, and do not add
trailing whitespace. A missing or non-canonical file blocks `beta:stage` before
CI, durable staging, or tag creation.

`0.1.0-beta.7.md` is the migrated historical body for the first governed beta;
its published body hash is locked in tests. There is intentionally no beta.8
file: beta.8 was staged and tagged before the old gate noticed missing notes, so
that candidate is preserved as consumed rather than silently retagged. New
candidates start with beta.9.
