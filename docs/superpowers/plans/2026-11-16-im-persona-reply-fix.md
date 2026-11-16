# Fix IM persona reply falling back to template

## Root cause
`usage.jsonl` shows `kind:im` with `completionTokens:0` estimated. `builtInPersonaReply` returned early when `listHostModels()` was empty (`picked.id` missing), so WeChat kept getting `buildTemplateReply`.

## Fix
1. Prefer `sessionController.generateReply` **without** requiring model catalog.
2. Else use dedicated home-session `prompt` + `waitForSessionUsage` (same path as boot, proven to spend real tokens).
3. Expand `extractImReplyText`; warn with reason on fallback.
