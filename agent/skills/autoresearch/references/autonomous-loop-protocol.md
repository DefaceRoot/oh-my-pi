# Autonomous Loop Protocol

Detailed protocol for the autoresearch iteration loop. SKILL.md has the summary; this file has the full rules.

## Step 1: Review (30 seconds)

Before each iteration, build situational awareness:

```
1. Read current state of in-scope files (full context)
2. Read last 10-20 entries from results log
3. Run: git log --oneline -20 to see recent changes
4. Identify: what worked, what failed, what's untried
```

**Why read every time?** After rollbacks, state may differ from what you expect. Never assume — always verify.

## Step 2: Ideate (Strategic)

Pick the NEXT change. Priority order:

1. **Fix crashes/failures** from previous iteration first
2. **Exploit successes** — if last change improved metric, try variants in same direction
3. **Explore new approaches** — try something the results log shows hasn't been attempted
4. **Combine near-misses** — two changes that individually didn't help might work together
5. **Simplify** — remove code while maintaining metric. Simpler = better
6. **Radical experiments** — when incremental changes stall, try something dramatically different

**Anti-patterns:**
- Do not repeat the exact same change that was already discarded
- Do not make multiple unrelated changes at once (cannot attribute improvement)
- Do not chase marginal gains with ugly complexity

## Step 3: Delegate (One Atomic Change)

Spawn an `implement` subagent via the Task tool with:
- A clear one-sentence description of the change
- The exact file scope (which files may be modified)
- Any constraints (e.g. "do not change the public API")

The change should be explainable in one sentence. Write the description BEFORE delegating (forces clarity).

The `implement` subagent will handle its own lint/review/commit loop. Wait for it to complete before proceeding to verification.

## Step 4: Verify (Mechanical Only)

Run the agreed-upon verification command via `bash`. Capture output.

**Timeout rule:** If verification exceeds 2x normal time, kill and treat as crash.

**Extract metric:** Parse the verification output for the specific metric number.

## Step 5: Decide (No Ambiguity)

```
IF metric_improved:
    STATUS = "keep"
    # Do nothing — commit stays
ELIF metric_same_or_worse:
    STATUS = "discard"
    Run: git reset --hard HEAD~1
ELIF crashed:
    # Attempt fix (max 3 tries via implement subagent)
    IF fixable:
        Fix -> re-commit -> re-verify
    ELSE:
        STATUS = "crash"
        Run: git reset --hard HEAD~1
```

**Simplicity override:** If metric barely improved (+<0.1%) but change adds significant complexity, treat as "discard". If metric unchanged but code is simpler, treat as "keep".

## Step 6: Log Results

Append to results log (TSV format):

```
iteration  commit   metric   status   description
42         a1b2c3d  0.9821   keep     increase attention heads from 8 to 12
43         -        0.9845   discard  switch optimizer to SGD
44         -        0.0000   crash    double batch size (OOM)
```

## Step 7: Repeat

Go to Step 1.

<critical>
NEVER STOP. NEVER ASK IF YOU SHOULD CONTINUE.
Do not summarize after each iteration — just log and continue.
Print a brief one-line status every ~5 iterations (e.g., "Iteration 25: metric at 0.95, 8 keeps / 17 discards").
Alert if you discover something surprising or game-changing.
</critical>

## When Stuck (>5 Consecutive Discards)

1. Re-read ALL in-scope files from scratch
2. Re-read the original goal/direction
3. Review entire results log for patterns
4. Try combining 2-3 previously successful changes
5. Try the OPPOSITE of what hasn't been working
6. Try a radical architectural change

## Crash Recovery

- Syntax error -> fix immediately via `implement` subagent, do not count as separate iteration
- Runtime error -> attempt fix (max 3 tries), then move on
- Resource exhaustion (OOM) -> revert, try smaller variant
- Infinite loop/hang -> kill after timeout, revert, avoid that approach
- External dependency failure -> skip, log, try different approach

## Communication Rules

- **DO NOT** ask "should I keep going?" — YES. ALWAYS.
- **DO NOT** pause or wait for user input mid-loop
- **DO NOT** summarize after each iteration — just log and continue
- **DO** print a brief one-line status every ~5 iterations
- **DO** alert if you discover something surprising or game-changing
- **DO** use `todo_write` to track overall progress across iterations
