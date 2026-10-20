Claude Code screens as `tmux capture-pane -p` would print them, for `test/idle.test.ts`.
`idle-*` must be judged idle, `busy-*` busy. **Written by hand** from how Claude Code 2.x draws
its screen, not captured on the machine. Replace or add real captures
(`tmux capture-pane -p -t motherapp:0.0 > idle-real.txt`) when the tool is tested locally.
The test also runs every fixture with a no-break space after the `>` prompt.
