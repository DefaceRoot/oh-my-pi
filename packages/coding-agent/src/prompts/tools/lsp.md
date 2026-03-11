Use Language Server Protocol features for code intelligence and safe symbol edits.

<operations>
- `diagnostics`: file/glob/workspace diagnostics
- `definition`, `type_definition`, `implementation`, `references`: jump/search symbol locations with context
- `hover`: type/docs info
- `symbols`: file/workspace symbol search
- `rename`: symbol rename (preview/apply)
- `code_actions`: list/apply quick-fixes/refactors/import actions
- `status`: list active servers
- `reload`: restart server
</operations>

<parameters>
- `file`: file path (diagnostics may accept globs)
- `line`: 1-indexed line for position-based actions
- `symbol`: substring on target line to resolve column
- `occurrence`: 1-indexed disambiguation when symbol appears multiple times on one line
- `query`: symbol search or code-action selector
- `new_name`: required for rename
- `apply`: apply edits (rename defaults true; code_actions defaults list mode)
- `timeout`: request timeout seconds (5-60, default 20)
</parameters>

<caution>
- Requires a running language server for target language.
- Some actions require saved files.
- Broad diagnostics globs are sampled to avoid long stalls.
- Invalid `symbol`/`occurrence` returns explicit errors.
</caution>
