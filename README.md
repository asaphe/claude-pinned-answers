# pinned-answers

Answers to your questions get lost in long replies and scrollback. This Claude Code plugin keeps the answer on screen in a pane beside the chat until you dismiss it with one key.

## How it works

1. You ask something: the prompt has a question mark, starts with is, can, did, should, do we, "explain why", "tell me what" and so on, or has a clause that opens like a question ("report status. what can merge", "deployed. why is it slow"). Only what you type counts, at the terminal, through Remote Control or in an SDK host: text inside a paste or code, notifications and messages from other sessions never arm a question. A question you type while Claude is still working waits until Claude reads it, so an answer written before then is never pinned under it; if the turn ends first, it opens the next turn. Questions Claude reads together take its Answer lines in order. A question Claude read but did not answer is dropped when that turn ends.
2. Claude replies with a line starting `**Answer:**`. The plugin pins it with your question the moment Claude writes it, even in the middle of a long turn. It keeps that paragraph up to the first blank line, at most 3 lines, and cuts anything past about 240 characters at a sentence end. Markdown shows as styles: bold, `code` in color, and list items as bullets. Ask Claude to expand on it if you need more.
3. The pane opens, docked beside the chat in fullscreen mode, otherwise above the prompt. Claude Code draws a pane a plugin opens on its own only in a terminal 144 columns or wider, or 110 once you have opened it with `/pins` and not closed it by hand since. In a narrower terminal the row above the prompt still reads `📌 Answer pinned`, and `/pins` shows the pane at any width.
   It is sized to its content, capped at 72 columns by 14 rows, showing the 5 newest answers.
4. To clear answers:
   - press `0` while the prompt is empty: a row above the prompt reads `📌 Answer pinned   0: Dismiss`, like Claude Code's own feedback survey, and clears them all. A `0` typed after other text is ordinary input, and the row steps aside while a survey is showing;
   - or just keep working: the next prompt you write starts a one-minute timer, and the answers already pinned clear when it ends. An answer pinned after that prompt waits for the next one. Nothing clears on time alone.
5. `/pins` reopens the pane.

The plugin keeps the last 20 answers. A reply whose Answer line is `n/a` isn't pinned.

## Getting Claude to write the Answer line

Add one line to your `CLAUDE.md`:

```
When I ask a question, start the reply with `**Answer:** <the answer>` so it gets pinned.
```

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install pinned-answers --marketplace asaphe/claude-pinned-answers
```

Answer `y` to add the marketplace, then pick a scope. Or from a shell:

```
claude plugin install pinned-answers --marketplace asaphe/claude-pinned-answers
```

In the desktop app, click **+** next to the prompt box, choose **Plugins**, then **Add marketplace** and enter `asaphe/claude-pinned-answers`. Then choose **Add plugin**.

## License

Apache-2.0. See [LICENSE](LICENSE).
