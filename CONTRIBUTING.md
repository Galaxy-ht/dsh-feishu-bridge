# Contributing

Thanks for taking a look. This repo ships two DSH plugins; both run inside the local Harness, so most work is plain JavaScript with no build step.

## Layout

```
packages/dsh-feishu-card   Host plugin: cards, approvals, questions, session chats
packages/dsh-feishu-panel  Settings page: config, login (device flow), status
docs/                      Design notes
```

## Local loop

1. Install both packages into a test DSH profile (**Plugins → Add plugin**), restart once.
2. Edit `packages/dsh-feishu-card/lib/*.js` → **restart DSH** (the plugin is loaded through the ESM cache; a file edit alone does not re-run it).
3. Edit `packages/dsh-feishu-panel/*.js` → toggle the bundle off/on in **Plugins** to remount, no restart needed.

```powershell
npm run check        # syntax-only, no DSH required
```

## Rules of thumb

- **Never** call the model from these plugins; everything renders from local session events.
- CardKit writes must hold a strictly increasing `sequence` per card — route them through the existing serialization helpers instead of calling the API directly.
- Any approval/question change must keep the plain-text fallback working.
- Keep Chinese UI copy localized in `packages/dsh-feishu-panel/client.js` alongside English.

## Before opening a PR

- `npm run check` passes;
- no credentials, chat ids, open ids or personal paths in the diff;
- describe what you verified in Feishu (which card, which button) and what you could not.
