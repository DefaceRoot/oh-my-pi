# Safety Checks for Parallel Implementation Dispatch

Use this checklist before launching concurrent implementation work.

**Related**: [../SKILL.md](../SKILL.md)

## Hard-Stop Conditions (Automatic Sequential Execution)

Run sequentially when any condition below is true:

1. **File overlap exists**: two or more work items touch any of the same files.
2. **Contract coupling exists**: one work item changes a type, schema, exported API, config shape, or fixture contract that another work item needs.
3. **Required output dependency exists**: one work item cannot finish correctly without artifacts from another (renames, generated files, migration output, rewritten imports, or revised assertions).
4. **Dependency direction is upstream/downstream**: one work item edits a producer module and another edits its consumer behavior in the same execution window.
5. **Conflict risk is not clearly low**: uncertainty about ownership boundaries, integration points, or merge safety.

If any item is unknown, treat it as failed and run sequentially.

## Parallel Eligibility Checklist (All Must Be YES)

Parallel execution is allowed only when every answer is YES.

| Check | Yes Criteria |
|---|---|
| File isolation | Each work item has a fully disjoint file set. |
| Contract stability | No work item changes contracts consumed by another concurrent work item. |
| Dependency independence | No work item is upstream or downstream of another in the dependency graph. |
| Sequencing independence | No work item requires another work item's output to implement, compile, or verify. |
| Integration safety | Changes avoid shared registries, shared generated outputs, and shared global wiring points. |
| Verification independence | Each work item can be validated without waiting for another concurrent work item. |
| Merge safety | Expected merge/conflict risk is low and explicitly justified. |

If one answer is NO or UNKNOWN, do not run in parallel.

## Independent vs. Superficially Independent Work

### Safe Independent Work

Work is truly independent when all of the following are true:

- Distinct file sets.
- Stable contracts on both sides.
- No producer/consumer relationship between changed modules.
- Validation can run for each work item without waiting for cross-item outputs.

### Work That Looks Independent but Is Not

Treat these as sequential:

- Different files, but one change updates a shared interface/schema and another relies on it.
- Different files, but one change renames an exported symbol and another updates callers.
- Different directories, but both changes converge on shared wiring (index exports, registries, route maps, generated manifests).
- Different modules, but tests/fixtures in one change depend on data shape modified by another.

## Sequencing Rule When Parallel Is Rejected

When any safety gate fails, execute in this order:

1. Contract owners and shared definitions.
2. Direct consumers of those definitions.
3. Integration wiring and cross-module composition.
4. Verification updates dependent on final integrated behavior.

## Minimal Pre-Dispatch Data to Collect

Collect this for each work item before deciding:

- Exact file set.
- Contracts changed (types, schemas, exports, config shapes, fixture shapes).
- Imports/dependencies touched.
- Required inputs/outputs for completion and verification.

Do not dispatch concurrently without this data.