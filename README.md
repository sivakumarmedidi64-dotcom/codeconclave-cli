# CodeConClave CLI

**CodeConClave AI in your terminal.** Chat, make a file, change a file (you see the change and say yes first), and a coding agent that plans first, asks before each change, and can rewind.

Built by Saharsh Medidi, 17, from India. One person, mostly overnight.

> **Just want to try CodeConClave?** It's free in the browser, nothing to install: **https://codeconclave-ww5x.onrender.com**
> It builds websites with real photos, researches with sources, runs 20 ready agents and checks trains and buses in a real browser.

![CodeConClave AI - the hands-on AI](docs/hands-on-ai.png)

## Install

Needs Node 18 or newer.

```bash
npm install -g github:sivakumarmedidi64-dotcom/codeconclave-cli
```

Or straight from the CodeConClave site:

```bash
npm install -g https://codeconclave-ww5x.onrender.com/cli.tgz
```

## Sign in (free)

```bash
codeconclave login
```

A page opens in your browser. Sign in to CodeConClave (free, with Google or GitHub), check that the code matches your terminal, and press **Connect**. The CLI then uses your normal CodeConClave messages, free like the web app. No API key is needed.

Already have a prepaid API key? Use `codeconclave login --key` and paste it instead. `codeconclave logout --everywhere` signs out every terminal at once.

## Use it

```bash
codeconclave                                   # chat (type /help inside)
codeconclave "your question"                   # one answer
codeconclave make snake.html "a snake game with a score"
codeconclave edit app.js "add a dark mode button"
codeconclave explain server.js
git diff | codeconclave "review this change"
```

## The coding agent

```bash
codeconclave do "add a dark mode button"       # it plans first; you OK each change
codeconclave rewind                            # undo the last "do" (rewind 3 = back to before change 3)
codeconclave commands                          # your saved commands from .codeconclave/commands/*.md
```

Put rules for the agent in `CODECONCLAVE.md` (or `AGENTS.md`) in your folder.

## Safe by default

- **Files:** nothing changes until you see the change and say yes. `--yes` skips the question per file, but commands still ask.
- **Undo:** every change from `do` can be rewound.
- **Your sign-in:** it stays on your computer and is sent only to CodeConClave. Only press Connect for a code from your own terminal.

## More

- **Agents, runs and tasks:** the same as the app. Type `codeconclave help` for the full list.
- **Other ways to use CodeConClave:** a VS Code extension, a Windows desktop app and a code editor in the browser, all at [codeconclave-ww5x.onrender.com/cli](https://codeconclave-ww5x.onrender.com/cli).

## License

MIT © 2026 Saharsh Medidi
