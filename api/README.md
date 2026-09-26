
## AI usage

This project was built with Claude (Anthropic) as a collaborator across
design, implementation, and debugging.

**Accepted suggestion:** the detour-ratio matching rule (Section 5 of the
plan). My first instinct was a hardcoded zone-compatibility table ("Mohakhali
and Gulshan 1 are near each other"), which works but doesn't generalize and
isn't derived from anything real. Claude proposed computing an actual detour
ratio from haversine distance instead, the same approach used in real
carpooling matching research, with a documented, tunable threshold (1.3).
I accepted this because it's just as easy to hand-verify for grading as the
zone-table approach, but it's an actual formula rather than a guess, and it
degrades sensibly for routes that don't obviously belong on a fixed list.

**Rejected suggestion:** Claude's first draft of the concurrency section
described `SELECT ... FOR UPDATE` as merely "sufficient for MVP," almost
apologetically, positioning it as a stopgap rather than a considered choice.
I pushed back implicitly by asking for real-world grounding rather than
textbook advice, and the revised version correctly reframed pessimistic
locking as the deliberate, correct choice for high-contention resources like
a Tesla's last seat, not a shortcut. The lesson generalized: I stopped
accepting "good enough for MVP" framing without asking whether it was
actually the right engineering call or just the easy one.

**Where AI assistance mattered most in practice:** not the initial code
generation, but the debugging. Two real bugs made it into the codebase
despite passing unit tests: a candidate-matching regression that silently
charged full fare instead of the pooled discount, and a test-isolation bug
that deleted real demo data. Both were found only by manually running the
system end-to-end (via curl, then the browser) and checking actual output
against expected numbers, not by trusting that green tests meant correctness.
Claude helped root-cause both once the symptom was visible, but the manual
verification step (comparing real numbers against the plan's worked example)
is what surfaced them in the first place.
