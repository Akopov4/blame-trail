# Publishing BlameTrail to the VS Code Marketplace

The manifest is already set up under publisher **`Akop4`**, with `repository`/`bugs`/`homepage` pointing to `https://github.com/Akopov4/blame-trail` — update those URLs first if the repo ends up at a different name or location.

What's left is entirely account-specific — a publisher identity and an access token — which only you can set up, since they're tied to your own Microsoft/Azure DevOps account.

## 1. Publisher

You're already publishing under `Akop4` (confirmed via `npx vsce ls-publishers`), and `package.json` matches — nothing to do here.

## 2. Get a Personal Access Token (PAT)

1. Go to <https://dev.azure.com>, sign in with the same Microsoft account, and open any organization (create one if prompted — it's free and just used for token issuance).
2. Click your profile icon (top right) → **Personal access tokens** → **New Token**.
3. Set:
   - **Organization**: All accessible organizations
   - **Scopes**: Custom defined → **Marketplace** → check **Manage**
4. Copy the generated token somewhere safe — Azure only shows it once.

## 3. Push the code to GitHub

If `https://github.com/Akopov4/blame-trail` doesn't exist yet, create it and push this project there — the Marketplace listing links to it, and the README's screenshots render from it.

## 4. Log in and publish

```bash
npm install
npx vsce login Akop4
# paste the PAT from step 2 when prompted

npm run publish
```

This compiles, packages, and uploads in one step. Your extension will appear on the Marketplace within a few minutes at:
`https://marketplace.visualstudio.com/items?itemName=Akop4.blame-trail`

## Alternative: package only, publish manually

If you'd rather not use the CLI's login flow, you can package locally and upload through the web UI instead:

```bash
npm install
npm run package
```

This produces `blame-trail-1.0.0.vsix`. Then go to <https://marketplace.visualstudio.com/manage>, select your publisher, and use **New extension → Visual Studio Code** to upload the `.vsix` file directly.

## Future updates

Bump `"version"` in `package.json` (Marketplace requires each publish to have a higher version than the last), add an entry to `CHANGELOG.md`, then run `npm run publish` again — or use `npx vsce publish patch`/`minor`/`major` to bump the version automatically as part of publishing.
