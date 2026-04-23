# PiNet Quick Start

## 1. Start the relay

```bash
cd pinet && ./dev.sh
```

That's it. It starts the relay, writes `~/.pinet/relay.json`, opens the dashboard.
Keep this terminal open.

Dashboard: **http://localhost:8081** (token shown in terminal)

## 2. Start agents

Open a terminal for each agent:

```bash
mkdir -p alice/.pi/extensions
ln -sf ../../pinet alice/.pi/extensions/pinet
cd alice && pi
```

Then in pi:

```
/pinet Alice@build
```

Repeat for each agent:

```bash
mkdir -p bob/.pi/extensions
ln -sf ../../pinet bob/.pi/extensions/pinet
cd bob && pi
```

```
/pinet Bob@build
```

No wizard needed. No tokens to copy. `relay.json` was already written by `./dev.sh`.

## 3. Talk

In Alice's pi session:

> Send a DM to Bob saying "hello"

Alice's LLM calls `pinet_send`. Bob receives it instantly.

## 4. Watch

Open **http://localhost:8081** — see messages in real time.

## Cleanup

In each pi session: `/pinet off`, then Ctrl+C. Ctrl+C to stop the relay.
