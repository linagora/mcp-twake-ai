---
name: twake-batch-approval
description: Use before making 3 or more similar writes with a Twake.ai server (several tasks in Twake Projects, several uploads to Twake Drive, several drafts, events or posts) — propose one approval for the exact list with approve_batch.
---

# Approving a series of Twake.ai writes at once

Each Twake.ai write asks the user for approval. For a series, ask once:

1. **Plan the exact calls.** When you are about to make 3 or more writes with the same Twake.ai server, write down each call: the tool and its exact arguments.
2. **Ask in the conversation.** Show the list to the user, numbered, and ask: "Do you want to approve these N actions in one go?" Never call `approve_batch` without that yes.
3. **Call `approve_batch`** of that server with `actions: [{ tool, arguments }, …]`, the arguments exactly as you will send them. The user sees the whole list in one approval.
4. **Make each call** with exactly those arguments plus the `batchId` you got. Each one runs without another question, once, within 15 minutes.
5. **Never change an approved action.** If the plan changes (another title, another folder, a new step), make a new batch, or let each call ask as usual. A call not in the list, or whose target changed since, asks as usual: that is expected.
6. **Calls that depend on earlier results** (assigning tasks you are creating, moving files you are uploading) cannot be listed before those results exist: make a first batch, then a second one with the identifiers the first returned.
7. **Batches are per server and per session.** One batch for Projects, another for Drive; a new session needs a new batch.
8. Mail's `batch_*` tools (`batch_move`, `batch_mark_read`…) are one action on several e-mails, not an approval batch: they ask once already.
