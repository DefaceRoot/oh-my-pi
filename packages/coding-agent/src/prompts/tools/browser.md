Automate browser sessions: navigate, interact, query DOM, extract readable content, and capture screenshots.

<instruction>
- `open` starts a headless session; `goto` navigates; `close` ends session.
- Use `observe` to get accessibility snapshot + `element_id` targets.
- Prefer `click_id` / `type_id` / `fill_id` after `observe`; selector actions are fallback.
- Use `wait_for_selector` for dynamic pages.
- `evaluate` runs page JS.
- `get_text` / `get_html` / `get_attribute` query DOM (batch with `args`).
- `extract_readable` returns reader-mode markdown/text.
- `screenshot` captures visual output (optionally scoped by selector/path).
</instruction>

<critical>
- Default to `observe`, not `screenshot`.
- Use screenshots only when visual appearance matters.
- Do not screenshot solely to inspect page state.
</critical>

<output>
Text for navigation/DOM queries; image output for screenshots.
</output>
