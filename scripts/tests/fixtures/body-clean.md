## What

Adds the weekly digest report and the job that sends it.

## Kind

- [x] Feature

## Notes for the reviewer

The retry path is untested against a real outage; the cursor used by the
query is closed in a `finally` block.
