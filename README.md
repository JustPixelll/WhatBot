# WhatBot

A small WhatsApp group assistant you start on your Windows PC whenever you want it.
Mention its contact in a selected group, or type `!ask your question`, and it replies
using your OpenAI or Claude API account. Close it when you are done.

This is a standalone Node.js app using `whatsapp-web.js`, not an OpenClaw plugin.
It runs directly on Windows; no server, WSL, Docker, public URL, or scheduled task is needed.

> This uses an unofficial WhatsApp Web integration. WhatsApp can restrict or ban
> accounts using unofficial automation, and Web updates can break the integration.
> Use the separate WhatBot number, not your main number. This is a personal experiment.

## 1. Create the WhatBot WhatsApp account

1. Make sure the second number is active and can receive an SMS or verification call.
2. Update the official WhatsApp mobile app.
3. Open WhatsApp **Settings**, then the account switcher next to your name/profile,
   and choose **Add account**. The exact position varies by Android/iPhone version.
   Do **not** use **Change number**, which changes your existing account.
4. Register the second number, select the correct country code, and enter the
   verification code on your phone. Never share the code.
5. Set its profile name to **WhatBot** and its About text to something like
   **AI assistant — replies when mentioned**. Enable two-step verification under
   **Settings > Account > Two-step verification**.
6. Switch back to your personal account, save the second number as **WhatBot**, and
   create a small **WhatBot Test** group containing your personal account and WhatBot.
   If an admin must approve adding a participant, complete that on the phone.

If **Add account** is missing, check for an app update. You can also register the
second number in the official WhatsApp app on a spare phone. Do not replace or log
out of your personal account to make room for the bot.

