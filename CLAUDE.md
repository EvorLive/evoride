<!-- evoride:edits:start -->
## Edit tracking (EvorIDE)
After you create or modify a file, append ONE json line to the file at the path in the `$EVORIDE_EDITS` env var, recording what you changed:
`echo '{"file":"<repo-relative path>","info":"<short what/why>"}' >> "$EVORIDE_EDITS"`
This lets EvorIDE show which files you changed in this session. Do it for every edit.
<!-- evoride:edits:end -->
