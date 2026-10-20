# Make HAILACHO Chat an installable app

Your chat is now a PWA (Progressive Web App): it has an icon, opens in its own window without the browser bar,
and can be installed on a phone or a PC. Button names on the websites below may change slightly.

## Part 1: Deploy and check

1. Copy the update files into your project, run the tests, then:
   ```
   git add .
   git commit -m "Installable app (PWA)"
   git push
   ```
   Render redeploys by itself. Wait until it says Live.
2. Open your address in Chrome on your PC. After a few seconds an **install icon** appears at the right
   of the address bar. Click it > **Install**. You now have a desktop app.
3. On your phone, open the address in Chrome > menu (3 dots) > **Install app** (or **Add to Home screen**).
   The HAILACHO icon appears with your other apps and opens without the browser bar.
4. If the install option does not appear: press F12 on the PC > **Application** > **Manifest**. Errors are shown there.

## Part 2: Make an Android file (.apk)

This uses PWABuilder (free, no account, nothing to install). It wraps your website in a "Trusted Web Activity".

1. Go to **pwabuilder.com**, paste your address (like https://chat-app-1-x96z.onrender.com) and press **Start**.
2. Open **Package for stores** > **Android**. Suggested settings:
   - **Package ID:** `com.hailu.hailachochat`  (any unique name like this; it can never change later)
   - **App name:** HAILACHO Chat
   - **Version:** 1 (version code 1)
   - **Signing key:** **New** (let PWABuilder create it)
3. **Download Package**. The zip contains the `.apk`, a signing key file, `signing-key-info.txt` (passwords and the
   SHA-256 fingerprint) and `assetlinks.json`.
4. **KEEP the signing key and `signing-key-info.txt` safe, and NEVER put them in GitHub or send them to anyone.**
   You need the same key for every future update of the app.

## Part 3: Tell Android to trust your website (hides the browser bar)

1. Open the `assetlinks.json` from the zip. Copy its whole content.
2. Paste it into `public\.well-known\assetlinks.json` in your project (replace the `[]`).
3. `git add .`, `git commit -m "Android app trust file"`, `git push`. Wait for Render to finish.
4. Open `https://YOUR-ADDRESS/.well-known/assetlinks.json` in a browser. You must see the content.

## Part 4: Install the .apk on your phone

1. Send the `.apk` to your phone (USB cable, Telegram "Saved messages", or Google Drive).
2. Open it on the phone. Android asks to allow **install unknown apps** for that app: allow it, then install.
3. Open HAILACHO Chat. If the browser address bar is **gone**, everything works.
   If a bar is still shown, the trust file is not live yet or is wrong. Check Part 3, then close and reopen the app.

## Things to know

- A free Render instance sleeps after 15 minutes without visitors. The first open can take about a minute.
  For real users, use a paid instance or a small server.
- Installing from a file ("sideloading") is free. Putting the app on Google Play needs a Google developer
  account, which has a one-time fee. Check the current price on Google's website.
- After you change the website, the installed app updates by itself: it just opens your website.
- Chat messages and files are never stored by the app on the phone (the service worker only keeps an offline page).