WhatsApp supports multiple accounts on Android and iOS. Official references:
[account switching](https://faq.whatsapp.com/492167569769444/),
[iOS multiple-account announcement](https://about.fb.com/news/2026/03/whatsapp-new-features-simplify-storage-switch-accounts/).

## 2. Prepare your Windows PC

1. Install **Node.js 24 LTS or newer** from [nodejs.org](https://nodejs.org/).
   Keep the default installation options, including adding Node to PATH.
2. On [this repository](https://github.com/JustPixelll/WhatBot), choose
   **Code > Download ZIP**, then **Extract All**. Put the extracted folder somewhere
   such as `C:\WhatBot`. Run from the extracted folder, not inside the ZIP.
3. Double-click **Start-WhatBot.cmd**. On the first run it installs dependencies and
   downloads the browser used for WhatsApp Web. This may take a few minutes.
4. Choose **1 for OpenAI** or **2 for Claude**. Press Enter for the suggested model,
   or enter a model ID available to your API account.
5. Paste your API key into the local terminal. Nothing is shown while you paste it;
   press Enter. It is saved in `data/config.json`, which Git ignores.
6. Choose whether to include background group messages. **No** is the default.

API access is usage-based and depends on your provider account's permissions and
credit. This app does not use your ChatGPT or Claude chat subscription. Setup does
not call the AI API; your first actual question does.

## 3. Link WhatsApp and select the test group

1. When the terminal shows a QR code, switch your **phone to the WhatBot account**.
2. Open **Linked devices > Link a device**. On Android, Linked devices is normally
   under the three-dot menu; on iPhone it is in Settings. Scan the QR on your PC.
   Do not use the profile-sharing QR scanner. Do not share screenshots of this QR.
3. Wait until the app lists your groups. Enter the number beside **WhatBot Test**.
   You can choose multiple groups with comma-separated numbers. Use **R** to refresh
   if you just created a group.
4. Wait for **WhatBot is ready**.
5. From your **personal WhatsApp account**, type `@`, select **WhatBot** from the
   participant picker, and send a question such as `Hello! Explain what you can do.`
   The fallback `!ask tell me a terrible food pun` also works.

Typing plain `@WhatBot` without selecting the participant is not a reliable native
mention. The bot does not answer messages sent from its own WhatBot account.

The saved WhatsApp login usually survives restarts. WhatsApp may require you to
scan a new QR after an unlink or session expiry. Keep the phone account active;
[WhatsApp says to log in on the primary phone every 14 days](https://faq.whatsapp.com/1324084875126592/)
to keep linked devices connected.

## Everyday use

| Task | Action |
| --- | --- |
| Start | Double-click `Start-WhatBot.cmd` |
| Stop | Press **Ctrl+C** in its window; confirm termination if Windows asks |
| Change provider, model, or key | Stop the bot, then run `Configure-WhatBot.cmd` |
| Change allowed groups | Stop the bot, then run `Choose-Groups.cmd` |
| Check local settings without connecting | Run `npm run check` in the project folder |
| Ask a question | Native @mention or `!ask your question` |
| Show help | Native @mention followed by `help`, or `!ask help` |
| Show status | Native @mention followed by `status`, or `!ask status` |
| Clear this group's shared AI context | Native @mention followed by `reset`, or `!ask reset` |

Leave the PC awake, online, and the window open while using WhatBot. It installs no
startup task or background service. After stopping it, there are no bot replies or
new AI calls. An AI request already submitted may still be billed when you stop.
Messages sent before the bot becomes ready are ignored, not answered on the next run.

## What the first version does

- Text questions and answers, in English, German, or the language you use.
- Native WhatsApp mentions, with a `!ask` fallback.
- Replies only in explicitly selected groups; direct messages are ignored.
- Separate, shared AI context for each group, retaining up to 12 conversation
  messages (normally six questions and six answers) while running.
- Optional context from up to 20 recent untagged text messages received while
  running. Those messages go to the AI only with the next question in that group.
- One request at a time per group, a five-second cooldown after each reply, and
  at most 100 AI requests per run across all groups. Requests during a busy period
  or cooldown are ignored; send again after the current reply and a short pause.
- Replies capped at 3,500 characters. AI output is also token-limited.

Everyone in an enabled group can ask questions and clear the group's AI context.
The 100-request cap is **not a euro budget**; failed requests count, and restarting
resets the cap. Use your provider's usage controls as appropriate.

This version has no web search, image or voice understanding, company-file access,
or computer control. Attachments and captions are ignored. A reply to an earlier
message does not include the quoted text automatically; paste the relevant text
into your question. It cannot summarize messages it has not received, and cannot
summarize untagged chat unless you enable background context.

## Privacy and local files

Tell group members that WhatBot sends addressed questions and enabled context to
the selected AI provider. Its context is shared within that group; do not treat a
group interaction as a private chat with the bot.

- `data/config.json`: settings, selected group IDs, and your API key **in plaintext**.
  Keep the folder on a trusted Windows account. It is not encrypted by this app.
- `data/whatsapp/`: the WhatsApp login/browser profile. It can contain cached WhatsApp
  messages and other browser data. Treat the whole directory as sensitive.
- `data/web-cache/`: cached WhatsApp Web files.
- Bot-managed AI context lives only in RAM and clears on stop or `reset`. Reset does
  not erase WhatsApp's browser cache, WhatsApp messages, or provider records.
- The OpenAI request uses `store: false`; that is not a promise of zero provider
  retention. Your provider's data policies and account settings still apply.
- The bot does not deliberately log question/answer bodies or API keys. Group names
  appear during selection; the login QR appears during pairing.

`data/`, session directories, `.env` files, and logs are excluded by `.gitignore`.
Do not upload the entire project folder after running it, or force-add ignored files.
To unlink permanently, remove the linked device in the **WhatBot phone account**,
stop the app, and remove its local `data/whatsapp/` directory.

## Troubleshooting

| Symptom | Try this |
| --- | --- |
| Node is not found | Install Node 24+ and reopen the launcher. |
| Browser download fails | Check internet/proxy/antivirus download rules, then run `npm ci`. Do not skip the browser download on your PC. |
| QR is too large or garbled | Maximize the terminal and reduce its font size with Ctrl+mouse wheel; wait for a fresh QR. |
| Login stuck or session expired | Stop WhatBot, unlink its device on the phone, rename `data/whatsapp/` as a local backup, then start and pair again. |
| Browser profile already in use | Stop the other WhatBot window. Run only one copy at a time. |
| Test group missing | Add the bot's second number to the group, then press R in group selection. |
| No reply | Check that the group is selected, use your personal account and a real mention or `!ask`, then wait out the cooldown. Only new text messages are processed. |
| HTTP 401 | Correct the API key with Configure-WhatBot.cmd. |
| HTTP 403/404 | Use a model your API account can access. |
| HTTP 429 | Check provider credit, quota, and rate limits. |
| Model returns no text | Try another text model or increase `maxOutputTokens` in local config. Some reasoning models need a larger token budget. |
| WhatBot disconnects | Restart the launcher; pair again if requested. |

If the WhatsApp Web library breaks after a WhatsApp update, update the dependency
deliberately and retest. Do not run random fixes or install unverified packages.

## Development and verification

```sh
npm ci
npm test
npm start
```

To run tests without downloading Chromium (for CI only):

```sh
PUPPETEER_SKIP_DOWNLOAD=true npm ci
npm test
```

Tests use fake messages and mocked AI responses; no credentials or WhatsApp sending
are required. They cover routing, mention detection, privacy defaults, group context
isolation, old/duplicate messages, rate and usage limits, aborts, and provider payloads.
GitHub Actions runs the suite on Windows and Linux.

Puppeteer is pinned to 25.16.0 via an npm override because the WhatsApp library's
default 24.38.0 dependency tree had reported advisories. Node 24 supports the
CommonJS-to-ESM interop this newer browser package needs. Recheck both dependency
compatibility and `npm audit` when updating either package.

A live phone pairing and end-to-end reply must be checked on the deployment PC.
After pairing, verify one ordinary message stays unanswered, one mention gets one
reply, stop prevents further replies, and restart preserves login without replaying
old questions. Then select the real group using Choose-Groups.cmd.

Implementation references: [whatsapp-web.js](https://wwebjs.dev/guide/),
[local authentication](https://wwebjs.dev/guide/creating-your-bot/authentication.html),
[OpenAI text generation](https://developers.openai.com/api/docs/guides/text),
[Claude Messages API](https://platform.claude.com/docs/en/api/messages/create).
