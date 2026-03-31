---
description: "Prefer local clarity over speculative helpers. Keep one-off logic inline until reuse is real."
---

# No Premature Abstraction

- Do not create helpers, utilities, or abstractions for one-time operations.
- Three similar lines of code are better than a premature abstraction.
- Extract shared code only after a second concrete use case appears or when an established repository convention requires it.
- Prefer explicit local code over indirection that exists only to look tidy.
