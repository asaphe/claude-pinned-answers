# pinned-answers

Answers to your questions get lost in long replies and scrollback. This Claude Code plugin keeps the full answer on screen in a pane beside the chat until you say you've seen it.

## How it works

1. You ask something: the prompt contains `?`, or starts with why, what, how, is, can, did, should, and so on.
2. Claude replies with a line starting `**Answer:**`. The plugin pins that paragraph (up to the first blank line, at most 3 lines) with your question; ask Claude to expand on it if you need more.
3. The pane opens:
   - in fullscreen mode at 110 columns or wider, it docks beside the chat;
   - otherwise it sits above the prompt.
   It is sized to its content, capped at 72 columns by 14 rows, showing the 5 newest answers.
4. To clear answers:
   - press **✓ seen** to clear one;
   - type `ack` to clear them all. The message can carry more after `ack`, like `ack, and also …`.
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
