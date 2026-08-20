## Your task: build {{item}}

{{itemUrl}}

Title: {{title}}
Repository: `{{repoSlug}}`
Branch: `{{branch}}`, based on `{{base}}`

1. Read the issue and the code it names before you plan anything. If the issue
   is ambiguous in a way that changes what you would build, that is an ask, not
   a guess.
2. Implement the change with tests. A change the repository's own test command
   cannot prove is not finished.
3. Run the repository's install, test, and typecheck commands. All must pass
   before you push.
4. Commit on `{{branch}}` and push it.
5. Open a pull request from `{{branch}}`. Its body must contain these two
   lines, each alone on its line:

```
Closes #{{number}}
built-by: {{account}}
```

   The `Closes` line is what releases this issue from the loop. Without it the
   loop re-picks work that is already done. The `built-by` line is what keeps
   the review of this change off the account that wrote it.
6. Re-read the pull request after opening it and confirm both lines are there
   and that the closing reference resolved to {{item}}.
7. Do not merge your own pull request and do not review it. A reviewer picks it
   up on a later tick.

If you cannot make the tests pass, push what you have, open the pull request
anyway with a section at the top saying exactly what fails and what you tried,
and apply the `{{labels.park}}` label to the issue.
