# Put HAILACHO Chat online (HTTPS) - Render + MongoDB Atlas

Button names on these websites change from time to time. If a label is slightly different, look for the closest one.

## 0. Before you start (on your computer)

1. All tests pass:  `npx jest --runInBand --forceExit`   (about 92 tests, all green)
2. Tell npm how to start the app (this edits package.json for you):
   ```
   npm pkg set scripts.start="node server.js"
   npm pkg set engines.node=">=20"
   ```
3. Make sure git does not track secrets or heavy folders:
   ```
   git ls-files .env
   git ls-files node_modules | find /c /v ""
   ```
   The first must print nothing. The second must print 0. If not:
   ```
   git rm -r -q --cached node_modules
   git rm -r -q --cached uploads
   ```
4. Save, commit and push:
   ```
   git add .
   git status --short
   git commit -m "Prepare for deployment"
   git push
   ```
   Look at the `git status` list first: `.env` must NOT be in it.

## 1. MongoDB Atlas

1. Atlas > **Network Access** > **Add IP Address** > **Allow access from anywhere** (0.0.0.0/0).
   Free hosting has no fixed IP address, so this is needed. It is safe only because your database
   user has a long password that nobody else knows. Never put that password in GitHub.
2. Atlas > **Database** > **Connect** > **Drivers** and copy the connection string.
   Put the database name before the `?`, like `...mongodb.net/chat-app?retryWrites=true...`.

## 2. Render

1. Create an account at render.com using your GitHub login.
2. **New** > **Web Service** > choose your repository `hailu326/chat-app`.
3. Fill in:
   - **Branch:** main
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance type:** Free (for testing)
4. **Environment Variables** (add each one):

   | Name | Value |
   |---|---|
   | `NODE_ENV` | `production` |
   | `CONN_STRING` | the Atlas connection string with your NEW password |
   | `JWT_SECRET` | a NEW long random text (make it with the node command in `.env.example`) |
   | `MAX_UPLOAD_MB` | `10` |

   Do NOT copy the `JWT_SECRET` from your computer. Use a different one.
5. If there is a **Health Check Path** field, enter `/healthz`.
6. **Create Web Service**. Wait until the log says `Server running on port ...`.
   Then open the address Render shows, like `https://your-name.onrender.com`.

## 3. Test it online

1. Open the address on your computer and sign up. Open it on your phone and sign up with another account.
2. Chat between them. Send a photo and a file. Change a name in Edit profile.
3. Press F12 > **Application** > **Cookies**. The cookie must be named `__Host-chat_session`
   and show **HttpOnly** and **Secure**.
4. Try `http://` instead of `https://`. It must go to https or not open.

## Things to know

- **Free instances go to sleep** after a while without visitors. The first page load can take a minute,
  and open chat connections drop. Fine for testing. For real users use a paid instance or a small server.
- **Updates:** every `git push` to main re-deploys automatically.
- **Do not run NODE_ENV=production on your own computer** with `http://`. Use development there.
- **Old messages that had a file** (sent before this update) will show a missing file online, because
  those files were on your computer's disk. New files are stored inside MongoDB.
- **Atlas free storage is 512 MB.** Photos and files count against it.
