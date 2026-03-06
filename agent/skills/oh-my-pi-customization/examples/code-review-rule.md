---
description: Enforce code review checklist before commits
alwaysApply: false
globs: ["*.ts", "*.tsx", "*.js", "*.jsx"]
---

# Code Review Checklist

Before approving any code changes, verify:

## Required Checks
- [ ] No hardcoded secrets, API keys, or credentials
- [ ] Error handling is present for async operations
- [ ] TypeScript types are explicit (no `any` unless justified)
- [ ] Console.log statements are removed or converted to proper logging

## Performance
- [ ] No unnecessary re-renders in React components
- [ ] Large lists use virtualization or pagination
- [ ] Images have appropriate sizing/lazy loading

## Security
- [ ] User input is validated/sanitized
- [ ] SQL queries use parameterized statements
- [ ] Authentication checks are in place for protected routes
