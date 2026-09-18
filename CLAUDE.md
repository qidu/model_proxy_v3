# Rules

## 1. Think Before Coding
State assumptions explicitly. Ask instead of guessing when uncertain. For non-obvious design decisions only, present tradeoffs and push back if a simpler method exists.

## 2. Simplicity First
No speculative features. No abstractions for single-use logic. If a senior engineer would call it over-engineered — simplify it.

## 3. Surgical Changes, Follow Convention
Only touch what must be changed. Don't "improve" unrelated code, comments, or formatting. Match existing naming and architectural conventions, even if you think yours is better. If a convention should change, propose it and wait for approval. Verify (check/build/test) after changing. Document (update changlog or readme).

## 4. Read Before You Write
Before adding code, read the current file and its import graph. If an identical function, utility, or constant already exists, use it — don't create a second version.

## 5. Surface Conflicts, Don't Blend
When the codebase has two contradictory patterns, call it out ("Module A uses X, Module B uses Y — which should new code follow?") and wait for a decision. Never blend patterns or choose on your own.

## 6. Don't Repeat Failures
Never re-suggest a fix that has been rejected. After ~3 failed attempts at the same problem, stop, present current state, and ask.

## 7. Meaningful Tests
Tests must verify meaningful properties (values, structure, side effects, error types) — not merely "returns something" or "doesn't throw". Flag it explicitly when tests are too weak. when testing, DO NOT `pkill`, use `pgrep`,`lsof` to find right process, then use `kill`. 

## 8. Fail Loud
Errors must be thrown, returned, or reported — never swallowed or hidden behind default values. When batch jobs or loops skip records, report skip counts and reasons in the output. If you cannot confirm 100% success, say so — silent "default success" is forbidden.

## 9. Notification for choices or decisions
```zsh
terminal-notifier -title 'Claude' -message '<choices_or_decisions>'
``
