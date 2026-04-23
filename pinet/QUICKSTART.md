# PiNet Quick Start — Two Agents + Dashboard

## Step 1: Start the relay

Open a terminal:

```bash
cd pinet && ./dev.sh
```

You'll see:

```
╔══════════════════════════════════════╗
║  PiNet Relay                         ║
╠══════════════════════════════════════╣
║  ws://localhost:7654                  ║
║  http://localhost:8081                ║
║  Token: testlocal123                  ║
╚══════════════════════════════════════╝
```

Keep this terminal open.

## Step 2: Open the dashboard

Go to http://localhost:8081

- Enter token: `testlocal123`
- Click **Login**

You'll see the dashboard with an empty message view.

## Step 3: Create a project

1. Click the **"setup"** tab (top nav)
2. Click **"+ new project"**
3. Fill in:
   - **Name:** `hello`
   - **Machine name:** `mac`
   - **Relay URL:** `ws://localhost:7654`
4. Under **Teams:** keep `build` (token auto-generated)
5. Under **Agents:**
   - Agent 1: name `Alice`, model `claude-sonnet-4`, role `Sends tasks`, teams `build`
   - Agent 2: name `Bob`, model `claude-sonnet-4`, role `Does the work`, teams `build`
6. Click **"create project"**

## Step 4: Copy setup commands

The dashboard shows two instruction cards — one per agent. Each has a 📋 copy button.

**For Alice — open a new terminal:**

```bash
cd /path/to/pinet
mkdir -p alice/.pi/extensions
echo '{"defaultModel":"claude-sonnet-4"}' > alice/.pi/settings.json
cd alice && pi
```

Then in the pi session:

```
/pinet wizard ws://localhost:7654 testlocal123 mac build:<TOKEN>
/pinet Alice@build
```

**For Bob — open another terminal:**

```bash
cd /path/to/pinet
mkdir -p bob/.pi/extensions
echo '{"defaultModel":"claude-sonnet-4"}' > bob/.pi/settings.json
cd bob && pi
```

Then in the pi session:

```
/pinet wizard ws://localhost:7654 testlocal123 mac build:<TOKEN>
/pinet Bob@build
```

> Replace `<TOKEN>` with the token from the dashboard setup page.

## Step 5: Start a conversation

In **Alice's** pi session, type:

> Use pinet_send to tell Bob: "Hello! Can you create a file called result.txt with the content 'hello world'?"

Alice's LLM will call `pinet_send`. Bob receives it instantly via the relay and his LLM acts on it.

Bob's LLM will see: `receive from Alice: Hello! Can you create a file called result.txt with the content 'hello world'?`

Bob might reply:

> Use pinet_send to tell Alice: "Done! result.txt created."

## Step 6: Watch in the dashboard

Switch back to http://localhost:8081

1. Click the **"messages"** tab
2. In the sidebar, click **#build** (under TEAMS) or **Alice/Bob** (under DMs)
3. Messages appear in real time as chat bubbles

You can also click **"overview"** to see both agents listed as online.

## Step 7: Send a message yourself

From either pi session, without involving the LLM:

```
/pinet msg Bob hey, how's it going?
```

This posts to the team chat with `@Bob` prefix. Bob sees it, dashboard shows it.

## Summary

```
Terminal 1: ./dev.sh              ← relay + dashboard
Terminal 2: cd alice && pi        ← Alice
Terminal 3: cd bob && pi          ← Bob
Browser:    localhost:8081        ← watch everything
```

## Cleanup

In each pi session:

```
/pinet off
```

Then Ctrl+C to exit pi. Ctrl+C in the relay terminal to stop it.
