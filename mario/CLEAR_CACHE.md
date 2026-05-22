# How to Clear Cache and See Latest Version

If you're seeing an old version of the game, try these steps:

## Safari (iPhone/iPad)
1. **Hard Refresh:** Pull down on the page and hold for 2 seconds
2. **Clear Website Data:**
   - Settings → Safari → Advanced → Website Data
   - Find your site and swipe left to delete
3. **Clear All Safari Data:**
   - Settings → Safari → Clear History and Website Data

## Safari (Desktop)
1. **Hard Refresh:** Hold `Shift + Command + R`
2. **Or:** Safari → Develop → Empty Caches (then reload)
3. **Or:** Safari → Clear History → Choose "all history"

## Brave Browser
1. **Hard Refresh:** `Ctrl + Shift + R` (Windows/Linux) or `Cmd + Shift + R` (Mac)
2. **Clear Cache:**
   - Click the lock icon in the address bar
   - Click "Site settings"
   - Scroll down and click "Clear data"
3. **Or:** Settings → Privacy and Security → Clear browsing data
   - Select "Cached images and files"
   - Time range: "All time"
   - Click "Clear data"

## Chrome
1. **Hard Refresh:** `Ctrl + Shift + R` (Windows/Linux) or `Cmd + Shift + R` (Mac)
2. **Clear Cache:** Settings → Privacy and Security → Clear browsing data

## Firefox
1. **Hard Refresh:** `Ctrl + Shift + R` (Windows/Linux) or `Cmd + Shift + R` (Mac)
2. **Clear Cache:** Options → Privacy & Security → Cookies and Site Data → Clear Data

## Service Worker Issues
If the page still shows old content:

1. Open browser DevTools (F12)
2. Go to Application → Service Workers (Chrome/Brave) or Storage → Service Workers (Firefox)
3. Click "Unregister" next to the service worker
4. Close DevTools
5. Refresh the page

## Latest Changes
The game now has:
- Version 2 cache system
- Network-first caching strategy
- Auto-reload when updates are detected
- Cache-busting query parameters on all assets

After clearing cache once, future updates should happen automatically!
