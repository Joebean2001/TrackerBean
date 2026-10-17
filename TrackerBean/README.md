# TrackerBean

A Windows app that tracks how long you play each game. It runs in the system tray, notices when a game starts and stops, and shows your playtime.

## Run it (to test)
1. Install Node.js (LTS) from https://nodejs.org
2. Open a terminal in this folder and run:
   ```
   npm install
   npm start
   ```
3. Go to **Games**, click **Scan for games**, and add the ones you want tracked.
4. Launch a game. Within about 5 seconds it appears under **Now playing**.

## Build the .exe
```
npm run build
```
The installer appears in the `dist` folder (`TrackerBean Setup 1.9.0.exe`). Run it to install.

If the build fails with a "symbolic link" error, turn on **Developer Mode** in Windows settings (or run the terminal as administrator) and try again.

## Where things are
- `main.js`: window, tray icon, settings
- `src/tracker.js`: game detection and sessions
- `src/scanner.js`: finds games in Steam, Epic and GOG folders
- `src/covers.js`: downloads cover art
- `src/sizes.js`: folder sizes and drive space
- `renderer/`: the interface (HTML, CSS, JS)
- Your data is saved in `%APPDATA%\trackerbean\trackerbean.json`

## Tabs
- **Today / Games / Storage**: tracking, library with cover art, and disk space per game
- **Stats**: playtime charts, a 6-month heatmap, when you play, top games and records
- **Journal**: notes with mood and screenshots; "where I left off" notes pop up when you launch that game
- **Goals**: hours, finished games, new games, streaks, custom checkboxes, a backlog countdown and bingo
- **CS2 Matches**: connects to CS2 (Valve's official match-data feature) and saves every match: rounds, kills, damage, economy, sides, with plain-English findings. A match can be turned into a highlight montage from your real kills
- **Montage**: one click turns a session's clips (e.g. from Medal) into a highlight video: it finds the loudest moment in each clip, keeps the best and adds transitions. Choose a TikTok style (cuts on the beat of your music, slow-mo, zoom punches, flashes) or a clean style. You can also pick clips by hand. Needs internet once, to download the video tools during `npm install`
- **Challenge**: pick a starter game and a play-time goal; hit it and the next game unlocks (random or your choice)

## Updating
Download the new `trackerbean.zip`, then double-click `update.bat` in this folder. It unpacks the update, builds it, closes TrackerBean, installs over the old version and restarts it. Your data is kept.
(`update.bat` itself isn't replaced by updates. If it ever changes, copy the new one over by hand.)

## Sharing with friends
See `SHARING.md` (one-time GitHub setup, then friends get one installer and the app updates itself) and `README-FRIENDS.txt` (instructions to hand to friends).

## Montage styles (v1.10)

The automatic montage now has four styles:

- **Phonk**: quick cuts, then a slow-motion payoff on the big moment, beat zoom, shake, RGB glitch, flashes.
- **Hype**: fast cuts on every beat.
- **Cinematic**: longer cuts with slow-mo and gentle motion.
- **Clean**: smooth crossfades (the old clean style).

Other options: vertical 9:16 output (blurred bars or crop-to-fill) or widescreen, an optional caption, and a generated beat when no song is chosen.

**AI vision** (optional): paste an Anthropic API key in the Montage screen. TrackerBean sends small frames from your loudest clips to Claude, which scores them for kills, headshots and big plays, then snaps each pick to the loudest instant nearby. The key is stored encrypted by Windows and never shown to the app window. Without a key it uses sound only.

## Fill the song (v1.11)

In the one-click montage, pick **Clips from: All my <game> clips** (for example Counter-Strike), choose a song, and set **How long** to **Fill the whole song**. TrackerBean uses as many of your best moments as it takes to cover the whole track. Long montages are rendered in pieces and joined, so hundreds of cuts are fine. If there aren't enough exciting moments, you get a shorter montage and a note saying so.

**Game sound** (Auto / Full / Low / Off) controls the in-game audio from your clips under the song.

## Renamed (v1.12)

GameHub is now **TrackerBean**. On first launch it copies your old data (games, sessions, journal, covers, settings) from `%APPDATA%\gamehub` into `%APPDATA%\trackerbean`. The old folder is left alone as a backup. In the CS2 tab, click set up once more so the game's config file gets the new name.

## v1.13: Profile, Friends, GameHub import

- **Profile**: paste a profile link to link one or more Steam accounts. Add your free Steam API key (steamcommunity.com/dev/apikey) so TrackerBean can read playtime. Your Steam *Game details* must be Public for hours to show.
- **Friends**: add friends by Steam profile link or ID, or import your Steam friends list. A leaderboard ranks everyone (including you) by the last 2 weeks or all time, and a click shows their most played games. Friends don't need TrackerBean.
- **Scrollbars** are hidden everywhere (scrolling still works).
- **migrate-gamehub-to-trackerbean.bat** copies GameHub's games and sessions into TrackerBean. Quit both apps first. Safe to run more than once, and TrackerBean's data file is backed up before anything changes.

## v1.14: App icon, main/alt accounts, friend badges

- **Icon**: the bean is now the app icon, tray icon and sidebar logo.
- **Today** has a Steam profile bar at the top: your **main** account big, your alt(s) smaller. Click an alt to swap, or use **Make main** in Profile.
- The main account is the one ranked as "You" on Friends. In Profile you can switch on **Count all my accounts together** to add them up instead.
- **TrackerBean badge** next to friends who also use the app. Needs the one-time lookup service in `REGISTRY-SETUP.md`; until then it stays hidden.

## v1.15.0: Pop-up blocker, Steam hours, shared games, backlog helper, bigger profile photo

- **Pop-up blocker** (Settings, on by default): TrackerBean can no longer open extra windows or get redirected to a website. Web pages can't ask for notifications, location or camera. Switch it off and links open in your normal browser instead.
- **Quiet while gaming** (Settings, off by default): holds TrackerBean notifications until your game closes. Where-you-left-off reminders still show.
- **Steam hours import**: games now start with the hours you already had on Steam (e.g. 220h of CS2) instead of 0. It's imported once per game as Steam's total minus what TrackerBean already counted, then only new sessions are added, so nothing is double counted. Goals, streaks and Stats still use TrackerBean's own sessions only. Needs your Steam API key and public Game details. Use **Sync Steam hours** on the Games tab to pull it in right away.
- **Bigger profile photo** on Today (150px, bigger name).
- **Games you both own** (Friends): open a friend and click **Games you both own** to see what you share, most-played first, with your hours next to theirs. Needs their Game details to be Public.
- **Backlog helper** (Challenge): lists Steam games you own but have never played. Installed ones can start a challenge with one click (or a random pick), **Challenge only unplayed games** leaves everything you've already played out, and uninstalled ones have an Install button (opens Steam).

## v1.15.2: Sign-in button removed, Uninstall

- Removed **Sign in with Steam**. Steam's servers kept answering it with an "Access Denied" page. Link your account by pasting your Steam profile link or ID on the Profile tab instead. Everything else (hours, friends, shared games, badges) works the same.
- **Uninstall** (Settings, at the bottom): closes TrackerBean and opens its uninstaller. A box lets you also delete your data (games, sessions, notes); otherwise it's kept in case you reinstall. It also turns off Start with Windows and takes you off friends' "also has TrackerBean" list.

## v1.15.3: Uninstall button fix

- Fixed the **Uninstall** button in Settings, which did nothing because its name clashed with the per-game uninstall button. Both now work.
