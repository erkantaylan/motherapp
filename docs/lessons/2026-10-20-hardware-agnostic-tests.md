# Tests that touch real hardware (2026-10-20, main session, issue #18)

## Lessons

- [both] A test written in the cloud asserted that the real libddcutil finds **0** monitors. On the
  user's machine it finds 2, so `make verify` failed there and the push rule couldn't be followed.
  → A test that uses real hardware or a real system library must pass **with and without** the
  hardware: assert the shape (an array of entries with the right fields), not the count, and
  accept either outcome ("none found" or rows appearing).
- [both] **Never write to real hardware from a test.** The real-library tests only detect and read,
  and they read a bus that can't exist (`999`). Anything that writes uses the fake worker or the fake
  `ddcutil`. Check new tests for this before pushing.
- [local] When `make verify` fails, stop: don't push, not even a docs-only commit. Commits can run
  together (`make verify && git push …`).
