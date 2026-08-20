### Screenshots

When a finding is visual, capture it. Commit the image to the orphan branch
`{{assetBranch}}`, then link it in your comment as a plain link, never an
embed. Embedded images make a tracker item unreadable in a terminal and in a
digest, and the loop reads both.

This section is the documented exception to the push fence: `{{assetBranch}}`
is the one ref other than your own branch you may push, and only to add an
image. Never push it with force, and never commit an image anywhere else.
