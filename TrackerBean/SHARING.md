# Sharing TrackerBean with friends (and updating everyone at once)

The idea: GitHub (free) builds the installer for you and hosts it. Friends download one file, and after that
TrackerBean updates itself whenever you publish a new version. Nobody needs Node.js or any tools.

## One-time setup (about 20 minutes)

1. Make a free account at https://github.com
2. Click the **+** at the top right, then **New repository**. Name it `trackerbean`, choose **Public**, click **Create repository**.
   (It has to be public so your friends' apps can check for updates. The code is visible to anyone, but your games,
   history and journal stay on your own PC.)
3. Unzip the newest `trackerbean.zip` into a **fresh, empty folder**. Do not use your old working folder, it contains a huge
   `node_modules` folder that must not be uploaded.
4. On the new repository page, click **uploading an existing file**. Open the unzipped `trackerbean` folder and drag
   **everything inside it** onto the page (including the `src`, `renderer`, `assets` and `build` folders).
   Click **Commit changes** at the bottom.
5. Check that the repository now shows a `.github` folder. If it doesn't (hidden folders sometimes get skipped),
   click **Add file, then Create new file**, type `.github/workflows/release.yml` as the name (the slashes make the folders),
   paste in the text from the `release.yml` file in your unzipped folder, and click **Commit changes**.
6. Publish your first release: click **Releases** (right side), then **Create a new release**.
   Click **Choose a tag**, type `v1.9.0`, click **Create new tag**. Give it a title like `TrackerBean 1.9.0`
   and click **Publish release**.
7. Click the **Actions** tab. A build starts and takes roughly 10-15 minutes. When it shows a green tick, go back to
   **Releases**. The installer (`TrackerBean Setup 1.9.0.exe`) is attached. Leave the small `latest.yml` file there too:
   the auto-update needs it.

## Giving it to friends

- Send them the link to your **latest release** page. On it they click `TrackerBean Setup ....exe`, run it, and click
  through the installer. A copy of simple instructions for them is in `README-FRIENDS.txt`.
- Windows will warn "Windows protected your PC" because the app isn't signed (signing costs about $100+ a year).
  They click **More info**, then **Run anyway**. This is normal for small apps.
- Some antivirus programs also complain about unsigned apps. It's a false alarm, but friends may need to allow it.
- Each person's games, stats and journal stay on their own computer.

## Every time you have an update

1. Download the new `trackerbean.zip` from our chat and unzip it into a temporary folder.
2. On your repository page: **Add file, then Upload files**, drag everything from the unzipped folder in, and **Commit changes**.
   Files with the same name are replaced.
3. **Releases, then Draft a new release**. Choose a **new** tag with a higher number (for example `v1.9.1`, then `v1.9.2`).
   The tag is the version number. Click **Publish release**.
4. Wait for the green tick under **Actions**. After that, everyone's TrackerBean finds the update on its own (shortly after
   it opens, and every few hours), downloads it, and shows an **Update ready · restart** button in the sidebar.
   Settings also has a **Check for updates** button.

You can also stop using `update.bat` once you install TrackerBean from your own release page: it will update itself too.

## If you don't want to use GitHub

Build the installer yourself (`build.bat`, option 2) and send `dist\TrackerBean Setup ....exe` through Google Drive or similar
(it's too big for Discord without Nitro). Friends install it the same way, but they have to be sent each new version by hand.

## Good to know

- Installing the release version over the one you built yourself is fine: your data is kept.
- A copy built with `build.bat` has no update information, so it can't update itself. Install once from the release page to switch.
- If a build fails (red cross under Actions), open it, copy the last lines of the error and send them to me.
